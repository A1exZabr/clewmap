import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FORMAT_VERSION,
  GENERATOR,
  deleteModule,
  listModuleFiles,
  readConfig,
  readManifest,
  readModule,
  writeManifest,
  writeModule,
  type Config,
  type Language,
  type ModuleFile,
} from '@clewmap/core';
import type { RawModule } from './adapters/types.js';
import { carryOverSummaries, collectEntries, extractFile, indexFile } from './indexFile.js';
import { ProjectTable, TsConfigResolver } from './resolve.js';
import { scanFiles } from './scan.js';

const execFileAsync = promisify(execFile);

export interface BuildStats {
  files: number;
  symbols: number;
  edges: number;
  resolvedEdges: number;
  linkEdges: number;
  written: number;
  deleted: number;
  ms: number;
}

export async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Индексирует набор файлов целиком: извлечение → таблица проекта → связи → ModuleFile. Без записи на диск. */
export async function indexProject(
  root: string,
  files: readonly string[],
  config: Config,
): Promise<ModuleFile[]> {
  const raws: RawModule[] = [];
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    const raw = await extractFile(file, source, { httpClients: config.links.httpClients });
    if (raw) raws.push(raw);
  }
  const table = new ProjectTable(raws, TsConfigResolver.forRoot(root));
  const entries = collectEntries(table);
  return raws.map((raw) => indexFile(raw, table, entries, config));
}

/** Полная сборка графа: `clewmap build`. Повторный запуск без изменений кода не меняет ни байта. */
export async function buildGraph(
  root: string,
  opts: { config?: Config } = {},
): Promise<BuildStats> {
  const started = performance.now();
  const config = opts.config ?? (await readConfig(root));
  const files = await scanFiles(root, config);
  const modules = await indexProject(root, files, config);

  let written = 0;
  for (const m of modules) {
    const prev = await readModule(root, m.file).catch(() => null);
    if (await writeModule(root, carryOverSummaries(m, prev))) written++;
  }

  const present = new Set(modules.map((m) => m.file));
  let deleted = 0;
  for (const file of await listModuleFiles(root)) {
    if (!present.has(file)) {
      await deleteModule(root, file);
      deleted++;
    }
  }

  const languages = [...new Set(modules.map((m) => m.language))].sort() as Language[];
  const lastCommit = await gitHead(root);
  const prev = await readManifest(root).catch(() => null);
  const same =
    prev !== null &&
    written === 0 &&
    deleted === 0 &&
    prev.generator === GENERATOR &&
    prev.lastCommit === lastCommit &&
    prev.languages.join() === languages.join();
  await writeManifest(root, {
    formatVersion: FORMAT_VERSION,
    generator: GENERATOR,
    languages,
    lastCommit,
    updatedAt: same ? prev.updatedAt : new Date().toISOString(),
  });

  let symbols = 0;
  let edges = 0;
  let resolvedEdges = 0;
  let linkEdges = 0;
  for (const m of modules) {
    symbols += m.symbols.length;
    for (const s of m.symbols) {
      edges += s.calls.length;
      for (const e of s.calls) {
        if (e.resolved) resolvedEdges++;
        if (e.kind !== 'call' && e.resolved) linkEdges++;
      }
    }
  }
  return {
    files: modules.length,
    symbols,
    edges,
    resolvedEdges,
    linkEdges,
    written,
    deleted,
    ms: Math.round(performance.now() - started),
  };
}
