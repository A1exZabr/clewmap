import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModule, readQueue, writeModule, type ModuleFile } from '@clewmap/core';
import { buildGraph, syncGraph, updateGraph } from './index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const PRICING = 'src/services/pricing.py';

/** Ставит всем функциям фейковые описания, как будто summarize уже отработал. */
async function fakeSummaries(root: string, files: string[]): Promise<void> {
  for (const file of files) {
    const m = (await readModule(root, file)) as ModuleFile;
    for (const s of m.symbols)
      s.summary = {
        text: `about ${s.name}`,
        forBodyHash: s.bodyHash,
        stale: false,
        model: 'fake',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    await writeModule(root, m);
  }
}

function sym(m: ModuleFile | null, name: string) {
  return m?.symbols.find((s) => s.name === name);
}

describe('incremental update', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-update-'));
    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
    await buildGraph(root);
    await fakeSummaries(root, [
      PRICING,
      'src/bot/handlers/order.py',
      'src/bot/handlers/catalog.py',
      'src/api/checkout.py',
    ]);
    await rm(path.join(root, '.clewmap/.queue.json'), { force: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first build queues every function and class, but not module variables', async () => {
    const fresh = await mkdtemp(path.join(os.tmpdir(), 'clewmap-update-'));
    await cp(path.join(FIXTURES, 'py-bot'), fresh, { recursive: true });
    const stats = await buildGraph(fresh);
    const q = await readQueue(fresh);
    expect(stats.queued).toBe(q.items.length);
    expect(q.items.some((i) => i.id.endsWith('#apply_promo'))).toBe(true);
    expect(q.items.some((i) => i.id.endsWith('#router'))).toBe(false);
    expect(new Set(q.items.map((i) => i.priority))).toEqual(new Set(['high']));
    await rm(fresh, { recursive: true, force: true });
  });

  it('a body change drops only that summary and queues it', async () => {
    const src = path.join(root, PRICING);
    const text = await readFile(src, 'utf8');
    await writeFile(
      src,
      text.replace('return max(total - found.amount, 0)', 'return max(total - found.amount, 1)'),
    );
    const before = await readModule(root, PRICING);
    const stats = await syncGraph(root);
    expect(stats.parsed).toBe(1);
    const after = await readModule(root, PRICING);
    expect(sym(after, 'apply_promo')!.bodyHash).not.toBe(sym(before, 'apply_promo')!.bodyHash);
    expect(sym(after, 'apply_promo')!.summary).toBeNull();
    expect(sym(after, 'calc_total')!.summary?.text).toBe('about calc_total');
    const order = await readModule(root, 'src/bot/handlers/order.py');
    expect(sym(order, 'create_order')!.summary).toMatchObject({
      text: 'about create_order',
      stale: false,
    });
    const q = await readQueue(root);
    expect(q.items.map((i) => i.id)).toContain(`${PRICING}#apply_promo`);
    expect(q.items.find((i) => i.id.endsWith('#create_order'))).toBeUndefined();
  });

  it('a signature change marks callers stale and queues them with low priority', async () => {
    const src = path.join(root, PRICING);
    const text = await readFile(src, 'utf8');
    await writeFile(
      src,
      text.replace('def apply_promo(total, promo):', 'def apply_promo(total, promo, user=None):'),
    );
    const stats = await syncGraph(root);
    expect(stats.staleMarked).toBe(3);
    const order = await readModule(root, 'src/bot/handlers/order.py');
    const catalog = await readModule(root, 'src/bot/handlers/catalog.py');
    expect(sym(order, 'create_order')!.summary!.stale).toBe(true);
    expect(sym(catalog, 'preview_cart')!.summary!.stale).toBe(true);
    expect(sym(order, 'retry_pay')!.summary!.stale).toBe(false);
    const q = await readQueue(root);
    expect(q.items.find((i) => i.id.endsWith('#create_order'))?.priority).toBe('low');
    expect(q.items.find((i) => i.id.endsWith('#apply_promo'))?.priority).toBe('high');
  });

  it('a renamed file keeps its summaries and callers point to the new ids', async () => {
    await rename(path.join(root, PRICING), path.join(root, 'src/services/prices.py'));
    for (const f of [
      'src/bot/handlers/order.py',
      'src/bot/handlers/catalog.py',
      'src/api/checkout.py',
    ]) {
      const p = path.join(root, f);
      await writeFile(
        p,
        (await readFile(p, 'utf8')).replace('services.pricing', 'services.prices'),
      );
    }
    const stats = await syncGraph(root);
    expect(stats.renamed).toBe(1);
    expect(await readModule(root, PRICING)).toBeNull();
    const moved = await readModule(root, 'src/services/prices.py');
    expect(sym(moved, 'apply_promo')!.id).toBe('src/services/prices.py#apply_promo');
    expect(sym(moved, 'apply_promo')!.summary?.text).toBe('about apply_promo');
    const order = await readModule(root, 'src/bot/handlers/order.py');
    expect(sym(order, 'create_order')!.calls.map((c) => c.target)).toContain(
      'src/services/prices.py#apply_promo',
    );
  });

  it('a deleted file leaves unresolved edges in the modules that used it', async () => {
    await rm(path.join(root, PRICING));
    const stats = await syncGraph(root);
    expect(stats.deleted).toBe(1);
    const order = await readModule(root, 'src/bot/handlers/order.py');
    const edge = sym(order, 'create_order')!.calls.find((c) => c.target.includes('apply_promo'));
    expect(edge).toMatchObject({ resolved: false });
    expect(edge!.target.startsWith('external:')).toBe(true);
  });
});

describe('update --staged', () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).toString();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-staged-'));
    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await buildGraph(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes the staged version, not unstaged edits', async () => {
    const src = path.join(root, PRICING);
    const original = await readFile(src, 'utf8');
    await writeFile(src, original.replace('return total\n', 'return total * 1\n'));
    git('add', PRICING);
    const staged = await readFile(src, 'utf8');
    await writeFile(src, staged.replace('def calc_total(items):', 'def calc_total(items, tax=0):'));
    await updateGraph(root, { kind: 'staged' });
    const m = await readModule(root, PRICING);
    expect(sym(m, 'calc_total')!.signature).toBe('calc_total(items)');
    expect(m!.fileHash).not.toBe((await import('@clewmap/core')).sha256(original));
  });

  it('takes renames from git -M even when the file changed too', async () => {
    const m = (await readModule(root, PRICING))!;
    for (const s of m.symbols)
      s.summary = { text: 'x', forBodyHash: s.bodyHash, stale: false, model: 'f', createdAt: 't' };
    await writeModule(root, m);
    git('mv', PRICING, 'src/services/prices.py');
    const p = path.join(root, 'src/services/prices.py');
    await writeFile(p, (await readFile(p, 'utf8')) + '\n\ndef extra():\n    return 1\n');
    git('add', '-A');
    const stats = await updateGraph(root, { kind: 'staged' });
    expect(stats.renamed).toBe(1);
    expect(sym(await readModule(root, 'src/services/prices.py'), 'calc_total')!.summary?.text).toBe(
      'x',
    );
  });
});
