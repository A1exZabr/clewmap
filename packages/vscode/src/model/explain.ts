import type { GraphIndex } from '@clewmap/core';
import type { ExplainContext, ExplainNeighbor } from '@clewmap/summarizer';
import { validSummary } from './graph.js';

/** Узкий контекст для «Объяснить подробнее»: код символа, соседи на 1–2 шага с описаниями, описание модуля. */
export function explainContext(index: GraphIndex, id: string, code: string): ExplainContext | null {
  const node = index.get(id);
  if (!node) return null;
  const file = index.fileOfSymbol(id)!;
  const module = index.modules.get(file);
  const neighbors: ExplainNeighbor[] = [];
  const add = (nid: string, relation: ExplainNeighbor['relation'], depth: number, via?: string) => {
    if (nid === id || neighbors.some((n) => n.id === nid && n.relation === relation)) return;
    const n = index.get(nid);
    if (!n) return;
    const item: ExplainNeighbor = {
      id: nid,
      name: n.name,
      relation,
      depth,
      summary: validSummary(n),
    };
    if (via) item.via = via;
    neighbors.push(item);
  };
  for (const e of node.calls) if (e.resolved) add(e.target, 'calls', 1, e.via);
  for (const e of index.callersOf(id)) add(e.from, 'calledBy', 1, e.via);
  for (const first of [...neighbors]) {
    if (first.relation === 'calls') {
      for (const e of index.get(first.id)?.calls ?? [])
        if (e.resolved) add(e.target, 'calls', 2, e.via);
    } else {
      for (const e of index.callersOf(first.id)) add(e.from, 'calledBy', 2, e.via);
    }
  }
  return {
    id,
    name: node.name,
    kind: node.kind,
    file,
    layer: node.layer,
    signature: node.signature,
    codeLanguage: module?.language ?? 'unknown',
    code,
    summary: validSummary(node),
    moduleSummary: module?.summary?.text ?? null,
    blocks:
      node.blocks && node.blocks.every((b) => b.forBodyHash === node.bodyHash)
        ? node.blocks.map((b) => ({ label: b.label, text: b.text }))
        : null,
    neighbors: neighbors.slice(0, 40),
  };
}
