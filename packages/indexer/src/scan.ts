import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { matchAny, toPosix, type Config } from '@clewmap/core';
import { grammarFor } from './indexFile.js';

const execFileAsync = promisify(execFile);

/** Папки, которые не индексируются никогда. */
const ALWAYS_SKIP = new Set([
  '.git',
  '.clewmap',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  'site-packages',
]);

export const MAX_FILE_BYTES = 1024 * 1024;

function skippedDir(rel: string): boolean {
  return rel.split('/').some((seg) => ALWAYS_SKIP.has(seg));
}

/** Список файлов от git: отслеживаемые и новые, без игнорируемых по .gitignore. null — не репозиторий. */
async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: root,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    return stdout.split('\0').filter(Boolean).map(toPosix);
  } catch {
    return null;
  }
}

/** Простой разбор корневого .gitignore для каталогов вне git. */
async function gitignoreGlobs(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/');
    line = line.replace(/^\/+/, '').replace(/\/+$/, '');
    const base = anchored || line.includes('/') ? line : `**/${line}`;
    globs.push(base, `${base}/**`);
  }
  return globs;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ALWAYS_SKIP.has(e.name)) await visit(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await visit(root, '');
  return out;
}

/** Подходит ли файл для индексации по языку, служебным папкам и include/exclude. */
export function isIndexable(file: string, config: Config): boolean {
  if (skippedDir(file) || !grammarFor(file)) return false;
  if (config.include.length && !matchAny(file, config.include)) return false;
  return !matchAny(file, config.exclude);
}

/**
 * Исходники для индексации: учитывает .gitignore, include/exclude из конфига и поддерживаемые языки.
 * `staged` — только файлы из индекса git (то, что войдёт в коммит), без проверки рабочей копии.
 */
export async function scanFiles(
  root: string,
  config: Config,
  opts: { staged?: readonly string[] } = {},
): Promise<string[]> {
  if (opts.staged) return [...new Set(opts.staged.filter((f) => isIndexable(f, config)))].sort();
  let files = await gitFiles(root);
  let ignore: string[] = [];
  if (files === null) {
    files = await walk(root);
    ignore = await gitignoreGlobs(root);
  }
  const result: string[] = [];
  for (const file of files) {
    if (!isIndexable(file, config)) continue;
    if (ignore.length && matchAny(file, ignore)) continue;
    try {
      const st = await stat(path.join(root, file));
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    } catch {
      continue; // удалён из рабочей копии, но ещё в индексе git
    }
    result.push(file);
  }
  return [...new Set(result)].sort();
}
