import type { CallEdge, Config, GraphIndex, IncomingEdge, SymbolNode } from '@clewmap/core';
import { isExternalSdk } from '@clewmap/indexer';
import { symbolAtLine, type DocModel, type LocatedSymbol } from './locate.js';

/** Перевод строк интерфейса: vscode.l10n.t в расширении, простая подстановка {0} в тестах. */
export type Translate = (message: string, ...args: (string | number)[]) => string;

export const plainT: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));

export interface LayerInfo {
  key: string;
  label: string;
  color: string;
}

export const DEFAULT_LAYER_STYLE: Record<string, { label: string; color: string }> = {
  handler: { label: 'Handler', color: '#5AA9F5' },
  service: { label: 'Service', color: '#F2A65A' },
  data: { label: 'Data', color: '#6FD69A' },
  external: { label: 'External API', color: '#E58AD8' },
};

/** Слои из конфига плюс стандартные цвета для слоёв, которые индексатор ставит сам (external). */
export function layersOf(config: Config | null): Map<string, LayerInfo> {
  const out = new Map<string, LayerInfo>();
  for (const [key, l] of Object.entries(config?.layers ?? {}))
    out.set(key, { key, label: l.label, color: l.color });
  for (const [key, l] of Object.entries(DEFAULT_LAYER_STYLE))
    if (!out.has(key)) out.set(key, { key, ...l });
  return out;
}

/** "src/services/pricing.py#Cart.total~2" → "Cart.total". */
export function qualifiedOf(id: string): string {
  const hash = id.indexOf('#');
  const q = hash === -1 ? id : id.slice(hash + 1);
  return q.replace(/~\d+$/, '');
}

/** Короткое имя для подписи: последний сегмент. */
export function shortName(id: string): string {
  if (id.startsWith('external:')) return id.slice('external:'.length);
  return qualifiedOf(id).split('.').pop()!;
}

/** Подпись узла: "orders_repo.save" для функций модулей, "Cart.total" для методов. */
export function displayName(id: string, index?: GraphIndex, contextFile?: string): string {
  if (id.startsWith('external:')) return id.slice('external:'.length);
  const q = qualifiedOf(id);
  if (q.includes('.')) return q;
  const file = index?.fileOfSymbol(id) ?? id.slice(0, id.indexOf('#'));
  if (contextFile && file === contextFile) return q;
  const mod = file
    .split('/')
    .pop()!
    .replace(/\.(py|tsx?|jsx?|mjs|cjs)$/, '');
  const node = index?.get(id);
  // Обработчики и компоненты узнаются по имени, служебные функции — с именем модуля.
  if (node && (node.layer === 'handler' || node.entry)) return q;
  return mod && mod !== 'index' && mod !== '__init__' ? `${mod}.${q}` : q;
}

export function fileOfId(id: string): string {
  const hash = id.indexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

export function baseName(file: string): string {
  return file.split('/').pop()!;
}

/** Слой, в который ведёт связь: слой вызываемого символа, а для внешних SDK — external. */
export function edgeLayer(edge: CallEdge, index: GraphIndex): string | null {
  if (edge.resolved) return index.get(edge.target)?.layer ?? null;
  if (isExternalSdk(edge.target)) return 'external';
  return null;
}

/** Описание актуально: написано для этого кода. */
export function validSummary(node: SymbolNode): string | null {
  return node.summary && node.summary.forBodyHash === node.bodyHash ? node.summary.text : null;
}

export function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Связь, найденная по позиции в документе. */
export interface EdgeHit {
  from: LocatedSymbol;
  edge: CallEdge;
  /** Строка связи в документе. */
  line: number;
}

/** Связи символа со строками, пересчитанными на текущий текст. Только для неизменённых символов. */
export function edgesOf(sym: LocatedSymbol): EdgeHit[] {
  if (!sym.fresh) return [];
  return sym.node.calls.map((edge) => ({ from: sym, edge, line: edge.line + sym.delta }));
}

/** Все связи на строке: у самого вложенного символа, в котором лежит строка. */
export function edgesOnLine(model: DocModel, line: number): EdgeHit[] {
  const sym = symbolAtLine(model, line);
  if (!sym) return [];
  return edgesOf(sym).filter((h) => h.line === line);
}

/**
 * Вызов под курсором: связь на этой строке, у которой имя цели совпадает со словом.
 * Если символ правили (строки не сходятся), ищем связь с таким именем по всему символу.
 */
export function callUnderCursor(model: DocModel, line: number, word: string): EdgeHit | null {
  const sym = symbolAtLine(model, line);
  if (!sym || !word) return null;
  const matches = (e: CallEdge) => {
    if (!e.resolved && !e.target.startsWith('external:')) return false;
    const q = e.resolved ? qualifiedOf(e.target) : e.target.slice('external:'.length);
    return q === word || q.split('.').pop() === word;
  };
  if (sym.fresh) {
    const onLine = sym.node.calls.find((e) => e.line + sym.delta === line && matches(e));
    if (onLine) return { from: sym, edge: onLine, line };
    return null;
  }
  const any = sym.node.calls.find((e) => e.resolved && matches(e));
  return any ? { from: sym, edge: any, line } : null;
}

/** Связь через границу (запрос к API, кнопка бота) на строке: на неё ведёт F12. */
export function linkOnLine(model: DocModel, line: number): EdgeHit | null {
  return (
    edgesOnLine(model, line).find(
      (h) => (h.edge.kind === 'http' || h.edge.kind === 'event') && h.edge.resolved,
    ) ?? null
  );
}

/** Входящие связи через границу: кнопки и запросы, которые ведут в обработчик. */
export function incomingLinks(index: GraphIndex, id: string): IncomingEdge[] {
  return index.callersOf(id).filter((e) => e.kind === 'http' || e.kind === 'event');
}

/** Исходящие связи через границу. */
export function outgoingLinks(node: SymbolNode): CallEdge[] {
  return node.calls.filter((e) => e.kind === 'http' || e.kind === 'event');
}

/** Уникальные вызывающие (символ может вызывать несколько раз). */
export function uniqueCallers(index: GraphIndex, id: string): IncomingEdge[] {
  const seen = new Set<string>();
  return index.callersOf(id).filter((e) => (seen.has(e.from) ? false : (seen.add(e.from), true)));
}

/** Уникальные вызываемые символы репозитория по порядку вызова. */
export function uniqueCallees(node: SymbolNode): CallEdge[] {
  const seen = new Set<string>();
  return node.calls
    .filter((e) => e.resolved)
    .filter((e) => (seen.has(e.target) ? false : (seen.add(e.target), true)));
}
