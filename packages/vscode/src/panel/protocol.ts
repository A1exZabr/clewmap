// Общие типы расширения и панели (webview). Панель только рисует: всё считает расширение.

export type Tab = 'neighbors' | 'impact' | 'search' | 'flow' | 'explain';

export interface NodeVM {
  id: string;
  label: string;
  file: string;
  line: number;
  color: string | null;
  layerLabel: string | null;
  changed: boolean;
  summary: string | null;
  stale: boolean;
}

export interface NeighborsVM {
  center: string | null;
  depth: 1 | 2;
  /** col: -2, -1 — вызывающие; 0 — символ; 1, 2 — вызываемые. */
  nodes: (NodeVM & { col: number })[];
  edges: { from: string; to: string; kind: 'call' | 'http' | 'event'; via?: string }[];
}

export interface ImpactVM {
  sha: string | null;
  subject: string;
  changed: (NodeVM & { kind: 'added' | 'body' | 'signature' })[];
  affected: (NodeVM & { depth: number })[];
  stale: NodeVM[];
  missing: number;
}

export interface FlowVM {
  steps: (NodeVM & { depth: number; kind: 'call' | 'http' | 'event' | 'self'; via?: string })[];
  current: number;
}

export interface ExplainVM {
  id: string;
  title: string;
  status: 'loading' | 'done' | 'error';
  text: string;
  model?: string;
  cached?: boolean;
}

export interface PanelState {
  strings: Record<string, string>;
  tab: Tab;
  hasGraph: boolean;
  status: { fresh: boolean; outdated: number; sha: string | null };
  legend: { label: string; color: string }[];
  neighbors: NeighborsVM;
  impact: ImpactVM;
  flow: FlowVM | null;
  search: { query: string; hits: (NodeVM & { bySummary: boolean })[] };
  explain: ExplainVM | null;
}

export type ToPanel = { type: 'state'; state: PanelState };

export type FromPanel =
  | { type: 'ready' }
  | { type: 'open'; id: string; line?: number | null }
  | { type: 'focus'; id: string }
  | { type: 'tab'; tab: Tab }
  | { type: 'depth'; depth: 1 | 2 }
  | { type: 'search'; query: string }
  | { type: 'explain'; id: string; force?: boolean }
  | { type: 'flow'; id: string };
