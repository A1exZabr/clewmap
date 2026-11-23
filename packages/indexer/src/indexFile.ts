import {
  normalizeBody,
  sha256,
  type CallEdge,
  type Config,
  type Entry,
  type Language,
  type ModuleFile,
  type SymbolNode,
} from '@clewmap/core';
import { pythonAdapter } from './adapters/python.js';
import type { LanguageAdapter, RawModule } from './adapters/types.js';
import { typescriptAdapter } from './adapters/typescript.js';
import { isExternalSdk, layerForFile } from './layers.js';
import { eventMatches, httpMatches, linkVia, nextRouteEntries } from './links.js';
import { parse, type SupportedLanguage } from './parser.js';
import type { ProjectTable } from './resolve.js';

const GRAMMAR_BY_EXT: Record<string, SupportedLanguage> = {
  '.py': 'python',
  '.pyi': 'python',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

export const SUPPORTED_EXTENSIONS = Object.keys(GRAMMAR_BY_EXT);

function extOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

export function grammarFor(file: string): SupportedLanguage | null {
  if (/\.d\.[mc]?ts$/.test(file) || /\.min\.js$/.test(file)) return null;
  return GRAMMAR_BY_EXT[extOf(file)] ?? null;
}

export function languageOf(grammar: SupportedLanguage): Language {
  return grammar === 'python' ? 'python' : grammar === 'javascript' ? 'javascript' : 'typescript';
}

function adapterFor(grammar: SupportedLanguage): LanguageAdapter {
  return grammar === 'python' ? pythonAdapter : typescriptAdapter;
}

/** Шаг 1: файл → сырые символы, импорты и вызовы. Дерево освобождается сразу. */
export async function extractFile(
  file: string,
  source: string,
  opts: { httpClients?: readonly string[] } = {},
): Promise<RawModule | null> {
  const grammar = grammarFor(file);
  if (!grammar) return null;
  const tree = await parse(source, grammar);
  try {
    const language = languageOf(grammar);
    const raw = adapterFor(grammar).extract(tree, source, {
      file,
      httpClients: opts.httpClients ?? [],
    });
    return { file, language, grammar, fileHash: sha256(source), ...raw };
  } finally {
    tree.delete();
  }
}

export interface EntryPoint {
  id: string;
  entry: Entry;
}

/** Все точки входа проекта: декораторы, регистрации обработчиков, маршруты Next.js по пути файла. */
export function collectEntries(table: ProjectTable): EntryPoint[] {
  const byId = new Map<string, Entry>();
  for (const m of table.modules.values()) {
    const ids = table.symbolIds.get(m.file)!;
    m.symbols.forEach((s, i) => {
      if (s.entry) byId.set(ids[i]!, s.entry);
    });
    for (const reg of m.registrations) {
      const id = table.resolveHandler(m.file, reg.handler);
      if (id && !byId.has(id)) byId.set(id, reg.entry);
    }
    if (m.language !== 'python') {
      for (const [exported, entry] of nextRouteEntries(m.file, m.exports.keys())) {
        const local = m.exports.get(exported);
        const id = local ? table.idOf(m.file, local) : undefined;
        if (id && !byId.has(id)) byId.set(id, entry);
      }
    }
  }
  return [...byId].map(([id, entry]) => ({ id, entry })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function edgeKey(e: CallEdge): string {
  return `${e.line}\u0000${e.target}\u0000${e.kind}\u0000${e.via ?? ''}`;
}

/** Шаг 2: сырой модуль + таблица проекта → ModuleFile без описаний. */
export function indexFile(
  raw: RawModule,
  table: ProjectTable,
  entries: readonly EntryPoint[],
  config: Config,
): ModuleFile {
  const ids = table.symbolIds.get(raw.file)!;
  const entryById = new Map(entries.map((e) => [e.id, e.entry]));
  // Папка "api" бывает и у бэка (маршруты), и у фронта (клиент), поэтому обработчик узнаём по точке входа.
  const fileLayer =
    layerForFile(raw.file, config) ?? (ids.some((id) => entryById.has(id)) ? 'handler' : null);

  const symbols: SymbolNode[] = raw.symbols.map((s, i) => {
    const id = ids[i]!;
    const edges = new Map<string, CallEdge>();
    const add = (e: CallEdge): void => {
      edges.set(edgeKey(e), e);
    };

    for (const call of s.calls) {
      if (call.link) {
        const link = call.link;
        const via = linkVia(link);
        const kind = link.kind;
        const matched = entries.filter((ep) =>
          link.kind === 'http'
            ? ep.entry.kind === 'http-route' &&
              httpMatches(link, ep.entry.key, config.links.apiPrefix)
            : ep.entry.kind !== 'http-route' && eventMatches(link.key, ep.entry.key),
        );
        if (matched.length) {
          for (const ep of matched)
            add({ target: ep.id, line: call.line, resolved: true, kind, via });
        } else {
          const r = table.resolvePath(raw.file, s, call.callee);
          const target =
            r && !r.resolved ? r.target : `external:${call.callee.join('.') || 'unknown'}`;
          add({ target, line: call.line, resolved: false, kind, via });
        }
        continue;
      }
      const r = table.resolvePath(raw.file, s, call.callee);
      if (r) add({ target: r.target, line: call.line, resolved: r.resolved, kind: 'call' });
    }

    const calls = [...edges.values()];
    const callsSdk = calls.some((e) => !e.resolved && isExternalSdk(e.target));
    const node: SymbolNode = {
      id,
      kind: s.kind,
      name: s.name,
      range: s.range,
      signature: s.signature,
      signatureHash: sha256(s.signature),
      bodyHash: sha256(normalizeBody(s.body, raw.language)),
      layer: callsSdk ? 'external' : entryById.has(id) ? 'handler' : fileLayer,
      calls,
      summary: null,
      blocks: null,
    };
    const entry = entryById.get(id);
    if (entry) node.entry = entry;
    return node;
  });

  return {
    file: raw.file,
    language: raw.language,
    fileHash: raw.fileHash,
    layer: fileLayer,
    summary: null,
    symbols,
  };
}

/** Переносит описания из прошлой версии модуля, если код символа не менялся (тот же bodyHash). */
export function carryOverSummaries(next: ModuleFile, prev: ModuleFile | null): ModuleFile {
  if (!prev) return next;
  const prevById = new Map(prev.symbols.map((s) => [s.id, s]));
  return {
    ...next,
    summary:
      prev.fileHash === next.fileHash
        ? prev.summary
        : prev.summary
          ? { ...prev.summary, stale: true }
          : null,
    symbols: next.symbols.map((s) => {
      const old = prevById.get(s.id);
      if (!old) return s;
      return {
        ...s,
        summary: old.summary && old.summary.forBodyHash === s.bodyHash ? old.summary : null,
        blocks:
          old.blocks && old.blocks.every((b) => b.forBodyHash === s.bodyHash) ? old.blocks : null,
      };
    }),
  };
}
