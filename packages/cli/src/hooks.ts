import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BEGIN = '# >>> clewmap';
export const END = '# <<< clewmap';

export type HookName = 'pre-commit' | 'post-commit';

/** Как хук находит clewmap: локальная установка, PATH, затем путь, с которого ставили хук. */
function finder(fallback: { node: string; bin: string } | null): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = [
    '  _clewmap() {',
    '    if [ -x ./node_modules/.bin/clewmap ]; then ./node_modules/.bin/clewmap "$@"',
    '    elif command -v clewmap >/dev/null 2>&1; then clewmap "$@"',
  ];
  if (fallback)
    lines.push(
      `    elif [ -f ${q(fallback.bin)} ]; then ${q(fallback.node)} ${q(fallback.bin)} "$@"`,
    );
  lines.push('    else return 127; fi', '  }');
  return lines.join('\n');
}

/** Блок clewmap для хука. sh без башизмов: работает и в Git Bash на Windows. */
export function hookBlock(hook: HookName, fallback: { node: string; bin: string } | null): string {
  const body =
    hook === 'pre-commit'
      ? [
          '  if _clewmap update --staged --quiet --timeout 5000 --hook pre-commit; then',
          '    git add -- .clewmap/ 2>/dev/null || true',
          '  else',
          '    echo "clewmap: graph not updated, the commit goes on (run: clewmap update)" >&2',
          '  fi',
        ]
      : ['  _clewmap summarize --background --quiet >/dev/null 2>&1 || true'];
  return [
    BEGIN,
    hook === 'pre-commit'
      ? '# Keeps .clewmap/ in sync with the staged code; with hooks.summarize = "pre-commit" also writes summaries. Never fails the commit. CLEWMAP_SKIP=1 turns it off.'
      : '# Writes summaries for changed code in a detached background process. CLEWMAP_SKIP=1 turns it off.',
    'if [ -z "$CLEWMAP_SKIP" ]; then',
    '  cd "$(git rev-parse --show-toplevel)" || exit 0',
    finder(fallback),
    ...body,
    'fi',
    END,
  ].join('\n');
}

/** Убирает блок clewmap из текста хука, чужое содержимое не трогает. */
export function stripBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  if (start === -1) return text;
  const endIdx = text.indexOf(END, start);
  if (endIdx === -1) return text;
  let after = text.slice(endIdx + END.length);
  if (after.startsWith('\n')) after = after.slice(1);
  let before = text.slice(0, start);
  before = before.replace(/\n+$/, before.trim() ? '\n' : '');
  return before + (before && after ? '\n' : '') + after;
}

/** Вставляет или заменяет блок clewmap. Новый файл получает шебанг. */
export function upsertBlock(text: string | null, block: string): string {
  if (text === null || !text.trim()) return `#!/bin/sh\n${block}\n`;
  const base = stripBlock(text).replace(/\n*$/, '\n');
  return `${base}\n${block}\n`;
}

/** Папка хуков: .husky/, если проект на husky; иначе то, что скажет git (учитывает core.hooksPath и worktree). */
export async function hooksDir(root: string): Promise<{ dir: string; husky: boolean }> {
  if (existsSync(path.join(root, '.husky'))) return { dir: path.join(root, '.husky'), husky: true };
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: root,
  });
  return { dir: path.resolve(root, stdout.trim()), husky: false };
}

export interface HookChange {
  hook: HookName;
  file: string;
  action: 'installed' | 'updated' | 'removed' | 'unchanged';
}

export async function installHooks(
  root: string,
  opts: { hooks?: readonly HookName[]; fallback?: { node: string; bin: string } | null } = {},
): Promise<HookChange[]> {
  const { dir, husky } = await hooksDir(root);
  await mkdir(dir, { recursive: true });
  // Файлы husky коммитятся, поэтому путь с этой машины туда не пишем.
  const fallback = husky ? null : (opts.fallback ?? null);
  const changes: HookChange[] = [];
  for (const hook of opts.hooks ?? (['pre-commit', 'post-commit'] as const)) {
    const file = path.join(dir, hook);
    const current = existsSync(file) ? await readFile(file, 'utf8') : null;
    const next = upsertBlock(current, hookBlock(hook, fallback));
    if (next !== current) await writeFile(file, next, 'utf8');
    await chmod(file, 0o755);
    changes.push({
      hook,
      file,
      action: current === next ? 'unchanged' : current?.includes(BEGIN) ? 'updated' : 'installed',
    });
  }
  return changes;
}

export async function uninstallHooks(root: string): Promise<HookChange[]> {
  const { dir } = await hooksDir(root);
  const changes: HookChange[] = [];
  for (const hook of ['pre-commit', 'post-commit'] as const) {
    const file = path.join(dir, hook);
    if (!existsSync(file)) continue;
    const current = await readFile(file, 'utf8');
    if (!current.includes(BEGIN)) continue;
    const rest = stripBlock(current);
    if (!rest.replace(/^#!.*\n?/, '').trim()) await rm(file);
    else await writeFile(file, rest, 'utf8');
    changes.push({ hook, file, action: 'removed' });
  }
  return changes;
}
