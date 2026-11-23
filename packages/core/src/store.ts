import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ManifestSchema,
  ModuleFileSchema,
  type CallEdge,
  type Manifest,
  type ModuleFile,
  type SymbolNode,
} from './schema.js';
import {
  CLEWMAP_DIR,
  MANIFEST_FILE,
  MODULES_DIR,
  absPath,
  moduleJsonPath,
  sourcePathFromModuleJson,
  toPosix,
} from './paths.js';

export interface Graph {
  manifest: Manifest | null;
  modules: ModuleFile[];
}

/** Ошибка чтения конкретного файла графа: битый JSON или несовпадение со схемой. */
export class GraphReadError extends Error {
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'GraphReadError';
  }
}

function compareRange(a: SymbolNode, b: SymbolNode): number {
  return (
    a.range.start[0] - b.range.start[0] ||
    a.range.start[1] - b.range.start[1] ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function compareEdge(a: CallEdge, b: CallEdge): number {
  if (a.line !== b.line) return a.line - b.line;
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const av = a.via ?? '';
  const bv = b.via ?? '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Канонический вид модуля: валидация, порядок ключей по схеме, отсортированные символы и связи. */
export function canonicalModule(module: ModuleFile): ModuleFile {
  const parsed = ModuleFileSchema.parse(module);
  parsed.file = toPosix(parsed.file);
  parsed.symbols = [...parsed.symbols].sort(compareRange).map((s) => ({
    ...s,
    calls: [...s.calls].sort(compareEdge),
  }));
  return ModuleFileSchema.parse(parsed);
}

/** Стабильная сериализация: одинаковые данные дают одинаковые байты. */
export function serializeModule(module: ModuleFile): string {
  return JSON.stringify(canonicalModule(module), null, 2) + '\n';
}

export function serializeManifest(manifest: Manifest): string {
  const parsed = ManifestSchema.parse(manifest);
  parsed.languages = [...new Set(parsed.languages)].sort();
  return JSON.stringify(parsed, null, 2) + '\n';
}

/** Пишет атомарно (temp + rename). Если содержимое не изменилось, файл не трогает. Возвращает true, если записал. */
async function writeAtomic(file: string, content: string): Promise<boolean> {
  try {
    if ((await readFile(file, 'utf8')) === content) return false;
  } catch {
    // файла нет — пишем
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
  return true;
}

export async function writeModule(root: string, module: ModuleFile): Promise<boolean> {
  return writeAtomic(absPath(root, moduleJsonPath(module.file)), serializeModule(module));
}

export async function deleteModule(root: string, file: string): Promise<void> {
  await rm(absPath(root, moduleJsonPath(file)), { force: true });
}

export async function writeManifest(root: string, manifest: Manifest): Promise<boolean> {
  return writeAtomic(path.join(root, CLEWMAP_DIR, MANIFEST_FILE), serializeManifest(manifest));
}

export async function readManifest(root: string): Promise<Manifest | null> {
  const file = path.join(root, CLEWMAP_DIR, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return ManifestSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new GraphReadError(`${CLEWMAP_DIR}/${MANIFEST_FILE}`, e);
  }
}

/** Пути исходников, для которых в .clewmap/modules/ лежит JSON. */
export async function listModuleFiles(root: string): Promise<string[]> {
  const base = path.join(root, CLEWMAP_DIR, MODULES_DIR);
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name.endsWith('.json'))
        out.push(sourcePathFromModuleJson(childRel));
    }
  }
  await walk(base, '');
  return out.sort();
}

export async function readModule(root: string, file: string): Promise<ModuleFile | null> {
  const rel = moduleJsonPath(file);
  let text: string;
  try {
    text = await readFile(absPath(root, rel), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return ModuleFileSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new GraphReadError(rel, e);
  }
}

export async function readGraph(root: string): Promise<Graph> {
  const manifest = await readManifest(root);
  const files = await listModuleFiles(root);
  const modules: ModuleFile[] = [];
  for (const file of files) {
    const m = await readModule(root, file);
    if (m) modules.push(m);
  }
  return { manifest, modules };
}
