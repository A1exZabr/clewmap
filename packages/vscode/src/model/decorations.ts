import type { CodeBlock, GraphIndex } from '@clewmap/core';
import { edgeLayer, edgesOf } from './graph.js';
import type { LastCommit } from './hover.js';
import type { DocModel, LocatedSymbol } from './locate.js';

/**
 * Цвет полосы для каждой строки с вызовом: слой вызываемого. Несколько вызовов на строке — слой первого.
 * Только для неизменённых символов: у правленых строки вызовов из графа уже не совпадают с текстом.
 */
export function lineLayers(model: DocModel, index: GraphIndex): Map<number, string> {
  const out = new Map<number, string>();
  // Вложенные символы (методы) идут после классов: их строки важнее, поэтому перезаписывают.
  const ordered = [...model.symbols].sort(
    (a, b) =>
      b.range.end[0] - b.range.start[0] - (a.range.end[0] - a.range.start[0]) ||
      a.range.start[0] - b.range.start[0],
  );
  for (const sym of ordered) {
    const own = new Map<number, string>();
    for (const hit of edgesOf(sym)) {
      if (own.has(hit.line)) continue;
      const layer = edgeLayer(hit.edge, index);
      if (layer) own.set(hit.line, layer);
    }
    for (const [line, layer] of own) out.set(line, layer);
  }
  return out;
}

/**
 * Строки, которые задел последний коммит: строка с именем изменённого символа
 * и строки, где вызывается изменённый символ (как в макете: «Δ» у вызова apply_promo).
 */
export function changedLines(
  model: DocModel,
  lastCommit: LastCommit | null,
  nameLineOf: (sym: LocatedSymbol) => number,
): Set<number> {
  const out = new Set<number>();
  if (!lastCommit?.changed.size) return out;
  for (const sym of model.symbols) {
    if (lastCommit.changed.has(sym.node.id)) out.add(nameLineOf(sym));
    for (const hit of edgesOf(sym))
      if (hit.edge.resolved && lastCommit.changed.has(hit.edge.target)) out.add(hit.line);
  }
  return out;
}

export interface BlockSpan {
  owner: LocatedSymbol;
  block: CodeBlock;
  index: number;
  total: number;
  startLine: number;
  endLine: number;
}

/** Смысловые блоки с текущими строками. Только для функций, чей код не менялся с описания блоков. */
export function blockSpans(model: DocModel): BlockSpan[] {
  const out: BlockSpan[] = [];
  for (const sym of model.symbols) {
    const blocks = sym.node.blocks;
    if (!sym.fresh || !blocks?.length) continue;
    if (!blocks.every((b) => b.forBodyHash === sym.node.bodyHash)) continue;
    blocks.forEach((block, i) =>
      out.push({
        owner: sym,
        block,
        index: i,
        total: blocks.length,
        startLine: block.range.start[0] + sym.delta,
        endLine: block.range.end[0] + sym.delta,
      }),
    );
  }
  return out;
}

/** Блок, в котором лежит строка (самый вложенный, если функции вложены). */
export function blockAt(spans: readonly BlockSpan[], line: number): BlockSpan | undefined {
  let best: BlockSpan | undefined;
  for (const s of spans)
    if (
      line >= s.startLine &&
      line <= s.endLine &&
      (!best || s.endLine - s.startLine < best.endLine - best.startLine)
    )
      best = s;
  return best;
}
