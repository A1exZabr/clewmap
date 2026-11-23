import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  GraphIndex,
  matchGlob,
  moduleJsonPath,
  normalizeBody,
  parseConfig,
  readGraph,
  serializeModule,
  sha256,
  sourcePathFromModuleJson,
  toPosix,
  writeManifest,
  writeModule,
  type ModuleFile,
  type SymbolNode,
} from './index.js';

function sym(id: string, start: number, end: number, calls: string[] = []): SymbolNode {
  return {
    id,
    kind: 'function',
    name: id.split('#')[1]!,
    range: { start: [start, 0], end: [end, 0] },
    signature: `${id.split('#')[1]}()`,
    signatureHash: 'x',
    bodyHash: 'y',
    layer: null,
    calls: calls.map((target, i) => ({
      target,
      line: start + i + 1,
      resolved: !target.startsWith('external:'),
      kind: 'call',
    })),
    summary: null,
    blocks: null,
  };
}

function mod(file: string, symbols: SymbolNode[]): ModuleFile {
  return { file, language: 'python', fileHash: sha256(file), layer: null, summary: null, symbols };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('paths', () => {
  it('maps source paths to module json and back', () => {
    expect(moduleJsonPath('src/services/pricing.py')).toBe(
      '.clewmap/modules/src/services/pricing.py.json',
    );
    expect(sourcePathFromModuleJson('.clewmap/modules/src/services/pricing.py.json')).toBe(
      'src/services/pricing.py',
    );
    expect(toPosix('.\\src\\a.ts')).toBe('src/a.ts');
  });
});

describe('hash', () => {
  it('ignores comments and whitespace but not string contents', () => {
    const a = normalizeBody('def f(x):\n    # comment\n    return x  +  1\n', 'python');
    const b = normalizeBody('def f(x):\n        return x + 1  # other', 'python');
    expect(sha256(a)).toBe(sha256(b.replace('x + 1', 'x  +  1').replace(/ {2,}/g, ' ')));
    expect(normalizeBody('s = "# not a comment"', 'python')).toBe('s = "# not a comment"');
    expect(normalizeBody('const u = "//x"; // c\n/* b */ f()', 'typescript')).toBe(
      'const u = "//x"; f()',
    );
    expect(FORMAT_VERSION).toBe(1);
  });
});

describe('glob', () => {
  it('matches ** and *', () => {
    expect(matchGlob('src/bot/handlers/order.py', 'src/bot/**')).toBe(true);
    expect(matchGlob('src/x.py', '**/*.py')).toBe(true);
    expect(matchGlob('x.py', '**/*.py')).toBe(true);
    expect(matchGlob('src/tests/a.py', '**/tests/**')).toBe(true);
    expect(matchGlob('src/a.ts', 'src/*.{ts,tsx}')).toBe(true);
    expect(matchGlob('src/a/b.ts', 'src/*.ts')).toBe(false);
  });
});

describe('config', () => {
  it('fills defaults', () => {
    const c = parseConfig({ include: ['src/**'] });
    expect(c.summaries.blocksMinLines).toBe(8);
    expect(c.links.httpClients).toEqual([]);
    expect(c.hooks.preCommit).toBe(true);
  });
});

describe('store', () => {
  it('serializes deterministically regardless of input order', () => {
    const a = mod('src/a.py', [
      sym('src/a.py#g', 10, 12),
      sym('src/a.py#f', 1, 5, ['src/b.py#h', 'external:print']),
    ]);
    const b = mod('src/a.py', [
      sym('src/a.py#f', 1, 5, ['src/b.py#h', 'external:print']),
      sym('src/a.py#g', 10, 12),
    ]);
    b.symbols[0]!.calls.reverse();
    expect(serializeModule(a)).toBe(serializeModule(b));
    expect(Object.keys(JSON.parse(serializeModule(a)).symbols[0])[0]).toBe('id');
  });

  it('writes and reads the graph, second write is a no-op', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-core-'));
    tmpDirs.push(root);
    const m = mod('src/a.py', [sym('src/a.py#f', 1, 5)]);
    expect(await writeModule(root, m)).toBe(true);
    const bytes = await readFile(path.join(root, moduleJsonPath('src/a.py')), 'utf8');
    expect(await writeModule(root, m)).toBe(false);
    expect(await readFile(path.join(root, moduleJsonPath('src/a.py')), 'utf8')).toBe(bytes);
    await writeManifest(root, {
      formatVersion: 1,
      generator: 'clewmap@test',
      languages: ['python'],
      lastCommit: null,
      updatedAt: '2026-11-22T00:00:00.000Z',
    });
    const g = await readGraph(root);
    expect(g.manifest?.generator).toBe('clewmap@test');
    expect(g.modules.map((x) => x.file)).toEqual(['src/a.py']);
  });
});

describe('GraphIndex', () => {
  const modules = [
    mod('h.py', [
      sym('h.py#create_order', 0, 9, ['s.py#apply_promo', 'external:print']),
      sym('h.py#on_click', 11, 14, ['h.py#create_order']),
    ]),
    mod('s.py', [
      sym('s.py#apply_promo', 0, 8, ['d.py#get']),
      sym('s.py#Cart', 10, 30),
      { ...sym('s.py#Cart.total', 12, 15), kind: 'method' },
    ]),
    mod('d.py', [sym('d.py#get', 0, 2)]),
  ];
  const index = new GraphIndex(modules);

  it('builds calledBy from outgoing edges, skipping unresolved', () => {
    expect(index.callersOf('s.py#apply_promo').map((e) => e.from)).toEqual(['h.py#create_order']);
    expect(index.callersOf('external:print')).toEqual([]);
  });

  it('finds the innermost symbol by line', () => {
    expect(index.symbolAt('s.py', 13)?.id).toBe('s.py#Cart.total');
    expect(index.symbolAt('s.py', 20)?.id).toBe('s.py#Cart');
    expect(index.symbolAt('h.py', 10)).toBeUndefined();
  });

  it('computes neighbors and impact', () => {
    const n = index.neighbors('s.py#apply_promo', 1);
    expect([...n.callers]).toEqual(['h.py#create_order']);
    expect([...n.callees]).toEqual(['d.py#get']);
    expect(index.impact(['d.py#get'])).toEqual([
      { id: 's.py#apply_promo', depth: 1 },
      { id: 'h.py#create_order', depth: 2 },
      { id: 'h.py#on_click', depth: 3 },
    ]);
    expect(index.impact(['d.py#get'], 1)).toEqual([{ id: 's.py#apply_promo', depth: 1 }]);
  });
});
