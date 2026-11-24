import { normalizeBody, sha256, type ModuleFile, type Range, type SymbolNode } from '@clewmap/core';
import { extractFile } from '@clewmap/indexer';

/** Символ графа, найденный в текущем тексте документа. */
export interface LocatedSymbol {
  node: SymbolNode;
  /** Где символ сейчас в документе (0-based). */
  range: Range;
  /** На сколько строк символ сдвинулся относительно графа: к строкам связей и блоков прибавлять его. */
  delta: number;
  /**
   * Код символа тот же, что в графе (bodyHash совпал): описание, блоки и строки вызовов верны.
   * false — символ правили после обновления графа: показываем описание с пометкой, а построчное не рисуем.
   */
  fresh: boolean;
}

export interface DocModel {
  file: string;
  /** Файл совпадает с графом байт в байт (fileHash): позиции берутся прямо из графа. */
  exact: boolean;
  /** Граф отстаёт от текста: какой-то символ изменён, удалён или добавлен. */
  stale: boolean;
  /** Символы по порядку начала. */
  symbols: LocatedSymbol[];
}

const byStart = (a: LocatedSymbol, b: LocatedSymbol) =>
  a.range.start[0] - b.range.start[0] || a.range.start[1] - b.range.start[1];

/** Модель, когда текст совпадает с графом. */
export function exactModel(module: ModuleFile): DocModel {
  return {
    file: module.file,
    exact: true,
    stale: false,
    symbols: module.symbols
      .map((node) => ({ node, range: node.range, delta: 0, fresh: true }))
      .sort(byStart),
  };
}

/** Пустая модель: файла нет в графе. */
export function emptyModel(file: string): DocModel {
  return { file, exact: false, stale: false, symbols: [] };
}

/**
 * Сопоставляет символы графа с текущим текстом документа.
 *
 * Если текст совпадает с графом, позиции берутся из графа. Иначе текст заново разбирается tree-sitter
 * (как это делает индексатор), символы сопоставляются по id (файл + имя, `~2` для повторов), а по bodyHash
 * видно, остался ли код символа прежним. Номерам строк из графа при правках не верим: функция могла
 * уехать вниз, и описание оказалось бы над чужим кодом.
 */
export async function locateInText(module: ModuleFile, text: string): Promise<DocModel> {
  if (sha256(text) === module.fileHash) return exactModel(module);
  const raw = await extractFile(module.file, text).catch(() => null);
  if (!raw) return { file: module.file, exact: false, stale: true, symbols: [] };

  const current = new Map<string, { range: Range; bodyHash: string }>();
  const used = new Set<string>();
  for (const s of raw.symbols) {
    let id = `${module.file}#${s.qualified}`;
    for (let n = 2; used.has(id); n++) id = `${module.file}#${s.qualified}~${n}`;
    used.add(id);
    current.set(id, { range: s.range, bodyHash: sha256(normalizeBody(s.body, raw.language)) });
  }

  let stale = current.size !== module.symbols.length;
  const symbols: LocatedSymbol[] = [];
  for (const node of module.symbols) {
    const now = current.get(node.id);
    if (!now) {
      stale = true;
      continue;
    }
    const fresh = now.bodyHash === node.bodyHash;
    if (!fresh) stale = true;
    symbols.push({
      node,
      range: now.range,
      delta: now.range.start[0] - node.range.start[0],
      fresh,
    });
  }
  return { file: module.file, exact: false, stale, symbols: symbols.sort(byStart) };
}

/** Самый вложенный символ, в котором лежит строка (метод внутри класса важнее класса). */
export function symbolAtLine(model: DocModel, line: number): LocatedSymbol | undefined {
  let best: LocatedSymbol | undefined;
  for (const s of model.symbols) {
    if (line < s.range.start[0] || line > s.range.end[0]) continue;
    if (!best || s.range.end[0] - s.range.start[0] < best.range.end[0] - best.range.start[0])
      best = s;
  }
  return best;
}

/** Строка, на которой стоит имя символа: после декораторов и `export`, там, где `def`/`function`/`class`. */
export function nameLine(sym: LocatedSymbol, lines: readonly string[]): number {
  const name = sym.node.name.split('.').pop()!;
  for (let l = sym.range.start[0]; l <= Math.min(sym.range.end[0], sym.range.start[0] + 20); l++) {
    const text = lines[l] ?? '';
    if (text.trimStart().startsWith('@')) continue;
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text)) return l;
  }
  return sym.range.start[0];
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
