// Сборка расширения: код для VS Code (CJS, Node), панель (браузер), wasm tree-sitter и упаковка .vsix.
// node esbuild.mjs [--watch] [--production] [--vsix]
/* global process, console */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const production = args.has('--production') || args.has('--vsix');
const watch = args.has('--watch');
const dist = path.join(here, 'dist');

// Пакеты индексатора резолвим так же, как он сам: через его node_modules.
const requireFromIndexer = createRequire(
  path.join(here, 'node_modules/@clewmap/indexer/package.json'),
);

function copyWasm() {
  const out = path.join(dist, 'wasm');
  mkdirSync(out, { recursive: true });
  const files = {
    'web-tree-sitter.wasm': 'web-tree-sitter/web-tree-sitter.wasm',
    'tree-sitter-python.wasm': 'tree-sitter-python/tree-sitter-python.wasm',
    'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
    'tree-sitter-javascript.wasm': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  };
  for (const [name, spec] of Object.entries(files))
    cpSync(requireFromIndexer.resolve(spec), path.join(out, name));
}

// В CJS-бандле нет import.meta.url: подставляем адрес самого файла.
const nodeShim = {
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
};

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
};

const builds = [
  {
    ...common,
    ...nodeShim,
    entryPoints: { extension: 'src/extension.ts' },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { webview: 'webview/main.tsx' },
    outdir: dist,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'text' },
  },
];
if (!production)
  builds.push({
    ...common,
    ...nodeShim,
    entryPoints: {
      'test/run': 'src/test/run.ts',
      'test/suite': 'src/test/suite.ts',
      'test/demo': 'src/test/demo.ts',
    },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', '@vscode/test-electron'],
  });

/** .vsix из отдельной папки: в манифесте имя без scope, внутри только dist, media и тексты. */
function packageVsix() {
  const stage = path.join(here, '.vsix-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  const manifest = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
  manifest.name = 'clewmap';
  delete manifest.devDependencies;
  delete manifest.dependencies;
  manifest.scripts = {};
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  cpSync(dist, path.join(stage, 'dist'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}test`) && !src.endsWith('.map'),
  });
  cpSync(path.join(here, 'media'), path.join(stage, 'media'), { recursive: true });
  cpSync(path.join(here, 'l10n'), path.join(stage, 'l10n'), { recursive: true });
  for (const f of ['package.nls.json', 'package.nls.ru.json'])
    cpSync(path.join(here, f), path.join(stage, f));
  for (const f of ['README.md', 'CHANGELOG.md'])
    if (existsSync(path.join(here, f))) cpSync(path.join(here, f), path.join(stage, f));
  cpSync(path.join(here, '../../LICENSE'), path.join(stage, 'LICENSE'));
  const vsce = path.join(here, 'node_modules/.bin/vsce');
  execFileSync(vsce, ['package', '--no-dependencies', '-o', path.join(here, 'clewmap.vsix')], {
    cwd: stage,
    stdio: 'inherit',
  });
  rmSync(stage, { recursive: true, force: true });
}

rmSync(dist, { recursive: true, force: true });
copyWasm();
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('clewmap: watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  if (args.has('--vsix')) packageVsix();
}
