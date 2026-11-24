import type { GraphIndex } from '@clewmap/core';

export interface ChangedRange {
  file: string;
  /** Строки старой версии файла (0-based, включительно): граф описывает именно её. */
  start: number;
  end: number;
}

/**
 * Разбирает unified diff (`git diff`, `git diff --cached`, патч из PR). Берём строки СТАРОЙ стороны:
 * граф обновлялся до этих правок, поэтому символы ищутся по его номерам строк.
 * Добавление без удалённых строк привязываем к строке, после которой вставили.
 */
export function parseUnifiedDiff(diff: string): ChangedRange[] {
  const out: ChangedRange[] = [];
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^a\//, '');
      continue;
    }
    // Строка «+++» — новая сторона; у нового файла старой нет («--- /dev/null»), и в графе его ещё нет.
    if (line.startsWith('+++ ')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0)
        out.push({ file, start: Math.max(0, start - 1), end: Math.max(0, start - 1) });
      else out.push({ file, start: start - 1, end: start - 1 + count - 1 });
    }
  }
  return out;
}

/** Символы, чьи строки задевают изменённые диапазоны. Метод важнее класса, в котором он лежит. */
export function symbolsInRanges(index: GraphIndex, ranges: readonly ChangedRange[]): string[] {
  const out = new Set<string>();
  for (const r of ranges) {
    const m = index.modules.get(r.file);
    if (!m) continue;
    const hits = m.symbols.filter((s) => s.range.start[0] <= r.end && s.range.end[0] >= r.start);
    for (const s of hits) {
      const inner = hits.some(
        (o) =>
          o !== s &&
          o.range.start[0] >= s.range.start[0] &&
          o.range.end[0] <= s.range.end[0] &&
          o.range.start[0] <= r.end &&
          o.range.end[0] >= r.start,
      );
      // Класс считаем изменённым, только если правка не целиком внутри одного из его методов.
      if (!inner || s.kind !== 'class') out.add(s.id);
    }
  }
  return [...out].sort();
}
