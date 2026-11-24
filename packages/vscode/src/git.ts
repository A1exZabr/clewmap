import { execFile } from 'node:child_process';
import type { ModuleFile } from '@clewmap/core';
import type { LastCommit } from './model/hover.js';
import { changesBetween } from './model/impact.js';

/** git с массивом аргументов, без shell. null — git нет, не репозиторий или команда упала. */
export function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

export async function headInfo(root: string): Promise<{ sha: string; subject: string } | null> {
  const out = await git(root, ['log', '-1', '--format=%H%x00%s']);
  if (!out) return null;
  const [sha, subject] = out.trim().split('\0');
  return sha ? { sha, subject: subject ?? '' } : null;
}

async function moduleAt(root: string, rev: string, file: string): Promise<ModuleFile | null> {
  const text = await git(root, ['show', `${rev}:${file}`]);
  if (!text) return null;
  try {
    return JSON.parse(text) as ModuleFile;
  } catch {
    return null;
  }
}

/**
 * Что поменял коммит: сравниваем модули графа до и после него. Граф лежит в git рядом с кодом,
 * поэтому разбирать сам код не нужно: хватает bodyHash и signatureHash из двух версий JSON.
 */
export async function commitChanges(root: string, sha: string): Promise<LastCommit['changed']> {
  const list = await git(root, [
    'diff',
    '--name-only',
    '-z',
    `${sha}~1`,
    sha,
    '--',
    '.clewmap/modules',
  ]);
  if (!list) return new Map();
  const files = list.split('\0').filter((f) => f.endsWith('.json'));
  const pairs = await Promise.all(
    files.map(async (f) => ({
      before: await moduleAt(root, `${sha}~1`, f),
      after: await moduleAt(root, sha, f),
    })),
  );
  return changesBetween(pairs);
}
