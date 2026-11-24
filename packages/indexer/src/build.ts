import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CACHE_DIR,
  CLEWMAP_DIR,
  FORMAT_VERSION,
  GENERATOR,
  GraphIndex,
  deleteModule,
  dequeue,
  diffModules,
  enqueue,
  listModuleFiles,
  readConfig,
  readManifest,
  readModule,
  sha256,
  writeManifest,
  writeModule,
  type Config,
  type EnqueueInput,
  type Language,
  type ModuleDiff,
  type ModuleFile,
  type SymbolKind,
} from '@clewmap/core';
import type { RawModule } from './adapters/types.js';
import { blobOid, gitHead, readBlobs, stagedBlobs, stagedChanges, changesSince } from './git.js';
import { carryOverSummaries, collectEntries, extractFile, indexFile } from './indexFile.js';
import { ProjectTable, TsConfigResolver } from './resolve.js';
import { MAX_FILE_BYTES, scanFiles } from './scan.js';

export { gitHead } from './git.js';

/** Символы, которым нужны описания. Переменные модуля (router = APIRouter()) не описываются. */
export const SUMMARIZABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'class']);

/** Версия формата кэша разбора. Поднимать при любом изменении адаптеров. */
const RAW_CACHE_VERSION = 'raw-1';

export interface BuildStats {
  files: number;
  symbols: number;
  edges: number;
  resolvedEdges: number;
  linkEdges: number;
  written: number;
  deleted: number;
  /** Файлы, разобранные tree-sitter заново (остальные взяты из кэша). */
  parsed: number;
  renamed: number;
  /** Сколько символов добавлено в очередь описаний. */
  queued: number;
  /** Сколько описаний помечено устаревшими из-за смены сигнатуры вызываемого. */
  staleMarked: number;
  ms: number;
}

export interface SyncResult extends BuildStats {
  diffs: ModuleDiff[];
  modules: ModuleFile[];
}

export interface SyncOptions {
  config?: Config;
  /**
   * worktree — файлы рабочей копии (build, update без флагов);
   * staged — содержимое индекса git, то есть то, что войдёт в коммит (pre-commit).
   */
  source?: 'worktree' | 'staged';
  /** Явные переименования old → new (git diff -M). Переименования без правок находятся и сами. */
  renames?: ReadonlyMap<string, string>;
  /** Кэш разбора в .clewmap/.cache/raw/. По умолчанию включён. */
  cache?: boolean;
  /** Ставить ли задачи в очередь описаний. */
  queue?: boolean;
}

// ---------- кэш разбора ----------

interface CachedRaw {
  key: string;
  raw: Omit<RawModule, 'exports'> & { exports: [string, string][] };
}

function rawCachePath(root: string, file: string): string {
  return path.join(root, CLEWMAP_DIR, CACHE_DIR, 'raw', ...file.split('/')) + '.json';
}

function rawKey(fileHash: string, config: Config): string {
  return sha256(
    `${RAW_CACHE_VERSION}\0${GENERATOR}\0${config.links.httpClients.join(',')}\0${fileHash}`,
  );
}

async function readRawCache(root: string, file: string, key: string): Promise<RawModule | null> {
  try {
    const cached = JSON.parse(await readFile(rawCachePath(root, file), 'utf8')) as CachedRaw;
    if (cached.key !== key) return null;
    return { ...cached.raw, exports: new Map(cached.raw.exports) };
  } catch {
    return null;
  }
}

async function writeRawCache(root: string, raw: RawModule, key: string): Promise<void> {
  const file = rawCachePath(root, raw.file);
  const data: CachedRaw = { key, raw: { ...raw, exports: [...raw.exports] } };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  } catch {
    // кэш необязателен
  }
}

// ---------- источники файлов ----------

interface SourceSet {
  files: string[];
  read(file: string): Promise<string | null>;
}

async function worktreeSource(root: string, config: Config): Promise<SourceSet> {
  return {
    files: await scanFiles(root, config),
    read: (file) => readFile(path.join(root, file), 'utf8').catch(() => null),
  };
}

/** Содержимое индекса git. Совпадающие с рабочей копией файлы читаются с диска, остальные — из git. */
async function stagedSource(root: string, config: Config): Promise<SourceSet> {
  const blobs = await stagedBlobs(root);
  if (!blobs) return worktreeSource(root, config);
  const files = await scanFiles(root, config, { staged: [...blobs.keys()] });
  const contents = new Map<string, string>();
  const fromGit: string[] = [];
  for (const file of files) {
    const oid = blobs.get(file)!;
    try {
      const buf = await readFile(path.join(root, file));
      if (blobOid(buf) === oid) {
        contents.set(file, buf.toString('utf8'));
        continue;
      }
    } catch {
      // удалён из рабочей копии, но остался в индексе
    }
    fromGit.push(file);
  }
  const read = await readBlobs(
    root,
    fromGit.map((f) => blobs.get(f)!),
  );
  for (const file of fromGit) {
    const buf = read.get(blobs.get(file)!);
    if (buf && buf.length <= MAX_FILE_BYTES) contents.set(file, buf.toString('utf8'));
  }
  return {
    files: files.filter((f) => contents.has(f)),
    read: async (file) => contents.get(file) ?? null,
  };
}

// ---------- сборка ----------

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
  return linkProject(root, raws, config);
}

function linkProject(root: string, raws: RawModule[], config: Config): ModuleFile[] {
  const table = new ProjectTable(raws, TsConfigResolver.forRoot(root));
  const entries = collectEntries(table);
  return raws.map((raw) => indexFile(raw, table, entries, config));
}

/** Модуль со старым путём → тот же модуль под новым путём (id символов меняют префикс файла). */
function moveModule(m: ModuleFile, to: string): ModuleFile {
  const prefix = `${m.file}#`;
  return {
    ...m,
    file: to,
    symbols: m.symbols.map((s) => ({
      ...s,
      id: s.id.startsWith(prefix) ? `${to}#${s.id.slice(prefix.length)}` : s.id,
    })),
  };
}

/**
 * Синхронизирует .clewmap/ с кодом. Заново разбирает только изменившиеся файлы (кэш по fileHash),
 * но связи пересчитывает по всему проекту: так новое имя, переименованный или удалённый файл
 * сразу отражаются в модулях, которые на него ссылаются.
 */
export async function syncGraph(root: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const started = performance.now();
  const config = opts.config ?? (await readConfig(root));
  const useCache = opts.cache !== false;
  const src =
    opts.source === 'staged'
      ? await stagedSource(root, config)
      : await worktreeSource(root, config);

  const raws: RawModule[] = [];
  let parsed = 0;
  for (const file of src.files) {
    const source = await src.read(file);
    if (source === null) continue;
    const key = rawKey(sha256(source), config);
    let raw = useCache ? await readRawCache(root, file, key) : null;
    if (!raw) {
      raw = await extractFile(file, source, { httpClients: config.links.httpClients });
      if (!raw) continue;
      parsed++;
      if (useCache) await writeRawCache(root, raw, key);
    }
    raws.push(raw);
  }
  const next = linkProject(root, raws, config);

  // Прошлые версии модулей, в том числе под старыми путями при переименовании.
  const known = await listModuleFiles(root);
  const present = new Set(next.map((m) => m.file));
  const removedFiles = known.filter((f) => !present.has(f));
  const prevByFile = new Map<string, ModuleFile | null>();
  for (const m of next) prevByFile.set(m.file, await readModule(root, m.file).catch(() => null));
  const removedModules = new Map<string, ModuleFile>();
  for (const f of removedFiles) {
    const m = await readModule(root, f).catch(() => null);
    if (m) removedModules.set(f, m);
  }
  const renames = new Map<string, string>(); // new → old
  for (const [from, to] of opts.renames ?? []) {
    if (removedModules.has(from) && present.has(to) && !prevByFile.get(to)) renames.set(to, from);
  }
  const takenOld = new Set(renames.values());
  for (const m of next) {
    if (prevByFile.get(m.file) || renames.has(m.file)) continue;
    for (const [f, old] of removedModules) {
      if (!takenOld.has(f) && old.fileHash === m.fileHash) {
        renames.set(m.file, f);
        takenOld.add(f);
        break;
      }
    }
  }
  for (const [to, from] of renames) prevByFile.set(to, moveModule(removedModules.get(from)!, to));

  const merged = next.map((m) => carryOverSummaries(m, prevByFile.get(m.file) ?? null));
  const diffs: ModuleDiff[] = merged.map((m) => diffModules(prevByFile.get(m.file) ?? null, m));
  for (const [f, old] of removedModules) {
    if (!takenOld.has(f)) diffs.push(diffModules(old, null));
  }

  // Смена сигнатуры: описания вызывающих устарели.
  const index = new GraphIndex(merged);
  const toQueue: EnqueueInput[] = [];
  let staleMarked = 0;
  for (const d of diffs) {
    for (const id of d.signatureChanged) {
      for (const caller of index.callersOf(id)) {
        const s = index.get(caller.from);
        if (!s || !SUMMARIZABLE_KINDS.has(s.kind) || caller.from === id) continue;
        if (s.summary && !s.summary.stale) {
          s.summary = { ...s.summary, stale: true };
          staleMarked++;
        }
        toQueue.push({ id: s.id, priority: 'low', bodyHash: s.bodyHash });
      }
    }
  }
  // Новые и изменённые символы без описания — в очередь первыми.
  for (const s of index.symbols.values()) {
    if (SUMMARIZABLE_KINDS.has(s.kind) && !s.summary)
      toQueue.push({ id: s.id, priority: 'high', bodyHash: s.bodyHash });
  }

  let written = 0;
  for (const m of merged) if (await writeModule(root, m)) written++;
  let deleted = 0;
  for (const f of removedFiles) {
    await deleteModule(root, f);
    if (useCache) await rm(rawCachePath(root, f), { force: true });
    deleted++;
  }

  let queued = 0;
  if (opts.queue !== false) {
    const removedIds = new Map<string, string | null>();
    for (const d of diffs) for (const id of d.removed) removedIds.set(id, null);
    await dequeue(root, removedIds);
    queued = await enqueue(root, toQueue);
  }

  const languages = [...new Set(merged.map((m) => m.language))].sort() as Language[];
  const prevManifest = await readManifest(root).catch(() => null);
  const head = await gitHead(root);
  const same =
    prevManifest !== null &&
    written === 0 &&
    deleted === 0 &&
    prevManifest.generator === GENERATOR &&
    (prevManifest.lastCommit !== null || head === null) &&
    prevManifest.languages.join() === languages.join();
  if (!same) {
    await writeManifest(root, {
      formatVersion: FORMAT_VERSION,
      generator: GENERATOR,
      languages,
      lastCommit: head ?? prevManifest?.lastCommit ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  let symbols = 0;
  let edges = 0;
  let resolvedEdges = 0;
  let linkEdges = 0;
  for (const m of merged) {
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
    files: merged.length,
    symbols,
    edges,
    resolvedEdges,
    linkEdges,
    written,
    deleted,
    parsed,
    renamed: renames.size,
    queued,
    staleMarked,
    ms: Math.round(performance.now() - started),
    diffs,
    modules: merged,
  };
}

/** Полная сборка графа: `clewmap build`. Повторный запуск без изменений кода не меняет ни байта. */
export async function buildGraph(root: string, opts: SyncOptions = {}): Promise<SyncResult> {
  return syncGraph(root, opts);
}

export type UpdateMode =
  | { kind: 'worktree' }
  | { kind: 'staged' }
  | { kind: 'since'; ref: string }
  | { kind: 'files'; files: readonly string[] };

/**
 * `clewmap update`: то же, что build, но переименования берутся из git (-M),
 * а в режиме staged индексируется содержимое индекса git.
 */
export async function updateGraph(
  root: string,
  mode: UpdateMode,
  opts: Omit<SyncOptions, 'source' | 'renames'> = {},
): Promise<SyncResult> {
  const renames = new Map<string, string>();
  const changes =
    mode.kind === 'staged'
      ? await stagedChanges(root)
      : mode.kind === 'since'
        ? await changesSince(root, mode.ref)
        : [];
  for (const c of changes) if (c.status === 'R' && c.from) renames.set(c.from, c.file);
  return syncGraph(root, {
    ...opts,
    source: mode.kind === 'staged' ? 'staged' : 'worktree',
    renames,
  });
}
