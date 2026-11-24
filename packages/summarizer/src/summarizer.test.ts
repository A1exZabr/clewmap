import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphIndex, readGraph, readModule, readQueue, type ModuleFile } from '@clewmap/core';
import { buildGraph } from '@clewmap/indexer';
import {
  acquireLock,
  bottomUpOrder,
  buildPrompt,
  isStale,
  makeBatches,
  parseResponse,
  summarize,
  validateBlocks,
  type SummaryProvider,
  type SummaryRequest,
  type SummaryResult,
} from './index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const ORDER = 'src/bot/handlers/order.py';

/** Фейковый провайдер: описание из имени, блоки — пополам. Может падать на заданных вызовах. */
class FakeProvider implements SummaryProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  readonly batches: string[][] = [];
  calls = 0;
  constructor(
    private readonly failOn: (call: number, batch: readonly SummaryRequest[]) => boolean = () =>
      false,
  ) {}
  async summarize(batch: readonly SummaryRequest[]): Promise<SummaryResult[]> {
    this.calls++;
    if (this.failOn(this.calls, batch)) throw new Error(`boom #${this.calls}`);
    this.batches.push(batch.map((r) => r.id));
    return batch.map((r) => {
      const res: SummaryResult = {
        id: r.id,
        summary: `${r.name}: ${r.callees.map((c) => c.summary ?? '?').join('|')}`,
      };
      if (r.statements) {
        const n = r.statements.length;
        const mid = Math.floor(n / 2) - 1;
        res.blocks = [
          { from: 0, to: mid, label: 'first half', text: null },
          { from: mid + 1, to: n - 1, label: 'second half', text: 'rest' },
        ];
      }
      return res;
    });
  }
}

function req(id: string, statements: number | null = null): SummaryRequest {
  return {
    id,
    name: id.split('#')[1]!,
    kind: 'function',
    file: id.split('#')[0]!,
    language: 'python',
    layer: null,
    signature: 'f()',
    code: 'def f(): pass',
    bodyHash: 'b',
    callees: [],
    statements:
      statements === null
        ? null
        : Array.from({ length: statements }, (_, i) => ({ index: i, line: i, text: `s${i}` })),
  };
}

describe('prompt', () => {
  it('asks for blocks only when statements are given and names the language', () => {
    const p = buildPrompt([req('a.py#f', 4)], 'ru');
    expect(p).toContain('Russian');
    expect(p).toContain('"blocks"');
    expect(p).toContain('[3] line 4: s3');
    expect(buildPrompt([req('a.py#f')], 'en')).not.toContain('"blocks"');
  });

  it('parses fenced JSON, drops unknown ids and invalid blocks but keeps the summary', () => {
    const text =
      'Sure:\n```json\n[{"id":"a.py#f","summary":"Does f.","blocks":[{"from":0,"to":0,"label":"x"},{"from":2,"to":3,"label":"y"}]},' +
      '{"id":"zzz","summary":"nope"}]\n```';
    expect(parseResponse(text, [req('a.py#f', 4)])).toEqual([
      { id: 'a.py#f', summary: 'Does f.', blocks: null },
    ]);
  });

  it('validates blocks: consecutive, full cover, 2–7 of them', () => {
    const b = (from: number, to: number) => ({ from, to, label: 'l' });
    expect(validateBlocks([b(0, 1), b(2, 3)], 4)).toHaveLength(2);
    expect(validateBlocks([b(0, 1), b(3, 3)], 4)).toBeNull(); // дыра
    expect(validateBlocks([b(0, 2), b(2, 3)], 4)).toBeNull(); // пересечение
    expect(validateBlocks([b(0, 1), b(2, 2)], 4)).toBeNull(); // не до конца
    expect(validateBlocks([b(0, 3)], 4)).toBeNull(); // один блок
    expect(
      validateBlocks(
        Array.from({ length: 8 }, (_, i) => b(i, i)),
        8,
      ),
    ).toBeNull();
  });
});

describe('order', () => {
  it('puts leaves first and never batches a caller before its callee', async () => {
    const mk = (id: string, calls: string[]) => ({
      id,
      kind: 'function' as const,
      name: id,
      range: { start: [0, 0] as [number, number], end: [0, 0] as [number, number] },
      signature: '',
      signatureHash: '',
      bodyHash: '',
      layer: null,
      calls: calls.map((t) => ({ target: t, line: 0, resolved: true, kind: 'call' as const })),
      summary: null,
      blocks: null,
    });
    const m: ModuleFile = {
      file: 'x',
      language: 'python',
      fileHash: '',
      layer: null,
      summary: null,
      symbols: [
        mk('a', ['b', 'c']),
        mk('b', ['c']),
        mk('c', []),
        mk('d', []),
        mk('e', ['e', 'f']),
        mk('f', ['e']),
      ],
    };
    const index = new GraphIndex([m]);
    const order = bottomUpOrder(['a', 'b', 'c', 'd', 'e', 'f'], index);
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    const levels = new Map(
      order.map((id) => [id, ['c', 'd'].includes(id) ? 0 : id === 'b' ? 1 : 2]),
    );
    const batches = makeBatches(
      order.filter((id) => levels.has(id) && id !== 'e' && id !== 'f'),
      (id) => levels.get(id)!,
      10,
    );
    expect(batches).toEqual([['c', 'd'], ['b'], ['a']]);
  });
});

describe('summarize', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-sum-'));
    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
    await buildGraph(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('describes leaves before their callers, so callers see callee summaries', async () => {
    const provider = new FakeProvider();
    const stats = await summarize(root, {
      provider,
      config: {
        ...(await import('@clewmap/core')).parseConfig({}),
        summaries: {
          provider: 'fake',
          model: null,
          language: 'en',
          batchSize: 3,
          blocksMinLines: 8,
        },
      },
    });
    expect(stats.failed).toBe(0);
    expect(stats.remaining).toBe(0);
    const flat = provider.batches.flat();
    expect(flat.indexOf('src/services/pricing.py#apply_promo')).toBeLessThan(
      flat.indexOf(`${ORDER}#create_order`),
    );
    expect(flat.indexOf('src/db/promo_repo.py#get')).toBeLessThan(
      flat.indexOf('src/services/pricing.py#apply_promo'),
    );
    const order = await readModule(root, ORDER);
    const create = order!.symbols.find((s) => s.name === 'create_order')!;
    expect(create.summary!.text).toContain('|apply_promo: get: |is_expired:');
    expect(create.summary).toMatchObject({
      model: 'fake-1',
      stale: false,
      forBodyHash: create.bodyHash,
    });
    expect((await readQueue(root)).items).toEqual([]);
  });

  it('turns block statement indices into ranges taken from tree-sitter', async () => {
    await summarize(root, { provider: new FakeProvider() });
    const create = (await readModule(root, ORDER))!.symbols.find((s) => s.name === 'create_order')!;
    // create_order: 7 операторов → блоки [0..2] и [3..6]
    expect(create.blocks).toHaveLength(2);
    expect(create.blocks![0]).toMatchObject({
      statements: [0, 2],
      label: 'first half',
      range: { start: [5, 4], end: [7, 47] },
    });
    expect(create.blocks![1]).toMatchObject({
      statements: [3, 6],
      range: { start: [8, 4], end: [12, 16] },
    });
    const source = (await readFile(path.join(root, ORDER), 'utf8')).split('\n');
    expect(source[create.blocks![1]!.range.end[0]]!.trim()).toBe('return order');
    const short = (await readModule(root, 'src/services/pricing.py'))!.symbols.find(
      (s) => s.name === 'calc_total',
    )!;
    expect(short.blocks).toBeNull();
  });

  it('retries a failed batch with exponential pauses', async () => {
    const pauses: number[] = [];
    const provider = new FakeProvider((call) => call <= 2);
    const stats = await summarize(root, {
      provider,
      sleep: async (ms) => void pauses.push(ms),
      retryBaseMs: 100,
    });
    expect(pauses).toEqual([100, 200]);
    expect(stats.failed).toBe(0);
    expect(stats.remaining).toBe(0);
  });

  it('keeps finished batches when a later one keeps failing', async () => {
    const provider = new FakeProvider((_, batch) =>
      batch.some((r) => r.id.endsWith('#create_order')),
    );
    const stats = await summarize(root, {
      provider,
      retries: 1,
      sleep: async () => {},
      config: {
        ...(await import('@clewmap/core')).parseConfig({}),
        summaries: {
          provider: 'fake',
          model: null,
          language: 'en',
          batchSize: 2,
          blocksMinLines: 8,
        },
      },
    });
    expect(stats.done).toBeGreaterThan(0);
    expect(stats.failed).toBeGreaterThan(0);
    const { modules } = await readGraph(root);
    const index = new GraphIndex(modules);
    expect(index.get('src/services/pricing.py#apply_promo')!.summary).not.toBeNull();
    expect(index.get(`${ORDER}#create_order`)!.summary).toBeNull();
    const q = await readQueue(root);
    expect(q.items.find((i) => i.id.endsWith('#create_order'))?.attempts).toBe(1);
    expect(q.items.find((i) => i.id.endsWith('#apply_promo'))).toBeUndefined();
  });

  it('does nothing while another live process holds the lock, and takes over a dead one', async () => {
    const lock = await acquireLock(root);
    expect(lock).not.toBeNull();
    const provider = new FakeProvider();
    expect((await summarize(root, { provider })).locked).toBe(true);
    expect(provider.calls).toBe(0);
    await lock!.release();
    await writeFile(
      path.join(root, '.clewmap/.lock'),
      JSON.stringify({
        pid: 999_999_999,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
      }),
    );
    expect(
      isStale(JSON.parse(await readFile(path.join(root, '.clewmap/.lock'), 'utf8')), 60_000),
    ).toBe(true);
    expect((await summarize(root, { provider })).locked).toBe(false);
  });

  it('stops at the time limit: finished batches stay, the rest waits in the queue unpunished', async () => {
    const ctrl = new AbortController();
    // Второй вызов «висит», пока не придёт отмена, как долгий claude -p.
    const provider: SummaryProvider & { calls: number } = {
      name: 'slow',
      model: 'slow-1',
      usage: { input: 0, output: 0 },
      calls: 0,
      async summarize(batch, opts) {
        this.calls++;
        this.usage!.input += 100;
        this.usage!.output += 10;
        if (this.calls === 1) return batch.map((r) => ({ id: r.id, summary: r.name }));
        await new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          ctrl.abort();
        });
        return [];
      },
    };
    const stats = await summarize(root, { provider, signal: ctrl.signal, sleep: async () => {} });
    expect(stats.aborted).toBe(true);
    expect(provider.calls).toBe(2);
    expect(stats.done).toBeGreaterThan(0);
    expect(stats.failed).toBe(0);
    expect(stats.remaining).toBeGreaterThan(0);
    expect(stats.tokens).toEqual({ input: 200, output: 20 });
    const q = await readQueue(root);
    expect(q.items.every((i) => i.attempts === 0)).toBe(true);
  });

  it('waits for a running summarize when asked, instead of leaving at once', async () => {
    const lock = await acquireLock(root);
    const provider = new FakeProvider();
    setTimeout(() => void lock!.release(), 300);
    const stats = await summarize(root, { provider, waitForLock: true });
    expect(stats.locked).toBe(false);
    expect(stats.remaining).toBe(0);
    // С лимитом времени ожидание тоже заканчивается.
    const again = await acquireLock(root);
    const stats2 = await summarize(root, {
      provider,
      waitForLock: true,
      signal: AbortSignal.timeout(200),
    });
    expect(stats2.locked).toBe(true);
    await again!.release();
  });

  it('skips code that changed after the graph was built and drops obsolete tasks', async () => {
    const src = path.join(root, 'src/services/pricing.py');
    await writeFile(src, (await readFile(src, 'utf8')) + '\n# edited\n');
    const stats = await summarize(root, { provider: new FakeProvider() });
    expect(stats.skipped).toBeGreaterThan(0);
    const pricing = (await readModule(root, 'src/services/pricing.py'))!;
    expect(pricing.symbols.every((s) => s.summary === null)).toBe(true);
  });
});
