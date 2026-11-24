import type { GraphIndex } from '@clewmap/core';

/**
 * Уровень символа в графе вызовов среди выбранных: листья — 0, вызывающий — на 1 выше
 * самого высокого вызываемого. Циклы рвутся: символ, который уже на стеке, считается листом.
 */
export function callLevels(ids: readonly string[], index: GraphIndex): Map<string, number> {
  const wanted = new Set(ids);
  const level = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (onStack.has(id)) return 0;
    onStack.add(id);
    let l = 0;
    for (const e of index.get(id)?.calls ?? []) {
      if (!e.resolved || e.target === id || !wanted.has(e.target)) continue;
      l = Math.max(l, visit(e.target) + 1);
    }
    onStack.delete(id);
    level.set(id, l);
    return l;
  };
  for (const id of [...ids].sort()) visit(id);
  return level;
}

/** Порядок обработки снизу вверх: листья первыми, чтобы у вызывающих уже были описания вызываемых. */
export function bottomUpOrder(ids: readonly string[], index: GraphIndex): string[] {
  const level = callLevels(ids, index);
  return [...new Set(ids)].sort(
    (a, b) => level.get(a)! - level.get(b)! || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * Пачки по batchSize. В одной пачке только символы одного уровня: вызывающий никогда
 * не попадает в пачку раньше своего вызываемого.
 */
export function makeBatches<T>(
  ordered: readonly T[],
  levelOf: (item: T) => number,
  batchSize: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentLevel = -1;
  for (const item of ordered) {
    const l = levelOf(item);
    if (current.length && (l !== currentLevel || current.length >= batchSize)) {
      batches.push(current);
      current = [];
    }
    currentLevel = l;
    current.push(item);
  }
  if (current.length) batches.push(current);
  return batches;
}
