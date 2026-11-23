import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, type ModuleFile, type SymbolNode } from '@clewmap/core';
import {
  buildGraph,
  carryOverSummaries,
  indexProject,
  scanFiles,
  statementsForRange,
} from './index.js';
import { eventMatches, httpMatches, normalizeRoutePath } from './links.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

async function index(root: string): Promise<Map<string, SymbolNode>> {
  const config = parseConfig({});
  const modules = await indexProject(root, await scanFiles(root, config), config);
  const map = new Map<string, SymbolNode>();
  for (const m of modules) for (const s of m.symbols) map.set(s.id, s);
  return map;
}

function targets(s: SymbolNode | undefined): string[] {
  return (s?.calls ?? []).map((e) => e.target);
}

describe('python adapter (py-bot)', () => {
  let symbols: Map<string, SymbolNode>;
  beforeAll(async () => {
    symbols = await index(path.join(FIXTURES, 'py-bot'));
  });

  it('extracts functions, classes, methods and variables', () => {
    expect(symbols.get('src/bot/handlers/order.py#create_order')?.kind).toBe('function');
    expect(symbols.get('src/db/orders_repo.py#Order')?.kind).toBe('class');
    expect(symbols.get('src/db/orders_repo.py#Order.total_label')?.kind).toBe('method');
    expect(symbols.get('src/bot/texts.py#PAY')?.kind).toBe('variable');
    expect(symbols.get('src/services/pricing.py#apply_promo')?.signature).toBe(
      'apply_promo(total, promo)',
    );
  });

  it('resolves calls through from-imports and module imports', () => {
    const t = targets(symbols.get('src/bot/handlers/order.py#create_order'));
    expect(t).toEqual(
      expect.arrayContaining([
        'src/services/pricing.py#calc_total',
        'src/services/pricing.py#apply_promo',
        'src/db/orders_repo.py#save',
        'src/services/payments.py#create_link',
      ]),
    );
    // texts.PAY.format() — метод строки, не вызов символа
    expect(t.some((x) => x.includes('texts'))).toBe(false);
    expect(targets(symbols.get('src/services/pricing.py#apply_promo'))).toEqual([
      'src/db/promo_repo.py#get',
      'src/services/pricing.py#is_expired',
    ]);
  });

  it('marks external SDK calls unresolved and puts the caller in the external layer', () => {
    const link = symbols.get('src/services/payments.py#create_link')!;
    expect(link.calls).toEqual([
      { target: 'external:httpx.AsyncClient', line: 8, resolved: false, kind: 'call' },
    ]);
    expect(link.layer).toBe('external');
    expect(symbols.get('src/services/pricing.py#apply_promo')?.layer).toBe('service');
    expect(symbols.get('src/db/orders_repo.py#save')?.layer).toBe('data');
  });

  it('finds entry points: FastAPI routes and aiogram callbacks', () => {
    expect(symbols.get('src/api/checkout.py#api_checkout')?.entry).toEqual({
      kind: 'http-route',
      key: 'POST /api/checkout',
    });
    expect(symbols.get('src/api/checkout.py#api_get_order')?.entry?.key).toBe(
      'GET /api/orders/{order_id}',
    );
    expect(symbols.get('src/bot/handlers/order.py#on_checkout_click')?.entry).toEqual({
      kind: 'bot-callback',
      key: 'callback:checkout',
    });
  });

  it('links a bot button to its callback handler', () => {
    const kb = symbols.get('src/bot/handlers/catalog.py#checkout_keyboard')!;
    expect(kb.calls).toContainEqual({
      target: 'src/bot/handlers/order.py#on_checkout_click',
      line: 7,
      resolved: true,
      kind: 'event',
      via: 'callback:checkout',
    });
  });
});

describe('typescript adapter (ts-app)', () => {
  let symbols: Map<string, SymbolNode>;
  beforeAll(async () => {
    symbols = await index(path.join(FIXTURES, 'ts-app'));
  });

  it('extracts classes, methods, arrow functions and default exports', () => {
    expect(symbols.get('src/cart/Cart.ts#Cart')?.kind).toBe('class');
    expect(symbols.get('src/cart/Cart.ts#Cart.total')?.kind).toBe('method');
    expect(symbols.get('src/utils/format.ts#formatPrice')?.kind).toBe('function');
    expect(symbols.get('src/api/client.ts#getOrder')?.kind).toBe('function');
    expect(symbols.get('src/components/CheckoutButton.tsx#CheckoutButton')?.kind).toBe('function');
    expect(symbols.get('src/cart/Cart.ts#cart')?.kind).toBe('variable');
  });

  it('resolves tsconfig path aliases, relative imports, this and instances', () => {
    expect(targets(symbols.get('src/components/CheckoutButton.tsx#CheckoutButton'))).toEqual([
      'src/api/client.ts#checkout',
      'src/utils/format.ts#pluralize',
      'src/cart/Cart.ts#Cart.label',
    ]);
    expect(targets(symbols.get('src/cart/Cart.ts#Cart.label'))).toEqual([
      'src/utils/format.ts#formatPrice',
      'src/cart/Cart.ts#Cart.total',
    ]);
    expect(targets(symbols.get('src/pages/Account.tsx#Account'))).toContain(
      'src/api/client.ts#getOrder',
    );
    expect(targets(symbols.get('src/pages/Account.tsx#Account'))).toContain(
      'external:react.useState',
    );
  });

  it('keeps http calls unresolved when the backend is not in the scanned root', () => {
    expect(symbols.get('src/api/client.ts#checkout')?.calls).toEqual([
      {
        target: 'external:fetch',
        line: 8,
        resolved: false,
        kind: 'http',
        via: 'POST /api/checkout',
      },
    ]);
  });
});

describe('cross-project links (fixtures root)', () => {
  let symbols: Map<string, SymbolNode>;
  beforeAll(async () => {
    symbols = await index(FIXTURES);
  });

  it('connects the frontend checkout to the FastAPI handler', () => {
    expect(symbols.get('ts-app/src/api/client.ts#checkout')?.calls).toEqual([
      {
        target: 'py-bot/src/api/checkout.py#api_checkout',
        line: 8,
        resolved: true,
        kind: 'http',
        via: 'POST /api/checkout',
      },
    ]);
    expect(symbols.get('ts-app/src/api/client.ts#getOrder')?.calls[0]).toMatchObject({
      target: 'py-bot/src/api/checkout.py#api_get_order',
      kind: 'http',
      via: 'GET /api/orders/${id}',
    });
    // Кнопка → checkout() → POST /api/checkout → api_checkout → apply_promo
    expect(
      targets(symbols.get('ts-app/src/components/CheckoutButton.tsx#CheckoutButton')),
    ).toContain('ts-app/src/api/client.ts#checkout');
  });
});

describe('route matching', () => {
  it('normalizes path parameters of every flavour', () => {
    for (const p of [
      '/api/orders/{order_id}',
      '/api/orders/${id}',
      '/api/orders/:id',
      '/api/orders/[id]',
      '/api/orders/:id?tab=1',
    ]) {
      expect(normalizeRoutePath(p)).toBe('/api/orders/{}');
    }
    expect(normalizeRoutePath('${API_URL}/api/checkout/')).toBe('/api/checkout');
  });

  it('matches method and path, with optional api prefix', () => {
    expect(httpMatches({ method: 'POST', path: '/api/checkout' }, 'POST /api/checkout', null)).toBe(
      true,
    );
    expect(httpMatches({ method: 'GET', path: '/api/checkout' }, 'POST /api/checkout', null)).toBe(
      false,
    );
    expect(
      httpMatches({ method: 'GET', path: '/api/orders/${id}' }, 'GET /orders/{id}', '/api'),
    ).toBe(true);
    expect(httpMatches({ method: 'DELETE', path: '/x' }, 'ANY /x', null)).toBe(true);
  });

  it('matches callbacks exactly or by handler regex', () => {
    expect(eventMatches('callback:checkout', 'callback:checkout')).toBe(true);
    expect(eventMatches('callback:checkout', 'callback:^checkout$')).toBe(true);
    expect(eventMatches('callback:order_12', 'callback:^order_\\d+$')).toBe(true);
    expect(eventMatches('callback:checkout', 'command:/checkout')).toBe(false);
  });
});

describe('statements', () => {
  it('lists top-level statements of a function body, skipping the docstring', async () => {
    const order = await readFile(path.join(FIXTURES, 'py-bot/src/bot/handlers/order.py'), 'utf8');
    const stmts = await statementsForRange(order, 'python', 'python', {
      start: [4, 0],
      end: [12, 16],
    });
    expect(stmts.map((s) => s.type)).toEqual([
      'expression_statement',
      'expression_statement',
      'expression_statement',
      'expression_statement',
      'expression_statement',
      'if_statement',
      'return_statement',
    ]);
    expect(stmts[5]!.range.start[0]).toBe(10);
    const pricing = await readFile(path.join(FIXTURES, 'py-bot/src/services/pricing.py'), 'utf8');
    const calc = await statementsForRange(pricing, 'python', 'python', {
      start: [5, 0],
      end: [7, 0],
    });
    expect(calc.map((s) => s.type)).toEqual(['return_statement']);
  });
});

describe('buildGraph', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-build-'));
    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function snapshot(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.set(path.relative(root, p), await readFile(p, 'utf8'));
      }
    }
    await walk(path.join(root, '.clewmap'));
    return out;
  }

  it('writes one json per source file and is byte-stable on rebuild', async () => {
    const first = await buildGraph(root);
    expect(first.files).toBe(8);
    const order = JSON.parse(
      await readFile(path.join(root, '.clewmap/modules/src/bot/handlers/order.py.json'), 'utf8'),
    ) as ModuleFile;
    const create = order.symbols.find((s) => s.name === 'create_order')!;
    expect(create.calls.map((c) => c.target)).toContain('src/services/pricing.py#apply_promo');
    const before = await snapshot();
    const second = await buildGraph(root);
    expect(second.written).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('removes module files of deleted sources', async () => {
    await rm(path.join(root, 'src/db/promo_repo.py'));
    const stats = await buildGraph(root);
    expect(stats.deleted).toBe(1);
    const snap = await snapshot();
    expect([...snap.keys()].some((k) => k.includes('promo_repo'))).toBe(false);
    await writeFile(
      path.join(root, 'src/db/promo_repo.py'),
      '_PROMOS = {}\n\n\ndef get(code):\n    return _PROMOS.get(code.upper())\n',
    );
  });
});

describe('carryOverSummaries', () => {
  it('keeps a summary only while bodyHash is unchanged', () => {
    const summary = { text: 'x', forBodyHash: 'h1', stale: false, model: 'm', createdAt: 't' };
    const base: SymbolNode = {
      id: 'a.py#f',
      kind: 'function',
      name: 'f',
      range: { start: [0, 0], end: [1, 0] },
      signature: 'f()',
      signatureHash: 's',
      bodyHash: 'h1',
      layer: null,
      calls: [],
      summary: null,
      blocks: null,
    };
    const mod = (s: SymbolNode): ModuleFile => ({
      file: 'a.py',
      language: 'python',
      fileHash: 'f',
      layer: null,
      summary: null,
      symbols: [s],
    });
    const prev = mod({ ...base, summary });
    expect(carryOverSummaries(mod(base), prev).symbols[0]!.summary).toEqual(summary);
    expect(
      carryOverSummaries(mod({ ...base, bodyHash: 'h2' }), prev).symbols[0]!.summary,
    ).toBeNull();
  });
});
