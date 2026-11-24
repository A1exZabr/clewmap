import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sha256, type Config, type GraphIndex, type SymbolNode } from '@clewmap/core';
import { grammarFor, statementsForRange, type Statement } from '@clewmap/indexer';
import type { CalleeContext, SummaryRequest } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_CALLEES = 30;

/** Блоки нужны функциям и методам длиннее blocksMinLines строк, если в теле хотя бы 2 оператора. */
export function wantsBlocks(s: SymbolNode, config: Config): boolean {
  if (s.kind !== 'function' && s.kind !== 'method') return false;
  return s.range.end[0] - s.range.start[0] + 1 > config.summaries.blocksMinLines;
}

/**
 * Исходники для описаний. Текст должен совпадать с fileHash в графе: если рабочая копия ушла
 * вперёд (частичный коммит), берётся версия из HEAD; не совпало ничего — символ пропускается.
 */
export class SourceCache {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly root: string) {}

  get(file: string, fileHash: string): Promise<string | null> {
    const key = `${file}\0${fileHash}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(file, fileHash);
      this.cache.set(key, p);
    }
    return p;
  }

  private async load(file: string, fileHash: string): Promise<string | null> {
    try {
      const text = await readFile(path.join(this.root, file), 'utf8');
      if (sha256(text) === fileHash) return text;
    } catch {
      // файла нет в рабочей копии
    }
    for (const rev of [':', 'HEAD:']) {
      try {
        const { stdout } = await execFileAsync('git', ['cat-file', 'blob', `${rev}${file}`], {
          cwd: this.root,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (sha256(stdout) === fileHash) return stdout;
      } catch {
        // нет в индексе или в HEAD
      }
    }
    return null;
  }
}

export interface PreparedRequest {
  request: SummaryRequest;
  statements: Statement[] | null;
}

function displayName(target: string): string {
  if (target.startsWith('external:')) return target.slice('external:'.length);
  const hash = target.lastIndexOf('#');
  return hash === -1 ? target : target.slice(hash + 1);
}

/** Запрос на описание одного символа: код, сигнатура, вызываемые с их описаниями, файл и слой. */
export async function prepareRequest(
  id: string,
  index: GraphIndex,
  config: Config,
  sources: SourceCache,
): Promise<PreparedRequest | null> {
  const s = index.get(id);
  const file = index.fileOfSymbol(id);
  const module = file ? index.modules.get(file) : undefined;
  if (!s || !file || !module) return null;
  const source = await sources.get(file, module.fileHash);
  if (source === null) return null;

  const lines = source.split('\n');
  const code = lines.slice(s.range.start[0], s.range.end[0] + 1).join('\n');

  const callees: CalleeContext[] = [];
  const seen = new Set<string>();
  for (const e of s.calls) {
    if (seen.has(e.target) || e.target === id) continue;
    seen.add(e.target);
    const callee = e.resolved ? index.get(e.target) : undefined;
    const c: CalleeContext = {
      target: e.target,
      name: displayName(e.target),
      summary: callee?.summary?.text ?? null,
    };
    if (e.via) c.via = e.via;
    callees.push(c);
    if (callees.length >= MAX_CALLEES) break;
  }

  let statements: Statement[] | null = null;
  const grammar = grammarFor(file);
  if (grammar && wantsBlocks(s, config)) {
    const st = await statementsForRange(source, grammar, module.language, s.range);
    if (st.length >= 2) statements = st;
  }

  const request: SummaryRequest = {
    id,
    name: s.name,
    kind: s.kind,
    file,
    language: module.language,
    layer: s.layer,
    signature: s.signature,
    code,
    bodyHash: s.bodyHash,
    callees,
    statements: statements
      ? statements.map((st) => ({ index: st.index, line: st.range.start[0], text: st.text }))
      : null,
  };
  if (s.entry) request.entry = s.entry;
  return { request, statements };
}
