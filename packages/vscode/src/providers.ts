import * as vscode from 'vscode';
import { SUMMARIZABLE_KINDS } from '@clewmap/indexer';
import { blockAt, blockSpans } from './model/decorations.js';
import { callUnderCursor, incomingLinks, linkOnLine, shortName } from './model/graph.js';
import { HOVER_COMMANDS, blockHover, symbolHover } from './model/hover.js';
import { lensParts } from './model/lens.js';
import { nameLine, symbolAtLine, type DocModel, type LocatedSymbol } from './model/locate.js';
import type { GraphStore } from './store.js';
import { t, type Workspace } from './workspace.js';

export const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'python' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
];

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('clewmap').get<T>(key, fallback);
}

function docLines(doc: vscode.TextDocument, upTo: number): string[] {
  const n = Math.min(doc.lineCount, upTo + 1);
  return Array.from({ length: n }, (_, i) => doc.lineAt(i).text);
}

export function symbolNameLine(doc: vscode.TextDocument, sym: LocatedSymbol): number {
  return nameLine(sym, docLines(doc, sym.range.end[0]));
}

/** Строка над функцией: описание · вызывают: N · ходит в: … · связи через границу. */
export class ClewmapCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly ws: Workspace) {
    ws.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!setting('codeLens.enabled', true)) return [];
    const store = this.ws.storeFor(doc.uri);
    if (!store) return [];
    const model = await store.docModel(doc);
    const lenses: vscode.CodeLens[] = [];
    for (const sym of model.symbols) {
      if (!SUMMARIZABLE_KINDS.has(sym.node.kind)) continue;
      const line = symbolNameLine(doc, sym);
      const range = new vscode.Range(line, 0, line, 0);
      const p = lensParts(sym, store.index, store.layers, t);
      const id = sym.node.id;
      lenses.push(
        new vscode.CodeLens(range, {
          title: p.summary.title,
          tooltip: p.summary.tooltip ?? undefined,
          command: 'clewmap.openOnGraph',
          arguments: [id],
        }),
        new vscode.CodeLens(range, {
          title: p.callers.title,
          tooltip: t('Show who calls it'),
          command: 'clewmap.showCallers',
          arguments: [id],
        }),
      );
      if (p.goesTo)
        lenses.push(
          new vscode.CodeLens(range, {
            title: p.goesTo.title,
            tooltip: p.goesTo.tooltip,
            command: 'clewmap.showCallees',
            arguments: [id],
          }),
        );
      for (const l of p.links)
        lenses.push(
          new vscode.CodeLens(range, {
            title: l.title,
            tooltip: l.tooltip,
            command: 'clewmap.goto',
            arguments: [l.target, l.line],
          }),
        );
    }
    return lenses;
  }
}

/** Подсказка при наведении. Только данные графа, без запросов к модели. */
export class ClewmapHover implements vscode.HoverProvider {
  /** Сколько мс заняла последняя подсказка внутри Clewmap (без накладных расходов VS Code). */
  lastMs = 0;

  constructor(private readonly ws: Workspace) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | null> {
    if (!setting('hover.enabled', true)) return null;
    const store = this.ws.storeFor(doc.uri);
    if (!store) return null;
    // Готовая модель, если есть; иначе посчитать (обычно это уже сделали CodeLens и декорации).
    const t0 = performance.now();
    const model = store.peek(doc) ?? (await store.docModel(doc));
    const hover = hoverAt(store, doc, model, pos);
    this.lastMs = performance.now() - t0;
    if (!hover) return null;
    const md = new vscode.MarkdownString(hover.markdown, true);
    md.supportHtml = true;
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };
    return new vscode.Hover(md, hover.range);
  }
}

export function hoverAt(
  store: GraphStore,
  doc: vscode.TextDocument,
  model: DocModel,
  pos: vscode.Position,
): { markdown: string; range?: vscode.Range } | null {
  const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
  const word = wordRange ? doc.getText(wordRange) : '';
  const contextFile = model.file;
  const sym = symbolAtLine(model, pos.line);

  const call = word ? callUnderCursor(model, pos.line, word) : null;
  if (call?.edge.resolved) {
    const markdown = symbolHover(call.edge.target, store.index, store.layers, t, {
      contextFile,
      lastCommit: store.lastCommit,
    });
    if (markdown) return { markdown, range: wordRange };
  }

  if (sym && word === shortName(sym.node.id) && symbolNameLine(doc, sym) === pos.line) {
    const markdown = symbolHover(sym.node.id, store.index, store.layers, t, {
      contextFile,
      lastCommit: store.lastCommit,
      edited: !sym.fresh,
    });
    if (markdown) return { markdown, range: wordRange };
  }

  const link = linkOnLine(model, pos.line);
  if (link && insideString(doc.lineAt(pos.line).text, pos.character)) {
    const markdown = symbolHover(link.edge.target, store.index, store.layers, t, {
      contextFile,
      lastCommit: store.lastCommit,
    });
    if (markdown) return { markdown };
  }

  if (setting('blocks.enabled', true)) {
    const block = blockAt(blockSpans(model), pos.line);
    if (block)
      return { markdown: blockHover(block.owner.node.name, block.block, block.index, block.total) };
  }
  return null;
}

/** Позиция внутри строкового литерала на этой строке: '…', "…" или `…`. */
export function insideString(line: string, ch: number): boolean {
  const re = /(['"`])(?:\\.|(?!\1).)*\1/g;
  for (let m = re.exec(line); m; m = re.exec(line))
    if (ch > m.index && ch < m.index + m[0].length) return true;
  return false;
}

/**
 * F12 / Cmd+клик на `fetch('/api/checkout')` или `callback_data="checkout"` открывает обработчик
 * на другой стороне, даже если это другой язык. Обычные вызовы оставляем языковому серверу.
 */
export class ClewmapDefinition implements vscode.DefinitionProvider {
  constructor(private readonly ws: Workspace) {}

  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
    const store = this.ws.storeFor(doc.uri);
    if (!store) return null;
    const model = await store.docModel(doc);
    const link = linkOnLine(model, pos.line);
    if (!link || !insideString(doc.lineAt(pos.line).text, pos.character)) return null;
    return this.locationOf(link.edge.target, null);
  }

  async locationOf(id: string, edgeLine: number | null): Promise<vscode.Location | null> {
    const store = this.ws.storeOfId(id);
    const file = store?.index.fileOfSymbol(id);
    if (!store || !file) return null;
    const target = await vscode.workspace.openTextDocument(store.uriOf(file));
    const range = this.ws.rangeOf(target, await store.docModel(target), id, edgeLine);
    return new vscode.Location(target.uri, range);
  }
}

/** Shift+F12 на обработчике: все кнопки и запросы, которые в него ведут (между языками). */
export class ClewmapReferences implements vscode.ReferenceProvider {
  constructor(
    private readonly ws: Workspace,
    private readonly def: ClewmapDefinition,
  ) {}

  async provideReferences(doc: vscode.TextDocument, pos: vscode.Position) {
    const store = this.ws.storeFor(doc.uri);
    if (!store) return null;
    const model = await store.docModel(doc);
    const sym = symbolAtLine(model, pos.line);
    if (!sym || symbolNameLine(doc, sym) !== pos.line) return null;
    const out: vscode.Location[] = [];
    for (const e of incomingLinks(store.index, sym.node.id)) {
      const loc = await this.def.locationOf(e.from, e.line);
      if (loc) out.push(loc);
    }
    return out;
  }
}
