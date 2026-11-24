// Одна версия на всё: из packages/clewmap/package.json в расширение, плагин и метку генератора графа.
/* global console, process */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => writeFileSync(path.join(root, f), s);
const { version } = JSON.parse(read('packages/clewmap/package.json'));

for (const f of ['packages/vscode/package.json', 'claude-plugin/.claude-plugin/plugin.json']) {
  const json = JSON.parse(read(f));
  json.version = version;
  write(f, JSON.stringify(json, null, 2) + '\n');
}
const core = 'packages/core/src/index.ts';
write(core, read(core).replace(/GENERATOR = 'clewmap@[^']+'/, `GENERATOR = 'clewmap@${version}'`));

// Тот же вид, что даёт prettier, иначе format:check в CI спорит со скриптом.
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'prettier',
    '--write',
    'packages/vscode/package.json',
    'claude-plugin/.claude-plugin/plugin.json',
    core,
  ],
  { cwd: root, stdio: 'ignore' },
);

const check = process.argv.includes('--check');
if (check) {
  const tag = process.env.GITHUB_REF_NAME;
  if (tag && tag !== `v${version}`) {
    console.error(`tag ${tag} does not match packages/clewmap version ${version}`);
    process.exit(1);
  }
}
console.log(`clewmap ${version}: extension, plugin and generator tag updated`);
