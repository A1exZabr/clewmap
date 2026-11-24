import type { ModuleFile } from './schema.js';

/** Что изменилось в модуле между двумя версиями графа. */
export interface ModuleDiff {
  file: string;
  /** Новые символы (id, которого не было). */
  added: string[];
  /** Удалённые символы. */
  removed: string[];
  /** Код символа поменялся (другой bodyHash). */
  bodyChanged: string[];
  /** Сигнатура поменялась (другой signatureHash): вызывающим нужно пометить описание устаревшим. */
  signatureChanged: string[];
}

/** Сравнивает старую и новую версии модуля. null — модуля нет (новый или удалённый файл). */
export function diffModules(prev: ModuleFile | null, next: ModuleFile | null): ModuleDiff {
  const file = next?.file ?? prev?.file ?? '';
  const before = new Map((prev?.symbols ?? []).map((s) => [s.id, s]));
  const after = new Map((next?.symbols ?? []).map((s) => [s.id, s]));
  const diff: ModuleDiff = { file, added: [], removed: [], bodyChanged: [], signatureChanged: [] };
  for (const [id, s] of after) {
    const old = before.get(id);
    if (!old) {
      diff.added.push(id);
      continue;
    }
    if (old.bodyHash !== s.bodyHash) diff.bodyChanged.push(id);
    if (old.signatureHash !== s.signatureHash) diff.signatureChanged.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) diff.removed.push(id);
  for (const list of [diff.added, diff.removed, diff.bodyChanged, diff.signatureChanged])
    list.sort();
  return diff;
}

export function isEmptyDiff(d: ModuleDiff): boolean {
  return (
    !d.added.length && !d.removed.length && !d.bodyChanged.length && !d.signatureChanged.length
  );
}
