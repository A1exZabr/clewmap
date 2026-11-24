// Запуск тестов расширения в настоящем VS Code: готовит копию fixtures/py-bot с git и графом,
// затем открывает её в Extension Development Host и гоняет suite.ts.
// CLEWMAP_VSCODE=/path/to/Code — свой VS Code; по умолчанию установленный в /Applications.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { readGraph, writeModule, type ModuleFile } from '@clewmap/core';

const pkg = path.resolve(__dirname, '../..');
const repo = path.resolve(pkg, '../..');
const cli = path.join(repo, 'packages/cli/dist/bin.js');

function sh(cwd: string, cmd: string, args: string[]): void {
  execFileSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/** Описания и блоки, как после clewmap summarize, но без модели. */
async function fakeSummaries(root: string): Promise<void> {
  const { modules } = await readGraph(root);
  for (const m of modules) {
    let changed = false;
    for (const s of m.symbols) {
      if (s.kind === 'variable' || s.summary?.forBodyHash === s.bodyHash) continue;
      s.summary = {
        text: `${s.name}: test summary of what this code does, long enough to be cut in the line above the function.`,
        forBodyHash: s.bodyHash,
        stale: false,
        model: 'test',
        createdAt: '2026-11-24T00:00:00.000Z',
      };
      if (s.name === 'create_order')
        s.blocks = [
          {
            range: { start: [5, 4], end: [6, 42] },
            statements: [0, 1],
            label: 'totals the cart',
            text: 'Sums the items and applies the promo code.',
            forBodyHash: s.bodyHash,
          },
          {
            range: { start: [7, 4], end: [8, 44] },
            statements: [2, 3],
            label: 'saves and pays',
            text: null,
            forBodyHash: s.bodyHash,
          },
          {
            range: { start: [9, 4], end: [12, 16] },
            statements: [4, 6],
            label: 'tells the user',
            text: null,
            forBodyHash: s.bodyHash,
          },
        ];
      changed = true;
    }
    if (changed) await writeModule(root, m as ModuleFile);
  }
}

async function prepare(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-vscode-ws-'));
  await cp(path.join(repo, 'fixtures/py-bot'), root, { recursive: true });
  sh(root, 'git', ['init', '-q']);
  sh(root, process.execPath, [cli, '--cwd', root, 'init']);
  sh(root, process.execPath, [cli, '--cwd', root, 'build', '--no-summaries']);
  await fakeSummaries(root);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'graph']);
  const pricing = path.join(root, 'src/services/pricing.py');
  await writeFile(
    pricing,
    (await readFile(pricing, 'utf8')).replace(
      'return max(total - found.amount, 0)',
      'return max(total - found.amount, 1)',
    ),
  );
  sh(root, process.execPath, [cli, '--cwd', root, 'update']);
  await fakeSummaries(root);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'promo never goes to zero']);
  return root;
}

async function main(): Promise<void> {
  // CLEWMAP_DEMO=<папка проекта>: открыть его и показать экраны по очереди (для скриншотов), без тестов.
  const demo = process.env.CLEWMAP_DEMO;
  const workspace = demo ?? (await prepare());
  // Установленный VS Code (бинарь в новых версиях называется Code, в старых — Electron).
  // Сами ничего не скачиваем: без VS Code раннер падает с подсказкой, а не тянет 400 МБ молча.
  const vscodeExecutablePath =
    process.env.CLEWMAP_VSCODE ??
    ['Code', 'Electron']
      .map((b) => `/Applications/Visual Studio Code.app/Contents/MacOS/${b}`)
      .find((p) => existsSync(p));
  if (!vscodeExecutablePath) {
    console.error('VS Code not found. Set CLEWMAP_VSCODE=/path/to/the/VS Code binary.');
    process.exit(1);
  }
  const userData = await mkdtemp(path.join(os.tmpdir(), 'clewmap-vscode-user-'));
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: pkg,
    extensionTestsPath: path.join(pkg, demo ? 'dist/test/demo.js' : 'dist/test/suite.js'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userData}`,
      `--locale=${process.env.CLEWMAP_LOCALE ?? 'en'}`,
    ],
    extensionTestsEnv: {
      CLEWMAP_TEST_WORKSPACE: workspace,
      CLEWMAP_DEMO_SIGNAL: process.env.CLEWMAP_DEMO_SIGNAL ?? '',
      CLEWMAP_DEMO_SCENE: process.env.CLEWMAP_DEMO_SCENE ?? '',
    },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
