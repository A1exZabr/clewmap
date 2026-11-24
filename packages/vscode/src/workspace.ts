import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { MANIFEST_FILE, CLEWMAP_DIR } from '@clewmap/core';
import type { Translate } from './model/graph.js';
import { nameLine, symbolAtLine, type DocModel, type LocatedSymbol } from './model/locate.js';
import { GraphStore } from './store.js';

export const t: Translate = (message, ...args) => vscode.l10n.t(message, ...args);

/** Все корни с `.clewmap/` в рабочей области (multi-root тоже). */
export class Workspace implements vscode.Disposable {
  stores: GraphStore[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  async load(): Promise<void> {
    for (const s of this.stores) s.dispose();
    this.subs.splice(0).forEach((d) => d.dispose());
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .map((f) => f.uri.fsPath)
      .filter((root) => existsSync(path.join(root, CLEWMAP_DIR, MANIFEST_FILE)));
    this.stores = await Promise.all(roots.map((r) => GraphStore.open(r)));
    for (const s of this.stores) this.subs.push(s.onDidChange(() => this.emitter.fire()));
    await vscode.commands.executeCommand('setContext', 'clewmap.active', this.stores.length > 0);
    this.emitter.fire();
  }

  storeFor(uri: vscode.Uri): GraphStore | undefined {
    if (uri.scheme !== 'file') return undefined;
    let best: GraphStore | undefined;
    for (const s of this.stores)
      if (s.relative(uri.fsPath) !== null && (!best || s.root.length > best.root.length)) best = s;
    return best;
  }

  storeOfId(id: string): GraphStore | undefined {
    return this.stores.find((s) => s.index.get(id));
  }

  /** Символ под курсором в активном редакторе. */
  async symbolAtCursor(): Promise<{ store: GraphStore; sym: LocatedSymbol } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const store = this.storeFor(editor.document.uri);
    if (!store) return null;
    const model = await store.docModel(editor.document);
    const sym = symbolAtLine(model, editor.selection.active.line);
    return sym ? { store, sym } : null;
  }

  /** id из аргумента команды или символ под курсором. */
  async resolveId(arg: unknown): Promise<string | null> {
    if (typeof arg === 'string' && this.storeOfId(arg)) return arg;
    return (await this.symbolAtCursor())?.sym.node.id ?? null;
  }

  /**
   * Открыть символ: строка с его именем в текущем тексте файла (а не номер из графа).
   * edgeLine — строка вызова внутри символа (по графу): переход прямо к кнопке или запросу.
   */
  async reveal(id: string, edgeLine?: number | null): Promise<void> {
    const store = this.storeOfId(id);
    const file = store?.index.fileOfSymbol(id);
    if (!store || !file) return;
    const doc = await vscode.workspace.openTextDocument(store.uriOf(file));
    const model = await store.docModel(doc);
    const range = this.rangeOf(doc, model, id, edgeLine);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  rangeOf(
    doc: vscode.TextDocument,
    model: DocModel,
    id: string,
    edgeLine?: number | null,
  ): vscode.Range {
    const sym = model.symbols.find((s) => s.node.id === id);
    const node = sym?.node ?? this.storeOfId(id)?.index.get(id);
    if (!sym) {
      const line = Math.min(node?.range.start[0] ?? 0, doc.lineCount - 1);
      return new vscode.Range(line, 0, line, 0);
    }
    if (edgeLine !== undefined && edgeLine !== null) {
      const line = Math.min(edgeLine + sym.delta, doc.lineCount - 1);
      const text = doc.lineAt(line).text;
      const start = text.length - text.trimStart().length;
      return new vscode.Range(line, start, line, start);
    }
    const lines = Array.from({ length: Math.min(doc.lineCount, sym.range.end[0] + 1) }, (_, i) =>
      i < sym.range.start[0] ? '' : doc.lineAt(i).text,
    );
    const line = nameLine(sym, lines);
    const short = sym.node.name.split('.').pop()!;
    const col = doc.lineAt(line).text.search(new RegExp(`\\b${short.replace(/[$]/g, '\\$')}\\b`));
    const c = Math.max(col, 0);
    return new vscode.Range(line, c, line, c + (col >= 0 ? short.length : 0));
  }

  fire(): void {
    this.emitter.fire();
  }

  dispose(): void {
    for (const s of this.stores) s.dispose();
    this.subs.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
