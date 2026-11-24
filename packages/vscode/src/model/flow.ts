import type { GraphIndex } from '@clewmap/core';

export interface FlowStep {
  id: string;
  /** -n — n шагов вверх к точке входа, 0 — сам символ, n — вниз к данным. */
  depth: number;
  /** Чем этот шаг связан с предыдущим: "POST /api/checkout" для запроса, "callback:checkout" для кнопки. */
  via?: string;
  kind: 'call' | 'http' | 'event' | 'self';
}

export interface Flow {
  root: string;
  /** Плоский путь: точка входа … символ … данные и внешние API. По нему ходят Alt+[ / Alt+]. */
  steps: FlowStep[];
  /** Индекс самого символа в steps. */
  current: number;
}

const MAX_UP = 8;
const MAX_DOWN = 4;

/**
 * Цепочка через символ: вверх — кратчайший путь к точке входа (маршрут, кнопка, команда бота, или
 * вызывающий без вызывающих — например, компонент с кнопкой на фронте); при равной длине предпочитаем
 * путь, который кончается настоящей точкой входа. Вниз — вызываемые в порядке вызова, в глубину до 4.
 */
export function buildFlow(index: GraphIndex, id: string): Flow {
  // Вверх: BFS по вызывающим.
  const parent = new Map<string, { next: string; via?: string; kind: FlowStep['kind'] }>();
  const seen = new Set([id]);
  let frontier = [id];
  let root = id;
  let found = Boolean(index.get(id)?.entry) || index.callersOf(id).length === 0;
  for (let d = 0; d < MAX_UP && frontier.length && !found; d++) {
    const next: string[] = [];
    let fallback: string | null = null;
    for (const cur of frontier) {
      for (const e of index.callersOf(cur)) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        parent.set(e.from, { next: cur, via: e.via, kind: e.kind });
        next.push(e.from);
        const caller = index.get(e.from);
        const isEntry = Boolean(caller?.entry);
        const isTop = index.callersOf(e.from).every((c) => seen.has(c.from));
        if (isEntry && !found) {
          root = e.from;
          found = true;
        } else if (isTop && fallback === null) fallback = e.from;
      }
    }
    if (!found && fallback !== null) {
      root = fallback;
      found = true;
    }
    frontier = next;
  }

  // Точка входа — не конец: если в неё ведёт кнопка или запрос с другой стороны, цепочка начинается там.
  for (let hops = 0; hops < 3; hops++) {
    const link = index
      .callersOf(root)
      .find((e) => (e.kind === 'http' || e.kind === 'event') && !seen.has(e.from));
    if (!link) break;
    seen.add(link.from);
    parent.set(link.from, { next: root, via: link.via, kind: link.kind });
    root = link.from;
  }

  // chain: от точки входа до вызывающего символа. parent.get(x) — ребро x → следующий шаг.
  const chain: string[] = [];
  for (let cur = root; cur !== id; cur = parent.get(cur)!.next) chain.push(cur);
  const all = [...chain, id];
  const steps: FlowStep[] = all.map((stepId, i) => {
    const step: FlowStep = {
      id: stepId,
      depth: i - chain.length,
      kind: stepId === id ? 'self' : 'call',
    };
    const edge = i > 0 ? parent.get(all[i - 1]!) : undefined;
    if (edge) {
      if (stepId !== id) step.kind = edge.kind;
      if (edge.via) step.via = edge.via;
    }
    return step;
  });

  // Вниз: DFS по вызываемым в порядке вызова.
  const down: FlowStep[] = [];
  const visited = new Set(all);
  const walk = (from: string, d: number) => {
    if (d > MAX_DOWN) return;
    for (const e of index.get(from)?.calls ?? []) {
      if (!e.resolved || visited.has(e.target)) continue;
      visited.add(e.target);
      const step: FlowStep = { id: e.target, depth: d, kind: e.kind };
      if (e.via) step.via = e.via;
      down.push(step);
      walk(e.target, d + 1);
    }
  };
  walk(id, 1);

  return { root, steps: [...steps, ...down], current: chain.length };
}
