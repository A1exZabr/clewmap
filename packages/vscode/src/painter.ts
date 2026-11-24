import * as vscode from 'vscode';
import { blockSpans, changedLines, lineLayers } from './model/decorations.js';
import { circled } from './model/hover.js';
import type { GraphStore } from './store.js';
import { symbolNameLine } from './providers.js';
import type { Workspace } from './workspace.js';

type BlockStyle = 'both' | 'tint' | 'label';

/** Что нарисовано в документе: для тестов и отладки. */
export interface PaintSnapshot {
  stripes: Record<string, number[]>;
  changed: number[];
  blocks: { start: number; end: number; label: string }[];
}

/**
 * Декорации редактора: полоса слоя слева у строк с вызовами, «Δ» у того, что задел последний коммит,
 * и смысловые блоки внутри функций (чередующийся фон, тонкая линия между блоками, подпись в конце строки).
 */
export class Painter implements vscode.Disposable {
  private stripes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly changed: vscode.TextEditorDecorationType;
  private readonly tintA: vscode.TextEditorDecorationType;
  private readonly tintB: vscode.TextEditorDecorationType;
  private readonly separator: vscode.TextEditorDecorationType;
  private readonly label: vscode.TextEditorDecorationType;
  private readonly subs: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  readonly snapshots = new Map<string, PaintSnapshot>();

  constructor(
    private readonly ws: Workspace,
    extensionUri: vscode.Uri,
  ) {
    this.changed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('clewmap.changedBackground'),
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'delta.svg'),
      gutterIconSize: '70%',
      overviewRulerColor: '#F2A65A',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this.tintA = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('clewmap.blockTintA'),
    });
    this.tintB = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('clewmap.blockTintB'),
    });
    this.separator = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth: '1px 0 0 0',
      borderColor: new vscode.ThemeColor('clewmap.blockSeparator'),
    });
    this.label = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('clewmap.blockLabel'),
        margin: '0 0 0 2.5em',
        fontStyle: 'normal',
      },
    });

    ws.onDidChange(() => this.paintAll(), null, this.subs);
    vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll(), null, this.subs);
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          for (const ed of vscode.window.visibleTextEditors)
            if (ed.document === e.document) void this.paint(ed);
        }, 250);
      },
      null,
      this.subs,
    );
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('clewmap')) this.paintAll();
      },
      null,
      this.subs,
    );
  }

  private stripeType(store: GraphStore, layer: string): vscode.TextEditorDecorationType | null {
    const info = store.layers.get(layer);
    if (!info) return null;
    const key = `${layer}:${info.color}`;
    let type = this.stripes.get(key);
    if (!type) {
      type = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderWidth: '0 0 0 3px',
        borderColor: info.color,
        overviewRulerColor: info.color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
      this.stripes.set(key, type);
    }
    return type;
  }

  paintAll(): void {
    for (const ed of vscode.window.visibleTextEditors) void this.paint(ed);
  }

  async paint(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const store = this.ws.storeFor(doc.uri);
    const cfg = vscode.workspace.getConfiguration('clewmap');
    const clear = (type: vscode.TextEditorDecorationType) => editor.setDecorations(type, []);
    if (!store) {
      for (const type of [
        ...this.stripes.values(),
        this.changed,
        this.tintA,
        this.tintB,
        this.separator,
        this.label,
      ])
        clear(type);
      return;
    }
    const version = doc.version;
    const model = await store.docModel(doc);
    if (doc.version !== version) return; // пока считали, текст опять поменялся: нарисует следующий вызов

    const snap: PaintSnapshot = { stripes: {}, changed: [], blocks: [] };
    // Полосы слоёв
    const byType = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
    for (const type of this.stripes.values()) byType.set(type, []);
    if (cfg.get('layerStripes.enabled', true)) {
      for (const [line, layer] of lineLayers(model, store.index)) {
        if (line >= doc.lineCount) continue;
        const type = this.stripeType(store, layer);
        if (!type) continue;
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type)!.push(new vscode.Range(line, 0, line, 0));
        (snap.stripes[layer] ??= []).push(line);
      }
    }
    for (const [type, ranges] of byType) editor.setDecorations(type, ranges);

    // Последний коммит
    const changed = changedLines(model, store.lastCommit, (sym) => symbolNameLine(doc, sym));
    snap.changed = [...changed].filter((l) => l < doc.lineCount).sort((x, y) => x - y);
    editor.setDecorations(
      this.changed,
      snap.changed.map((l) => new vscode.Range(l, 0, l, 0)),
    );

    // Смысловые блоки
    const style = cfg.get<BlockStyle>('blocks.style', 'both');
    const spans = cfg.get('blocks.enabled', true) ? blockSpans(model) : [];
    const a: vscode.Range[] = [];
    const b: vscode.Range[] = [];
    const sep: vscode.Range[] = [];
    const labels: vscode.DecorationOptions[] = [];
    for (const s of spans) {
      if (s.endLine >= doc.lineCount) continue;
      const range = new vscode.Range(s.startLine, 0, s.endLine, 0);
      snap.blocks.push({ start: s.startLine, end: s.endLine, label: s.block.label });
      if (style !== 'label') {
        (s.index % 2 === 0 ? a : b).push(range);
        if (s.index > 0) sep.push(new vscode.Range(s.startLine, 0, s.startLine, 0));
      }
      if (style !== 'tint') {
        const end = doc.lineAt(s.startLine).range.end;
        labels.push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: `${circled(s.index)} ${s.block.label}` } },
        });
      }
    }
    editor.setDecorations(this.tintA, a);
    editor.setDecorations(this.tintB, b);
    editor.setDecorations(this.separator, sep);
    editor.setDecorations(this.label, labels);
    this.snapshots.set(doc.uri.toString(), snap);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const type of [
      ...this.stripes.values(),
      this.changed,
      this.tintA,
      this.tintB,
      this.separator,
      this.label,
    ])
      type.dispose();
    this.subs.forEach((d) => d.dispose());
  }
}
