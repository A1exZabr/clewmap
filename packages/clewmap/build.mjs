// Сборка npm-пакета `clewmap`: весь код монорепо и web-tree-sitter в один dist/bin.js,
// wasm-грамматики рядом в dist/wasm (без нативных пакетов tree-sitter-* в зависимостях).
/* global console */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const fromIndexer = createRequire(path.join(here, '../indexer/package.json'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, 'wasm'), { recursive: true });
for (const [name, spec] of Object.entries({
  'web-tree-sitter.wasm': 'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-python.wasm': 'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
}))
  cpSync(fromIndexer.resolve(spec), path.join(dist, 'wasm', name));

await esbuild.build({
  entryPoints: { bin: path.join(here, '../cli/src/bin.ts') },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Внешние — только опубликованные зависимости пакета; код монорепо и web-tree-sitter внутри.
  external: Object.keys(pkg.dependencies),
  banner: {
    js: [
      "import { createRequire as __clewmapCreateRequire } from 'node:module';",
      'const require = __clewmapCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { 'process.env.CLEWMAP_VERSION': JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync(path.join(dist, 'bin.js'), 0o755);
cpSync(path.join(here, '../../README.md'), path.join(here, 'README.md'));
cpSync(path.join(here, '../../LICENSE'), path.join(here, 'LICENSE'));
console.log(`clewmap ${pkg.version}: dist/bin.js + ${Object.keys(pkg.dependencies).length} deps`);
