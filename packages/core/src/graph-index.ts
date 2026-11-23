import type { CallEdge, ModuleFile, SymbolNode } from './schema.js';

/** Входящая связь: кто вызывает символ. Строится в памяти из исходящих связей. */
export interface IncomingEdge {
  from: string;
  line: number;
  kind: CallEdge['kind'];
  via?: string;
}

export interface ImpactItem {
  id: string;
  depth: number;
}

/**
 * Индекс графа в памяти: все символы по id, обратные связи, поиск по строке.
 * На диске хранятся только исходящие связи — calledBy собирается здесь.
 */
export class GraphIndex {
  readonly symbols = new Map<string, SymbolNode>();
  readonly modules = new Map<string, ModuleFile>();
  readonly calledBy = new Map<string, IncomingEdge[]>();
  private readonly fileOf = new Map<string, string>();

  constructor(modules: Iterable<ModuleFile>) {
    for (const m of modules) {
      this.modules.set(m.file, m);
      for (const s of m.symbols) {
        this.symbols.set(s.id, s);
        this.fileOf.set(s.id, m.file);
      }
    }
    for (const s of this.symbols.values()) {
      for (const edge of s.calls) {
        if (!edge.resolved) continue;
        const list = this.calledBy.get(edge.target) ?? [];
        const incoming: IncomingEdge = { from: s.id, line: edge.line, kind: edge.kind };
        if (edge.via !== undefined) incoming.via = edge.via;
        list.push(incoming);
        this.calledBy.set(edge.target, list);
      }
    }
    for (const list of this.calledBy.values()) {
      list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line));
    }
  }

  get(id: string): SymbolNode | undefined {
    return this.symbols.get(id);
  }

  fileOfSymbol(id: string): string | undefined {
    return this.fileOf.get(id);
  }

  callersOf(id: string): IncomingEdge[] {
    return this.calledBy.get(id) ?? [];
  }

  /** Самый вложенный символ, в диапазон которого попадает строка (0-based). Метод внутри класса важнее класса. */
  symbolAt(file: string, line: number): SymbolNode | undefined {
    const m = this.modules.get(file);
    if (!m) return undefined;
    let best: SymbolNode | undefined;
    for (const s of m.symbols) {
      if (line < s.range.start[0] || line > s.range.end[0]) continue;
      if (!best || s.range.end[0] - s.range.start[0] < best.range.end[0] - best.range.start[0])
        best = s;
    }
    return best;
  }

  /** Соседи на глубину depth: кого вызывает символ и кто вызывает его. */
  neighbors(id: string, depth = 1): { callees: Set<string>; callers: Set<string> } {
    const walk = (next: (x: string) => string[]): Set<string> => {
      const seen = new Set<string>();
      let frontier = [id];
      for (let d = 0; d < depth && frontier.length; d++) {
        const nextFrontier: string[] = [];
        for (const cur of frontier) {
          for (const n of next(cur)) {
            if (n === id || seen.has(n)) continue;
            seen.add(n);
            nextFrontier.push(n);
          }
        }
        frontier = nextFrontier;
      }
      return seen;
    };
    return {
      callees: walk((x) =>
        (this.symbols.get(x)?.calls ?? []).filter((e) => e.resolved).map((e) => e.target),
      ),
      callers: walk((x) => this.callersOf(x).map((e) => e.from)),
    };
  }

  /** Что может сломаться: транзитивные вызывающие с глубиной, по возрастанию глубины. */
  impact(ids: Iterable<string>, maxDepth = 5): ImpactItem[] {
    const start = new Set(ids);
    const depthOf = new Map<string, number>();
    let frontier = [...start];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const nextFrontier: string[] = [];
      for (const cur of frontier) {
        for (const e of this.callersOf(cur)) {
          if (start.has(e.from) || depthOf.has(e.from)) continue;
          depthOf.set(e.from, d);
          nextFrontier.push(e.from);
        }
      }
      frontier = nextFrontier;
    }
    return [...depthOf]
      .map(([id, depth]) => ({ id, depth }))
      .sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
