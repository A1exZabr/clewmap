import path from 'node:path';
import * as vscode from 'vscode';
import { setWasmDir } from '@clewmap/indexer';
import { Explainer } from './explainer.js';
import type { Flow } from './model/flow.js';
import {
  baseName,
  displayName,
  uniqueCallees,
  uniqueCallers,
  validSummary,
} from './model/graph.js';
import { Painter } from './painter.js';
import { PanelProvider } from './panel/PanelProvider.js';
import {
  ClewmapCodeLens,
  ClewmapDefinition,
  ClewmapHover,
  ClewmapReferences,
  SELECTOR,
} from './providers.js';
import { t, Workspace } from './workspace.js';

/** Доступ к частям расширения для тестов в настоящем VS Code. */
export interface ClewmapApi {
  ws: Workspace;
  panel: PanelProvider;
  painter: Painter;
  explainer: Explainer;
  hover: ClewmapHover;
  flow: () => Flow | null;
  ready: Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ClewmapApi {
  setWasmDir(path.join(context.extensionPath, 'dist', 'wasm'));
  const ws = new Workspace();
  const explainer = new Explainer(ws);
  const panel = new PanelProvider(ws, context.extensionUri, explainer);
  const lens = new ClewmapCodeLens(ws);
  const def = new ClewmapDefinition(ws);
  const painter = new Painter(ws, context.extensionUri);
  const hover = new ClewmapHover(ws);
  let flow: Flow | null = null;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'clewmap.openPanel';
  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    const store = (editor && ws.storeFor(editor.document.uri)) ?? ws.stores[0];
    if (!store) {
      status.hide();
      return;
    }
    const sha = store.lastCommit?.sha.slice(0, 7) ?? store.manifest?.lastCommit?.slice(0, 7) ?? '';
    const behind = store.outdated.size;
    status.text = behind
      ? `$(warning) Clewmap: ${t('behind by {0} file(s)', behind)}`
      : `$(type-hierarchy) Clewmap: ${t('graph is up to date')}${sha ? ` · ${sha}` : ''}`;
    status.tooltip = behind
      ? t('{0} file(s) changed after the graph was updated. Commit, or run clewmap update.', behind)
      : t('The graph matches the code. Click to open the panel.');
    status.show();
  };

  const pick = async (id: string, kind: 'callers' | 'callees') => {
    const store = ws.storeOfId(id);
    const node = store?.index.get(id);
    if (!store || !node) return;
    const items =
      kind === 'callers'
        ? uniqueCallers(store.index, id).map((e) => ({
            id: e.from,
            line: e.line as number | null,
            via: e.via,
          }))
        : uniqueCallees(node).map((e) => ({ id: e.target, line: null, via: e.via }));
    const choice = await vscode.window.showQuickPick(
      items.map((i) => {
        const n = store.index.get(i.id);
        const file = store.index.fileOfSymbol(i.id) ?? '';
        return {
          label: displayName(i.id, store.index),
          description: `${baseName(file)}:${(i.line ?? n?.range.start[0] ?? 0) + 1}${i.via ? ` · ${i.via}` : ''}`,
          detail: n ? (validSummary(n) ?? undefined) : undefined,
          item: i,
        };
      }),
      {
        title:
          kind === 'callers'
            ? t('Who calls {0}', displayName(id, store.index))
            : t('What {0} calls', displayName(id, store.index)),
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (choice) await ws.reveal(choice.item.id, choice.item.line);
  };

  const withId =
    (fn: (id: string, ...rest: unknown[]) => unknown) =>
    async (arg?: unknown, ...rest: unknown[]) => {
      const id = await ws.resolveId(arg);
      if (!id) {
        void vscode.window.showInformationMessage(t('Put the cursor inside a function first.'));
        return;
      }
      return fn(id, ...rest);
    };

  const stepFlow = async (dir: 1 | -1) => {
    if (!flow) return;
    const next = flow.current + dir;
    if (next < 0 || next >= flow.steps.length) return;
    flow.current = next;
    panel.setFlowCurrent(next);
    await ws.reveal(flow.steps[next]!.id);
  };

  context.subscriptions.push(
    ws,
    panel,
    painter,
    status,
    vscode.window.registerWebviewViewProvider(PanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeLensProvider(SELECTOR, lens),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerDefinitionProvider(SELECTOR, def),
    vscode.languages.registerReferenceProvider(SELECTOR, new ClewmapReferences(ws, def)),
    vscode.commands.registerCommand('clewmap.goto', (id: string, line?: number | null) =>
      ws.reveal(id, line),
    ),
    vscode.commands.registerCommand(
      'clewmap.showCallers',
      withId((id) => pick(id, 'callers')),
    ),
    vscode.commands.registerCommand(
      'clewmap.showCallees',
      withId((id) => pick(id, 'callees')),
    ),
    vscode.commands.registerCommand(
      'clewmap.showFlow',
      withId((id) => {
        flow = panel.showFlow(id);
        void vscode.commands.executeCommand('setContext', 'clewmap.flowActive', Boolean(flow));
        return flow;
      }),
    ),
    vscode.commands.registerCommand('clewmap.flowBack', () => stepFlow(-1)),
    vscode.commands.registerCommand('clewmap.flowForward', () => stepFlow(1)),
    vscode.commands.registerCommand(
      'clewmap.explainDeeper',
      withId((id) => panel.runExplain(id)),
    ),
    vscode.commands.registerCommand(
      'clewmap.openOnGraph',
      withId((id) => panel.showNeighbors(id)),
    ),
    vscode.commands.registerCommand('clewmap.openPanel', () => panel.reveal()),
    vscode.commands.registerCommand('clewmap.reload', () => ws.load()),
    ws.onDidChange(updateStatus),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void ws.load()),
    vscode.workspace.onDidCloseTextDocument((doc) => ws.storeFor(doc.uri)?.forget(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('clewmap')) lens.refresh();
    }),
  );

  const ready = ws.load().then(() => {
    updateStatus();
    painter.paintAll();
  });
  return { ws, panel, painter, explainer, hover, flow: () => flow, ready };
}

export function deactivate(): void {}
