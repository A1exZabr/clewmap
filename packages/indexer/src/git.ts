import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { toPosix } from '@clewmap/core';

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export async function gitHead(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/** Индекс git: путь → oid блоба (только stage 0, без конфликтов). null — не репозиторий. */
export async function stagedBlobs(root: string): Promise<Map<string, string> | null> {
  let out: string;
  try {
    out = await git(root, ['ls-files', '-s', '-z']);
  } catch {
    return null;
  }
  const map = new Map<string, string>();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [, oid, stage] = rec.slice(0, tab).split(' ');
    if (stage === '0' && oid) map.set(toPosix(rec.slice(tab + 1)), oid);
  }
  return map;
}

/** oid блоба git для содержимого: так можно сравнить рабочую копию с индексом, не запуская git. */
export function blobOid(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Читает блобы одним процессом `git cat-file --batch`. */
export function readBlobs(root: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  if (!unique.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
      const buf = Buffer.concat(chunks);
      const out = new Map<string, Buffer>();
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(10, pos);
        if (nl === -1) break;
        const header = buf.subarray(pos, nl).toString('utf8').split(' ');
        pos = nl + 1;
        if (header[1] === 'missing') continue;
        const size = Number(header[2]);
        out.set(header[0]!, buf.subarray(pos, pos + size));
        pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.end(unique.join('\n') + '\n');
  });
}

export interface NameStatus {
  status: string;
  file: string;
  from?: string;
}

function parseNameStatus(out: string): NameStatus[] {
  const parts = out.split('\0').filter(Boolean);
  const res: NameStatus[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = toPosix(parts[i++]!);
      const file = toPosix(parts[i++]!);
      res.push({ status: status[0]!, file, from });
    } else {
      res.push({ status: status[0]!, file: toPosix(parts[i++]!) });
    }
  }
  return res;
}

/** Изменения в индексе относительно HEAD, с переименованиями (-M). */
export async function stagedChanges(root: string): Promise<NameStatus[]> {
  try {
    const hasHead = (await gitHead(root)) !== null;
    const args = hasHead
      ? ['diff', '--cached', '--name-status', '-M', '-z']
      : ['diff', '--cached', '--name-status', '-z', '--root'];
    return parseNameStatus(await git(root, args));
  } catch {
    return [];
  }
}

/** Изменения рабочей копии относительно ref, с переименованиями (-M). */
export async function changesSince(root: string, ref: string): Promise<NameStatus[]> {
  return parseNameStatus(await git(root, ['diff', '--name-status', '-M', '-z', ref]));
}

/** Идёт ли сейчас rebase, merge или cherry-pick: в это время хуки ничего не делают. */
export async function gitBusy(root: string): Promise<boolean> {
  try {
    const dir = (await git(root, ['rev-parse', '--git-dir'])).trim();
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');
    const abs = path.resolve(root, dir);
    return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(
      (n) => existsSync(path.join(abs, n)),
    );
  } catch {
    return false;
  }
}
