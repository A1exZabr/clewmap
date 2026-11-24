import { mkdir, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLEWMAP_DIR, LOCK_FILE } from '@clewmap/core';

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export interface Lock {
  release(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockPath(root: string): string {
  return path.join(root, CLEWMAP_DIR, LOCK_FILE);
}

export async function readLock(root: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(lockPath(root), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** Протухшая блокировка: процесс умер (на этой машине) или держит её дольше staleMs. */
export function isStale(info: LockInfo | null, staleMs: number, now = Date.now()): boolean {
  if (!info || typeof info.pid !== 'number') return true;
  const age = now - Date.parse(info.startedAt);
  if (!Number.isFinite(age) || age > staleMs) return true;
  return info.host === os.hostname() && !alive(info.pid);
}

/**
 * Блокировка `.clewmap/.lock` (PID + время): одновременно работает только один summarize.
 * Возвращает null, если её держит живой процесс.
 */
export async function acquireLock(
  root: string,
  opts: { staleMs?: number } = {},
): Promise<Lock | null> {
  const file = lockPath(root);
  const staleMs = opts.staleMs ?? 2 * 60 * 60 * 1000;
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, 'wx');
      const info: LockInfo = {
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
      };
      await fh.writeFile(JSON.stringify(info) + '\n');
      await fh.close();
      return {
        release: async () => {
          const current = await readLock(root);
          if (current?.pid === process.pid && current.host === info.host)
            await rm(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!isStale(await readLock(root), staleMs)) return null;
      await rm(file, { force: true });
    }
  }
  return null;
}
