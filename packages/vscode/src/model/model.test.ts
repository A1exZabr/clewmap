import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphIndex, readConfig, readGraph, type ModuleFile } from '@clewmap/core';
import { buildGraph } from '@clewmap/indexer';
import { blockSpans, changedLines, lineLayers } from './decorations.js';
import { explainContext } from './explain.js';
import { buildFlow } from './flow.js';
import { callUnderCursor, displayName, layersOf, linkOnLine, plainT } from './graph.js';
import { blockHover, symbolHover, type LastCommit } from './hover.js';
import { changesBetween, impactView } from './impact.js';
import { lensParts } from './lens.js';
import { exactModel, locateInText, nameLine, type DocModel } from './locate.js';
import { searchGraph } from './search.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const ORDER = 'src/bot/handlers/order.py';
const PRICING = 'src/services/pricing.py';
const id = (file: string, name: string) => `${file}#${name}`;

let root: string;
let index: GraphIndex;
let layers: ReturnType<typeof layersOf>;
let modules: Map<string, ModuleFile>;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-vscode-'));
  await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
  await buildGraph(root);
  const g = await readGraph(root);
  // Описания и блоки как после summarize, чтобы проверить их показ.
  for (const m of g.modules)
    for (const s of m.symbols) {
      if (s.kind === 'variable') continue;
      s.summary = {
        text: `${s.name} does its job, described in plain words so that the line above the function has enough text to be cut nicely.`,
        forBodyHash: s.bodyHash,
        stale: s.name === 'preview_cart',
        model: 'test',
        createdAt: '2026-11-24T00:00:00.000Z',
      };
    }
  const order = g.modules.find((m) => m.file === ORDER)!;
  const create = order.symbols.find((s) => s.name === 'create_order')!;
  create.blocks = [
    {
      range: { start: [5, 4], end: [6, 40] },
      statements: [0, 1],
      label: 'totals the cart',
      text: 'Sums and applies the promo.',
      forBodyHash: create.bodyHash,
    },
    {
      range: { start: [7, 4], end: [12, 16] },
      statements: [2, 6],
      label: 'saves and pays',
      text: null,
      forBodyHash: create.bodyHash,
    },
  ];
  modules = new Map(g.modules.map((m) => [m.file, m]));
  index = new GraphIndex(g.modules);
  layers = layersOf(await readConfig(root));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const source = (file: string) => readFile(path.join(root, file), 'utf8');

describe('locate', () => {
  it('takes positions straight from the graph when the text is the same', async () => {
    const m = await locateInText(modules.get(ORDER)!, await source(ORDER));
    expect(m.exact).toBe(true);
    expect(m.stale).toBe(false);
    expect(m.symbols.map((s) => s.node.name)).toEqual([
      'create_order',
      'on_checkout_click',
      'retry_pay',
    ]);
  });

  it('follows functions that moved down and spots the one whose body changed', async () => {
    const text = (await source(PRICING))
      .replace('from datetime import datetime', 'from datetime import datetime\n\n# a\n# b')
      .replace('return max(total - found.amount, 0)', 'return max(total - found.amount, 5)');
    const m = await locateInText(modules.get(PRICING)!, text);
    expect(m.exact).toBe(false);
    expect(m.stale).toBe(true);
    const byName = new Map(m.symbols.map((s) => [s.node.name, s]));
    expect(byName.get('calc_total')!.delta).toBe(3);
    expect(byName.get('calc_total')!.fresh).toBe(true);
    expect(byName.get('apply_promo')!.fresh).toBe(false);
    expect(byName.get('apply_promo')!.range.start[0]).toBe(18);
  });

  it('finds the line with the name below decorators', async () => {
    const api = 'src/api/checkout.py';
    const m = exactModel(modules.get(api)!);
    const sym = m.symbols.find((s) => s.node.name === 'api_checkout')!;
    const lines = (await source(api)).split('\n');
    expect(lines[nameLine(sym, lines)]).toContain('def api_checkout');
  });
});

describe('lens and hover', () => {
  let order: DocModel;
  beforeAll(() => {
    order = exactModel(modules.get(ORDER)!);
  });

  it('builds the line above create_order', () => {
    const sym = order.symbols.find((s) => s.node.name === 'create_order')!;
    const p = lensParts(sym, index, layers, plainT);
    expect(p.summary.title.length).toBeLessThanOrEqual(90);
    expect(p.summary.title.endsWith('…')).toBe(true);
    expect(p.summary.tooltip).toContain('create_order does its job');
    expect(p.callers).toEqual({ title: 'callers: 1', count: 1 });
    // handler → сервис, данные, внешний API
    expect(p.goesTo!.title).toBe('reaches: Service, Data, External API');
    expect(p.goesTo!.tooltip).toBe(
      'pricing.calc_total, pricing.apply_promo, orders_repo.save, payments.create_link',
    );
  });

  it('marks outdated summaries and missing ones', () => {
    const preview = exactModel(modules.get('src/bot/handlers/catalog.py')!).symbols.find(
      (s) => s.node.name === 'preview_cart',
    )!;
    expect(lensParts(preview, index, layers, plainT).summary.title).toMatch(/· outdated$/);
    const noSummary = { ...preview, node: { ...preview.node, summary: null } };
    expect(lensParts(noSummary, index, layers, plainT).summary.title).toBe(
      'summary is not ready yet',
    );
  });

  it('shows links across the boundary on both sides', () => {
    const click = exactModel(modules.get(ORDER)!).symbols.find(
      (s) => s.node.name === 'on_checkout_click',
    )!;
    const lens = lensParts(click, index, layers, plainT);
    expect(lens.links.map((l) => l.title)).toEqual(['← button catalog.py:8 · callback:checkout']);
    const kb = exactModel(modules.get('src/bot/handlers/catalog.py')!);
    expect(linkOnLine(kb, 7)!.edge.target).toBe(id(ORDER, 'on_checkout_click'));
  });

  it('finds the call under the cursor and describes it without a model', () => {
    const hit = callUnderCursor(order, 6, 'apply_promo')!;
    expect(hit.edge.target).toBe(id(PRICING, 'apply_promo'));
    expect(callUnderCursor(order, 6, 'calc_total')).toBeNull();

    const last: LastCommit = {
      sha: 'a3f9c1e',
      subject: 'promo limit',
      changed: new Map([[id(PRICING, 'apply_promo'), 'body']]),
    };
    const t0 = performance.now();
    const md = symbolHover(hit.edge.target, index, layers, plainT, {
      contextFile: ORDER,
      lastCommit: last,
    })!;
    expect(performance.now() - t0).toBeLessThan(20);
    expect(md).toContain('`apply_promo(total, promo)`');
    expect(md).toContain('background-color:#F2A65A');
    expect(md).toContain('pricing.py:16');
    expect(md).toMatch(/\*\*Calls:\*\* \[`promo_repo.get`\]/);
    expect(md).toContain('`is_expired`');
    expect(md).toMatch(
      /\*\*Called by:\*\* .*`api_checkout`.*`preview_cart`.*`create_order`|\*\*Called by:\*\*/,
    );
    expect(md).toContain('Changed in the last commit a3f9c1e: promo limit');
    expect(md).toContain('command:clewmap.explainDeeper?');
  });

  it('describes a block on hover', () => {
    const create = order.symbols.find((s) => s.node.name === 'create_order')!;
    expect(blockHover('create_order', create.node.blocks![0]!, 0, 2)).toContain(
      '**① totals the cart**',
    );
  });
});

describe('decorations', () => {
  it('colors call lines by the layer of the callee', () => {
    const l = lineLayers(exactModel(modules.get(ORDER)!), index);
    expect(l.get(5)).toBe('service');
    expect(l.get(6)).toBe('service');
    expect(l.get(7)).toBe('data');
    expect(l.get(8)).toBe('external');
    expect(l.get(19)).toBe('handler');
  });

  it('skips stripes and blocks of edited functions', async () => {
    const text = (await source(ORDER)).replace(
      'order = await orders_repo.save(cart, total)',
      'order = await orders_repo.save(cart, total)\n    order = order',
    );
    const m = await locateInText(modules.get(ORDER)!, text);
    const l = lineLayers(m, index);
    expect(l.has(5)).toBe(false);
    expect([...l.keys()].some((line) => line > 19)).toBe(true);
    expect(blockSpans(m)).toHaveLength(0);
    expect(
      blockSpans(exactModel(modules.get(ORDER)!)).map((b) => [b.startLine, b.endLine]),
    ).toEqual([
      [5, 6],
      [7, 12],
    ]);
  });

  it('marks lines touched by the last commit', () => {
    const last: LastCommit = {
      sha: 'x',
      subject: '',
      changed: new Map([[id(PRICING, 'apply_promo'), 'body']]),
    };
    const lines = changedLines(exactModel(modules.get(ORDER)!), last, (s) => s.range.start[0]);
    expect([...lines]).toEqual([6]);
  });
});

describe('flow, search, impact, explain', () => {
  it('walks up to the bot button and down to data and the payment API', () => {
    const f = buildFlow(index, id(ORDER, 'create_order'));
    const names = f.steps.map((s) => displayName(s.id, index));
    expect(names.slice(0, f.current + 1)).toEqual([
      'checkout_keyboard',
      'on_checkout_click',
      'create_order',
    ]);
    expect(f.steps[1]).toMatchObject({ kind: 'event', via: 'callback:checkout' });
    expect(names.slice(f.current + 1)).toEqual([
      'pricing.calc_total',
      'pricing.apply_promo',
      'promo_repo.get',
      'pricing.is_expired',
      'orders_repo.save',
      'orders_repo.Order',
      'payments.create_link',
    ]);
  });

  it('searches names fuzzily and summaries by word starts', () => {
    expect(searchGraph(index, 'crord')[0]!.id).toBe(id(ORDER, 'create_order'));
    expect(searchGraph(index, 'apply')[0]!.id).toBe(id(PRICING, 'apply_promo'));
    const bySummary = searchGraph(index, 'plain wor');
    expect(bySummary.length).toBeGreaterThan(5);
    expect(bySummary.every((h) => h.bySummary)).toBe(true);
  });

  it('lists what the last commit changed and who is affected', () => {
    const before = structuredClone(modules.get(PRICING)!);
    const after = structuredClone(before);
    after.symbols.find((s) => s.name === 'apply_promo')!.bodyHash = 'changed';
    const changed = changesBetween([{ before, after }]);
    expect([...changed]).toEqual([[id(PRICING, 'apply_promo'), 'body']]);
    const view = impactView(index, { sha: 'abc', subject: 's', changed });
    expect(
      view.affected
        .filter((a) => a.depth === 1)
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      [
        id('src/api/checkout.py', 'api_checkout'),
        id('src/bot/handlers/catalog.py', 'preview_cart'),
        id(ORDER, 'create_order'),
      ].sort(),
    );
    expect(
      view.affected.some((a) => a.id === id(ORDER, 'on_checkout_click') && a.depth === 2),
    ).toBe(true);
    expect(view.stale).toEqual([id('src/bot/handlers/catalog.py', 'preview_cart')]);
  });

  it('gives the model a narrow context: code, neighbours two steps away, blocks', () => {
    const ctx = explainContext(
      index,
      id(ORDER, 'create_order'),
      'async def create_order(...): ...',
    )!;
    expect(ctx.neighbors.find((n) => n.name === 'apply_promo')).toMatchObject({
      relation: 'calls',
      depth: 1,
    });
    expect(ctx.neighbors.find((n) => n.name === 'is_expired')).toMatchObject({
      relation: 'calls',
      depth: 2,
    });
    expect(ctx.neighbors.find((n) => n.name === 'checkout_keyboard')).toMatchObject({
      relation: 'calledBy',
      depth: 2,
      via: 'callback:checkout',
    });
    expect(ctx.blocks).toHaveLength(2);
  });
});
