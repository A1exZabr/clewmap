import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  listModuleFiles,
  readConfig,
  readManifest,
  readModule,
  readQueue,
  sha256,
} from '@clewmap/core';
import { SUMMARIZABLE_KINDS } from './build.js';
import { gitHead } from './git.js';
import { scanFiles } from './scan.js';

export interface GraphStatus {
  /** .clewmap/ есть. */
  initialized: boolean;
  /** Граф совпадает с файлами на диске (по fileHash). */
  upToDate: boolean;
  lastCommit: string | null;
  head: string | null;
  /** Файлы, изменённые после обновления графа. */
  changed: string[];
  /** Новые файлы, которых нет в графе. */
  added: string[];
  /** Файлы из графа, которых больше нет. */
  removed: string[];
  symbols: number;
  withoutSummary: number;
  stale: number;
  queued: number;
}

/** Актуальность графа: сверка fileHash с файлами на диске и счётчики описаний. */
export async function graphStatus(root: string): Promise<GraphStatus> {
  const manifest = await readManifest(root);
  const empty: GraphStatus = {
    initialized: false,
    upToDate: false,
    lastCommit: null,
    head: null,
    changed: [],
    added: [],
    removed: [],
    symbols: 0,
    withoutSummary: 0,
    stale: 0,
    queued: 0,
  };
  if (!manifest) return empty;
  const config = await readConfig(root);
  const head = await gitHead(root);
  const files = await scanFiles(root, config);
  const known = new Set(await listModuleFiles(root));
  const changed: string[] = [];
  const added: string[] = [];
  let symbols = 0;
  let withoutSummary = 0;
  let stale = 0;
  for (const file of files) {
    if (!known.has(file)) {
      added.push(file);
      continue;
    }
    known.delete(file);
    const m = await readModule(root, file);
    if (!m) continue;
    if (m.fileHash !== sha256(await readFile(path.join(root, file), 'utf8'))) changed.push(file);
    for (const s of m.symbols) {
      symbols++;
      if (!SUMMARIZABLE_KINDS.has(s.kind)) continue;
      if (!s.summary) withoutSummary++;
      else if (s.summary.stale) stale++;
    }
  }
  const removed = [...known].sort();
  return {
    initialized: true,
    // Актуальность — по содержимому файлов: граф, обновлённый в pre-commit, хранит родительский коммит.
    upToDate: !changed.length && !added.length && !removed.length,
    lastCommit: manifest.lastCommit,
    head,
    changed,
    added,
    removed,
    symbols,
    withoutSummary,
    stale,
    queued: (await readQueue(root)).items.length,
  };
}
