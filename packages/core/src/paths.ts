import path from 'node:path';

/** Папка графа в корне репозитория. */
export const CLEWMAP_DIR = '.clewmap';
export const MODULES_DIR = 'modules';
export const MANIFEST_FILE = 'manifest.json';
export const CONFIG_FILE = 'clewmap.config.json';

/** Приводит путь к виду с прямыми слэшами и без ведущего "./". */
export function toPosix(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Путь исходника от корня репо → путь JSON модуля от корня репо. */
export function moduleJsonPath(file: string): string {
  return `${CLEWMAP_DIR}/${MODULES_DIR}/${toPosix(file)}.json`;
}

/** Путь JSON модуля (от корня репо или от папки modules/) → путь исходника. */
export function sourcePathFromModuleJson(jsonPath: string): string {
  let p = toPosix(jsonPath);
  const prefix = `${CLEWMAP_DIR}/${MODULES_DIR}/`;
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  if (!p.endsWith('.json')) throw new Error(`not a module json: ${jsonPath}`);
  return p.slice(0, -'.json'.length);
}

/** Абсолютный путь к файлу внутри репо по относительному posix-пути. */
export function absPath(root: string, rel: string): string {
  return path.join(root, ...toPosix(rel).split('/'));
}

/** Относительный posix-путь от корня репо. */
export function relPath(root: string, abs: string): string {
  return toPosix(path.relative(root, abs));
}
