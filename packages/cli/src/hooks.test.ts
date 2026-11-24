import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModule, readQueue } from '@clewmap/core';
import {
  BEGIN,
  END,
  hookBlock,
  installHooks,
  stripBlock,
  uninstallHooks,
  upsertBlock,
} from './hooks.js';
import { init } from './commands.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures');
const BIN = path.resolve(HERE, '../dist/bin.js');

describe('hook text', () => {
  it('appends to a foreign hook between markers and removes only its own block', () => {
    const foreign = '#!/bin/sh\nnpm run lint\n';
    const withBlock = upsertBlock(foreign, hookBlock('pre-commit', null));
    expect(withBlock.startsWith(foreign)).toBe(true);
    expect(withBlock).toContain(BEGIN);
    expect(withBlock.trimEnd().endsWith(END)).toBe(true);
    expect(upsertBlock(withBlock, hookBlock('pre-commit', null))).toBe(withBlock);
    expect(stripBlock(withBlock)).toBe(foreign);
  });

  it('pre-commit never fails the commit and honours CLEWMAP_SKIP', () => {
    const block = hookBlock('pre-commit', null);
    expect(block).toContain('if [ -z "$CLEWMAP_SKIP" ]');
    expect(block).toContain('update --staged --quiet --timeout 5000');
    expect(block).toContain('git add -- .clewmap/');
    expect(block).toMatch(/else\n\s+echo "clewmap: graph not updated/);
    expect(hookBlock('post-commit', null)).toContain('summarize --background --quiet');
  });
});

describe('hook install', () => {
  let root: string;
  let extraEnv: Record<string, string> = {};
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...extraEnv,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        // фоновые описания в тесте не нужны: post-commit проверяем отдельно
      },
    }).toString();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-hooks-'));
    extraEnv = {};
    git('init', '-q');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes executable hooks into .git/hooks and removes them cleanly', async () => {
    const pre = path.join(root, '.git/hooks/pre-commit');
    await writeFile(pre, '#!/bin/sh\necho mine\n');
    const changes = await installHooks(root);
    expect(changes.map((c) => [c.hook, c.action])).toEqual([
      ['pre-commit', 'installed'],
      ['post-commit', 'installed'],
    ]);
    expect((await stat(pre)).mode & 0o111).toBeTruthy();
    expect(await readFile(pre, 'utf8')).toContain('echo mine');
    await uninstallHooks(root);
    expect(await readFile(pre, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    await expect(stat(path.join(root, '.git/hooks/post-commit'))).rejects.toThrow();
  });

  it('writes into .husky/ when the project uses husky, without machine paths', async () => {
    await mkdir(path.join(root, '.husky'));
    await installHooks(root, {
      fallback: { node: '/usr/bin/node', bin: '/home/me/clewmap/bin.js' },
    });
    const text = await readFile(path.join(root, '.husky/pre-commit'), 'utf8');
    expect(text).toContain(BEGIN);
    expect(text).not.toContain('/home/me');
  });

  it('a real commit updates and stages .clewmap/ quickly, and survives a broken clewmap', async () => {
    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
    await init(root, {});
    git('add', '-A');
    git('commit', '-qm', 'init', '--no-verify');
    execFileSync(process.execPath, [BIN, '--cwd', root, 'build', '--no-summaries'], {
      stdio: 'pipe',
    });
    git('add', '-A');
    git('commit', '-qm', 'graph', '--no-verify');
    await installHooks(root, {
      hooks: ['pre-commit'],
      fallback: { node: process.execPath, bin: BIN },
    });

    const src = path.join(root, 'src/services/pricing.py');
    await writeFile(
      src,
      (await readFile(src, 'utf8')).replace(
        'return max(total - found.amount, 0)',
        'return max(total - found.amount, 1)',
      ),
    );
    const before = (await readModule(root, 'src/services/pricing.py'))!.symbols.find(
      (s) => s.name === 'apply_promo',
    )!;
    git('add', 'src/services/pricing.py');
    const t0 = performance.now();
    git('commit', '-qm', 'change apply_promo');
    const ms = performance.now() - t0;
    // Порог — таймаут хука: vitest гоняет файлы параллельно. Замер «< 2 с» — в проверке фазы 2.
    expect(ms).toBeLessThan(5000);
    const committed = JSON.parse(git('show', 'HEAD:.clewmap/modules/src/services/pricing.py.json'));
    const after = committed.symbols.find((s: { name: string }) => s.name === 'apply_promo');
    expect(after.bodyHash).not.toBe(before.bodyHash);
    expect(git('status', '--porcelain')).toBe('');

    // Сломанный clewmap: хук предупреждает, коммит всё равно проходит.
    await installHooks(root, {
      hooks: ['pre-commit'],
      fallback: { node: process.execPath, bin: '/nonexistent/bin.js' },
    });
    await writeFile(path.join(root, 'README.md'), 'x\n');
    git('add', 'README.md');
    git('commit', '-qm', 'docs');
    expect(git('log', '-1', '--format=%s').trim()).toBe('docs');

    // CLEWMAP_SKIP=1 отключает хук.
    await installHooks(root, {
      hooks: ['pre-commit'],
      fallback: { node: process.execPath, bin: BIN },
    });
    await writeFile(src, (await readFile(src, 'utf8')) + '\n\ndef skipped():\n    return 0\n');
    git('add', 'src/services/pricing.py');
    execFileSync('git', ['commit', '-qm', 'skip'], {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        CLEWMAP_SKIP: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    expect(git('show', '--stat', '--format=', 'HEAD')).not.toContain('.clewmap');
  });
  it('hooks.summarize = "pre-commit" puts summaries into the same commit and respects the time limit', async () => {
    // Подменный claude: отвечает описаниями по заголовкам ### id; FAKE_CLAUDE_SLEEP заставляет его висеть.
    const fakeDir = await mkdtemp(path.join(os.tmpdir(), 'clewmap-fake-claude-'));
    const fake = path.join(fakeDir, 'claude');
    await writeFile(
      fake,
      `#!${process.execPath}
let input = '';
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  const ids = [...input.matchAll(/^### (\\S+)$/gm)].map((m) => m[1]);
  const out = { type: 'result', is_error: false, modelUsage: { 'fake-claude': {} },
    usage: { input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 5 },
    result: JSON.stringify(ids.map((id) => ({ id, summary: 'fake summary of ' + id }))) };
  setTimeout(() => process.stdout.write(JSON.stringify(out)), Number(process.env.FAKE_CLAUDE_SLEEP || 0));
});
`,
    );
    await chmod(fake, 0o755);
    extraEnv = { PATH: `${fakeDir}${path.delimiter}${process.env.PATH}` };

    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
    await init(root, {});
    const configPath = path.join(root, 'clewmap.config.json');
    const setHooks = async (hooks: object) => {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.hooks = { ...config.hooks, ...hooks };
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    };
    await setHooks({ summarize: 'pre-commit', summarizeTimeout: 30 });
    execFileSync(process.execPath, [BIN, '--cwd', root, 'build', '--no-summaries'], {
      stdio: 'pipe',
    });
    git('add', '-A');
    git('commit', '-qm', 'graph', '--no-verify');
    await installHooks(root, {
      hooks: ['pre-commit'],
      fallback: { node: process.execPath, bin: BIN },
    });

    const src = path.join(root, 'src/services/pricing.py');
    const edit = async (from: string, to: string) => {
      await writeFile(src, (await readFile(src, 'utf8')).replace(from, to));
      git('add', 'src/services/pricing.py');
    };
    const committedPromo = () =>
      JSON.parse(git('show', 'HEAD:.clewmap/modules/src/services/pricing.py.json')).symbols.find(
        (s: { name: string }) => s.name === 'apply_promo',
      );

    await edit('return max(total - found.amount, 0)', 'return max(total - found.amount, 1)');
    git('commit', '-qm', 'change apply_promo');
    const promo = committedPromo();
    expect(promo.summary.text).toBe('fake summary of src/services/pricing.py#apply_promo');
    expect(promo.summary.forBodyHash).toBe(promo.bodyHash);
    expect(promo.summary.model).toBe('fake-claude');
    expect(git('status', '--porcelain')).toBe('');
    expect((await readQueue(root)).items).toHaveLength(0);

    // Лимит 1 с, а claude висит 20 с: коммит не ждёт дольше лимита, задача остаётся в очереди без штрафа.
    await setHooks({ summarizeTimeout: 1 });
    git('add', 'clewmap.config.json');
    git('commit', '-qm', 'limit', '--no-verify');
    extraEnv = { ...extraEnv, FAKE_CLAUDE_SLEEP: '20000' };
    await edit('return max(total - found.amount, 1)', 'return max(total - found.amount, 2)');
    const t0 = performance.now();
    git('commit', '-qm', 'slow model');
    expect(performance.now() - t0).toBeLessThan(8000);
    const slow = committedPromo();
    expect(slow.bodyHash).not.toBe(promo.bodyHash);
    expect(slow.summary).toBeNull();
    const q = await readQueue(root);
    expect(q.items.find((i) => i.id.endsWith('#apply_promo'))?.attempts).toBe(0);
    await rm(fakeDir, { recursive: true, force: true });
  }, 30_000);
});
