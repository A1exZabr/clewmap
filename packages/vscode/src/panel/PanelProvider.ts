import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { GraphIndex } from '@clewmap/core';
import type { Explainer } from '../explainer.js';
import { buildFlow, type Flow } from '../model/flow.js';
import { displayName, validSummary } from '../model/graph.js';
import { impactView } from '../model/impact.js';
import { searchGraph } from '../model/search.js';
import type { GraphStore } from '../store.js';
import { t, type Workspace } from '../workspace.js';
import type { FromPanel, NeighborsVM, NodeVM, PanelState, Tab, ToPanel } from './protocol.js';

/** Строки интерфейса панели: переводятся здесь, панель получает готовые. */
function strings(): Record<string, string> {
  return {
    neighbors: t('Neighbors'),
    impact: t('Impact'),
    search: t('Search'),
    flow: t('Chain'),
    explain: t('Explanation'),
    callers: t('Called by'),
    symbol: t('Function'),
    callees: t('Calls'),
    depth: t('Depth'),
    fresh: t('graph is up to date'),
    behind: t('graph is behind: {0} file(s) changed'),
    noGraph: t('No .clewmap/ graph in this workspace. Run npx clewmap init --hooks.'),
    placeCursor: t('Put the cursor inside a function to see its neighbors.'),
    layers: t('Layers (stripe color)'),
    lastCommit: t('Last commit'),
    changedFns: t('Changed'),
    affected: t('Affected (callers, up to 3 steps)'),
    staleList: t('Summaries marked outdated'),
    missing: t('Without a summary: {0}'),
    nothingChanged: t('The last commit changed no functions.'),
    noCommit: t('No commits yet.'),
    searchPlaceholder: t('Name or words from a summary…'),
    noHits: t('Nothing found.'),
    bySummary: t('in summary'),
    flowHint: t('Alt+[ and Alt+] walk the chain in the editor.'),
    noFlow: t('Run “Clewmap: Show the chain” on a function.'),
    showFlow: t('Show the chain'),
    explainLoading: t('Asking the model…'),
    explainCached: t('From cache, written for this exact code'),
    explainAgain: t('Ask again'),
    explainFailed: t('Could not explain'),
    noExplain: t('Hover a function and choose “Explain in more depth”.'),
    added: t('added'),
    body: t('code changed'),
    signature: t('signature changed'),
    outdated: t('outdated'),
    noSummary: t('no summary yet'),
    explainBtn: t('Explain in more depth'),
    local: t('Everything stays local; the graph lives in your repository.'),
  };
}

/** Боковая панель Clewmap: «Соседи», «Влияние», «Поиск», «Цепочка», «Объяснение». */
export class PanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'clewmap.panel';
  private view: vscode.WebviewView | undefined;
  private tab: Tab = 'neighbors';
  private focus: string | null = null;
  private depth: 1 | 2 = 1;
  private query = '';
  private flow: Flow | null = null;
  private explain: PanelState['explain'] = null;
  private explainAbort: AbortController | null = null;
  private readonly subs: vscode.Disposable[] = [];
  private cursorTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ws: Workspace,
    private readonly extensionUri: vscode.Uri,
    private readonly explainer: Explainer,
  ) {
    ws.onDidChange(() => this.post(), null, this.subs);
    // Символ под курсором становится центром «Соседей».
    vscode.window.onDidChangeTextEditorSelection(
      (e) => {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(async () => {
          if (!this.view?.visible || e.textEditor !== vscode.window.activeTextEditor) return;
          const at = await this.ws.symbolAtCursor();
          if (at && at.sym.node.id !== this.focus) {
            this.focus = at.sym.node.id;
            this.post();
          }
        }, 200);
      },
      null,
      this.subs,
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const nonce = randomBytes(16).toString('base64');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const csp = [
      "default-src 'none'",
      `img-src ${view.webview.cspSource} data:`,
      `style-src ${view.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    view.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: FromPanel) => void this.onMessage(m), null, this.subs);
    view.onDidChangeVisibility(() => this.post(), null, this.subs);
  }

  private async onMessage(m: FromPanel): Promise<void> {
    switch (m.type) {
      case 'ready':
        if (!this.focus) this.focus = (await this.ws.symbolAtCursor())?.sym.node.id ?? null;
        break;
      case 'open':
        await this.ws.reveal(m.id, m.line);
        return;
      case 'focus':
        this.focus = m.id;
        this.tab = 'neighbors';
        break;
      case 'tab':
        this.tab = m.tab;
        break;
      case 'depth':
        this.depth = m.depth;
        break;
      case 'search':
        this.query = m.query;
        break;
      case 'explain':
        void this.runExplain(m.id, m.force);
        return;
      case 'flow':
        this.showFlow(m.id);
        return;
    }
    this.post();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
  }

  async showNeighbors(id: string): Promise<void> {
    this.focus = id;
    this.tab = 'neighbors';
    await this.reveal();
    this.post();
  }

  showFlow(id: string): Flow | null {
    const store = this.ws.storeOfId(id);
    if (!store) return null;
    this.flow = buildFlow(store.index, id);
    this.tab = 'flow';
    void this.reveal().then(() => this.post());
    return this.flow;
  }

  async show(tab: Tab, query?: string): Promise<void> {
    this.tab = tab;
    if (query !== undefined) this.query = query;
    await this.reveal();
    this.post();
  }

  setFlowCurrent(i: number): void {
    if (this.flow) this.flow.current = i;
    this.post();
  }

  async runExplain(id: string, force = false): Promise<void> {
    const store = this.ws.storeOfId(id);
    if (!store) return;
    this.explainAbort?.abort();
    const abort = new AbortController();
    this.explainAbort = abort;
    const title = displayName(id, store.index);
    this.tab = 'explain';
    this.explain = { id, title, status: 'loading', text: '' };
    await this.reveal();
    this.post();
    try {
      if (force) {
        const { rm } = await import('node:fs/promises');
        const { explanationPath } = await import('../explainer.js');
        await rm(explanationPath(store.root, id), { force: true });
      }
      const r = await this.explainer.explain(id, abort.signal);
      if (abort.signal.aborted) return;
      this.explain = { id, title, status: 'done', text: r.text, model: r.model, cached: r.cached };
    } catch (e) {
      if (abort.signal.aborted) return;
      this.explain = {
        id,
        title,
        status: 'error',
        text: e instanceof Error ? e.message : String(e),
      };
    }
    this.post();
  }

  private node(store: GraphStore, id: string): NodeVM {
    const index = store.index;
    const n = index.get(id);
    const layer = n?.layer ? store.layers.get(n.layer) : undefined;
    return {
      id,
      label: displayName(id, index),
      file: index.fileOfSymbol(id) ?? '',
      line: (n?.range.start[0] ?? 0) + 1,
      color: layer?.color ?? null,
      layerLabel: layer?.label ?? null,
      changed: Boolean(store.lastCommit?.changed.has(id)),
      summary: n ? validSummary(n) : null,
      stale: Boolean(n?.summary?.stale),
    };
  }

  private neighbors(store: GraphStore | undefined): NeighborsVM {
    const empty: NeighborsVM = { center: null, depth: this.depth, nodes: [], edges: [] };
    if (!store || !this.focus || !store.index.get(this.focus)) return empty;
    const index = store.index;
    const center = this.focus;
    const cols = new Map<string, number>([[center, 0]]);
    const walk = (dir: 1 | -1) => {
      let frontier = [center];
      for (let d = 1; d <= this.depth; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          const ids =
            dir === 1
              ? (index.get(cur)?.calls ?? []).filter((e) => e.resolved).map((e) => e.target)
              : index.callersOf(cur).map((e) => e.from);
          for (const id of ids) {
            if (cols.has(id)) continue;
            cols.set(id, d * dir);
            next.push(id);
          }
        }
        frontier = next;
      }
    };
    walk(-1);
    walk(1);
    const edges: NeighborsVM['edges'] = [];
    const seen = new Set<string>();
    for (const from of cols.keys())
      for (const e of index.get(from)?.calls ?? []) {
        if (!e.resolved || !cols.has(e.target)) continue;
        const key = `${from}→${e.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to: e.target, kind: e.kind, ...(e.via ? { via: e.via } : {}) });
      }
    return {
      center,
      depth: this.depth,
      nodes: [...cols].map(([id, col]) => ({ ...this.node(store, id), col })),
      edges,
    };
  }

  /** Состояние панели: то, что она сейчас показывает. Публично для тестов. */
  state(): PanelState {
    const store =
      (this.focus ? this.ws.storeOfId(this.focus) : undefined) ??
      (vscode.window.activeTextEditor
        ? this.ws.storeFor(vscode.window.activeTextEditor.document.uri)
        : undefined) ??
      this.ws.stores[0];
    const index: GraphIndex | undefined = store?.index;
    const impact = store ? impactView(store.index, store.lastCommit) : null;
    return {
      strings: strings(),
      tab: this.tab,
      hasGraph: Boolean(store),
      status: {
        fresh: !store || store.outdated.size === 0,
        outdated: store?.outdated.size ?? 0,
        sha: store?.lastCommit?.sha.slice(0, 7) ?? store?.manifest?.lastCommit?.slice(0, 7) ?? null,
      },
      legend: store
        ? [...store.layers.values()]
            .filter((l) => [...store.index.symbols.values()].some((s) => s.layer === l.key))
            .map((l) => ({ label: l.label, color: l.color }))
        : [],
      neighbors: this.neighbors(store),
      impact:
        impact && store
          ? {
              sha: impact.sha?.slice(0, 7) ?? null,
              subject: impact.subject,
              changed: impact.changed.map((c) => ({ ...this.node(store, c.id), kind: c.kind })),
              affected: impact.affected.map((a) => ({ ...this.node(store, a.id), depth: a.depth })),
              stale: impact.stale.map((id) => this.node(store, id)),
              missing: impact.missing,
            }
          : { sha: null, subject: '', changed: [], affected: [], stale: [], missing: 0 },
      flow:
        this.flow && store && index?.get(this.flow.root)
          ? {
              current: this.flow.current,
              steps: this.flow.steps.map((s) => ({
                ...this.node(store, s.id),
                depth: s.depth,
                kind: s.kind,
                ...(s.via ? { via: s.via } : {}),
              })),
            }
          : null,
      search: {
        query: this.query,
        hits: store
          ? searchGraph(store.index, this.query).map((h) => ({
              ...this.node(store, h.id),
              bySummary: h.bySummary,
            }))
          : [],
      },
      explain: this.explain,
    };
  }

  post(): void {
    if (!this.view?.visible) return;
    const msg: ToPanel = { type: 'state', state: this.state() };
    void this.view.webview.postMessage(msg);
  }

  dispose(): void {
    clearTimeout(this.cursorTimer);
    this.explainAbort?.abort();
    this.subs.forEach((d) => d.dispose());
  }
}
