import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dequeue,
  diffModules,
  enqueue,
  isEmptyDiff,
  readQueue,
  type ModuleFile,
  type SymbolNode,
} from './index.js';

function sym(name: string, body: string, sig: string): SymbolNode {
  return {
    id: `a.py#${name}`,
    kind: 'function',
    name,
    range: { start: [0, 0], end: [1, 0] },
    signature: sig,
    signatureHash: sig,
    bodyHash: body,
    layer: null,
    calls: [],
    summary: null,
    blocks: null,
  };
}

function mod(symbols: SymbolNode[]): ModuleFile {
  return { file: 'a.py', language: 'python', fileHash: 'h', layer: null, summary: null, symbols };
}

describe('diffModules', () => {
  it('finds added, removed, body and signature changes', () => {
    const prev = mod([
      sym('keep', 'b1', 's1'),
      sym('body', 'b1', 's1'),
      sym('sig', 'b1', 's1'),
      sym('gone', 'b', 's'),
    ]);
    const next = mod([
      sym('keep', 'b1', 's1'),
      sym('body', 'b2', 's1'),
      sym('sig', 'b2', 's2'),
      sym('new', 'b', 's'),
    ]);
    const d = diffModules(prev, next);
    expect(d.added).toEqual(['a.py#new']);
    expect(d.removed).toEqual(['a.py#gone']);
    expect(d.bodyChanged).toEqual(['a.py#body', 'a.py#sig']);
    expect(d.signatureChanged).toEqual(['a.py#sig']);
    expect(isEmptyDiff(diffModules(prev, prev))).toBe(true);
  });

  it('treats a missing side as a new or deleted file', () => {
    expect(diffModules(null, mod([sym('x', 'b', 's')])).added).toEqual(['a.py#x']);
    expect(diffModules(mod([sym('x', 'b', 's')]), null).removed).toEqual(['a.py#x']);
  });
});

describe('queue', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-queue-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps one task per id, high beats low, new code resets attempts', async () => {
    expect(await enqueue(root, [{ id: 'x', priority: 'high', bodyHash: 'b1' }])).toBe(1);
    await enqueue(root, [
      { id: 'x', priority: 'low', bodyHash: 'b1' },
      { id: 'y', priority: 'low', bodyHash: 'b1' },
    ]);
    let q = await readQueue(root);
    expect(q.items.map((i) => [i.id, i.priority])).toEqual([
      ['x', 'high'],
      ['y', 'low'],
    ]);
    q.items[0]!.attempts = 3;
    await enqueue(root, [{ id: 'x', priority: 'low', bodyHash: 'b2' }]);
    q = await readQueue(root);
    expect(q.items.find((i) => i.id === 'x')).toMatchObject({
      bodyHash: 'b2',
      priority: 'low',
      attempts: 0,
    });
  });

  it('dequeue leaves tasks for newer code alone', async () => {
    await enqueue(root, [
      { id: 'x', priority: 'high', bodyHash: 'b2' },
      { id: 'y', priority: 'high', bodyHash: 'b1' },
    ]);
    await dequeue(
      root,
      new Map([
        ['x', 'b1'],
        ['y', 'b1'],
      ]),
    );
    expect((await readQueue(root)).items.map((i) => i.id)).toEqual(['x']);
    await dequeue(root, new Map([['x', null]]));
    expect((await readQueue(root)).items).toEqual([]);
  });
});
