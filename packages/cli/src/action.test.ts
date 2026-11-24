// Прогон шагов GitHub Action (action/action.yml) на настоящем git: рабочая копия + «удалённый» bare-репозиторий.
// Шаги checkout и setup-node — чужие actions, их здесь заменяет подготовка; свои run-блоки выполняются как есть.
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const BIN = path.resolve(HERE, '../dist/bin.js');

/** run-блоки шагов по имени: action.yml простой, полноценный YAML-парсер не нужен. */
async function runBlocks(): Promise<Map<string, string>> {
  const lines = (await readFile(path.join(REPO, 'action/action.yml'), 'utf8')).split('\n');
  const out = new Map<string, string>();
  let name = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s+- name: (.+)$/.exec(lines[i]!);
    if (m) name = m[1]!;
    if (/^\s+run: \|$/.test(lines[i]!)) {
      const body: string[] = [];
      for (i++; i < lines.length && (lines[i]!.startsWith('        ') || !lines[i]!.trim()); i++)
        body.push(lines[i]!.slice(8));
      i--;
      out.set(name, body.join('\n'));
    }
  }
  return out;
}

/** Переменные env шагов, у которых значение — константа, а не выражение. */
async function constantEnvs(): Promise<Map<string, Record<string, string>>> {
  const lines = (await readFile(path.join(REPO, 'action/action.yml'), 'utf8')).split('\n');
  const out = new Map<string, Record<string, string>>();
  let name = '';
  let inEnv = false;
  for (const line of lines) {
    const m = /^\s+- name: (.+)$/.exec(line);
    if (m) {
      name = m[1]!;
      inEnv = false;
      continue;
    }
    if (/^ {6}env:$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv) {
      const kv = /^ {8}([A-Z_]+): (.+)$/.exec(line);
      if (kv) {
        if (!kv[2]!.includes('${{')) {
          const env = out.get(name) ?? {};
          env[kv[1]!] = kv[2]!.replace(/^'(.*)'$/, '$1');
          out.set(name, env);
        }
      } else if (!/^ {8}#/.test(line)) inEnv = false;
    }
  }
  return out;
}

describe('GitHub Action', () => {
  let tmp: string;
  let work: string;
  let remote: string;
  let blocks: Map<string, string>;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim();

  /** Постоянные переменные шага из action.yml (кроме выражений ${{ }}): имя бота и т. п. */
  function stepEnv(name: string): Record<string, string> {
    return stepEnvs.get(name) ?? {};
  }
  let stepEnvs: Map<string, Record<string, string>>;

  /** Один шаг Action с переменными, как их задал бы runner. */
  async function step(
    name: string,
    vars: Record<string, string>,
  ): Promise<{ out: string; output: string }> {
    const outputFile = path.join(tmp, `output-${Math.random().toString(36).slice(2)}`);
    await writeFile(outputFile, '');
    const out = execFileSync('bash', ['-c', blocks.get(name)!], {
      cwd: work,
      env: {
        ...env,
        GITHUB_OUTPUT: outputFile,
        CLEWMAP_CLI: `node ${BIN}`,
        CLEWMAP_VERSION: 'latest',
        ...stepEnv(name),
        ...vars,
      },
      stdio: 'pipe',
    }).toString();
    return { out, output: await readFile(outputFile, 'utf8') };
  }

  beforeAll(async () => {
    blocks = await runBlocks();
    stepEnvs = await constantEnvs();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'clewmap-action-'));
    remote = path.join(tmp, 'remote.git');
    work = path.join(tmp, 'work');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    git(tmp, 'clone', '-q', remote, work);
    await cp(path.join(REPO, 'fixtures/py-bot'), work, { recursive: true });
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'app without a code map');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('has the steps the test runs', () => {
    expect([...blocks.keys()]).toEqual(['Update the graph', 'Write summaries', 'Commit .clewmap/']);
  });

  it('first run: creates the config, builds the graph and pushes a [skip ci] bot commit', async () => {
    const before = git(work, 'rev-parse', 'HEAD');
    const u = await step('Update the graph', {
      CLEWMAP_SINCE: '0000000000000000000000000000000000000000',
    });
    expect(u.out).toMatch(/8 files, 24 symbols/);
    const c = await step('Commit .clewmap/', {
      MESSAGE: 'chore(clewmap): update the code map [skip ci]',
      BRANCH: 'main',
    });
    expect(c.output).toContain('committed=true');
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'main')).toBe(
      'clewmap[bot]|chore(clewmap): update the code map [skip ci]',
    );
    const files = git(remote, 'show', '--name-only', '--format=', 'main').split('\n');
    expect(files).toContain('.clewmap/manifest.json');
    expect(files).toContain('clewmap.config.json');
    expect(git(remote, 'rev-parse', 'main~1')).toBe(before);
  });

  it('push with a code change: updates only what changed, and a second run commits nothing', async () => {
    const before = git(work, 'rev-parse', 'HEAD');
    const src = path.join(work, 'src/services/pricing.py');
    await writeFile(
      src,
      (await readFile(src, 'utf8')).replace(
        'return max(total - found.amount, 0)',
        'return max(total - found.amount, 1)',
      ),
    );
    git(work, 'commit', '-qam', 'promo never goes to zero');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const oldHash = JSON.parse(
      git(work, 'show', `${before}:.clewmap/modules/src/services/pricing.py.json`),
    ).symbols.find((s: { name: string }) => s.name === 'apply_promo').bodyHash;

    const u = await step('Update the graph', { CLEWMAP_SINCE: before });
    expect(u.out).toMatch(/1 module file\(s\) written/);
    const c = await step('Commit .clewmap/', {
      MESSAGE: 'chore(clewmap): update the code map [skip ci]',
      BRANCH: 'main',
    });
    expect(c.output).toContain('committed=true');
    const pushed = JSON.parse(
      git(remote, 'show', 'main:.clewmap/modules/src/services/pricing.py.json'),
    );
    expect(
      pushed.symbols.find((s: { name: string }) => s.name === 'apply_promo').bodyHash,
    ).not.toBe(oldHash);
    expect(git(remote, 'show', '--name-only', '--format=', 'main').split('\n').sort()).toEqual([
      '.clewmap/manifest.json',
      '.clewmap/modules/src/services/pricing.py.json',
    ]);

    await step('Update the graph', { CLEWMAP_SINCE: git(work, 'rev-parse', 'HEAD~1') });
    const again = await step('Commit .clewmap/', { MESSAGE: 'x [skip ci]', BRANCH: 'main' });
    expect(again.output).toContain('committed=false');
  });

  it('a concurrent push is rebased over instead of failing', async () => {
    // Кто-то успел запушить, пока шёл Action.
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', remote, other);
    await writeFile(path.join(other, 'README.md'), 'hello\n');
    git(other, 'add', 'README.md');
    git(other, 'commit', '-qm', 'docs');
    git(other, 'push', '-q', 'origin', 'HEAD:main');

    const before = git(work, 'rev-parse', 'HEAD');
    const src = path.join(work, 'src/services/pricing.py');
    await writeFile(
      src,
      (await readFile(src, 'utf8')) + '\n\ndef vat(total):\n    return calc_total([]) + total\n',
    );
    git(work, 'commit', '-qam', 'vat');
    await step('Update the graph', { CLEWMAP_SINCE: before });
    // Коммит разработчика и коммит бота уходят вместе: push бота отклонят, он сделает rebase и повторит.
    const c = await step('Commit .clewmap/', { MESSAGE: 'map [skip ci]', BRANCH: 'main' });
    expect(c.output).toContain('committed=true');
    expect(c.out + '').not.toContain('Could not push');
    const log = git(remote, 'log', '--format=%s', '-3', 'main').split('\n');
    expect(log).toEqual(['map [skip ci]', 'vat', 'docs']);
  });

  it('summaries without a key: a warning, not a failure', async () => {
    const s = await step('Write summaries', { ANTHROPIC_API_KEY: '', CLEWMAP_MODEL: '' });
    expect(s.out).toContain('::warning::summaries is true but anthropic-api-key is empty');
  });
});
