import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  GENERATOR,
  qualifiedOf,
  searchGraph,
  toPosix,
  validSummary,
  type GraphIndex,
  type SymbolNode,
} from '@clewmap/core';
import { SUMMARIZABLE_KINDS, graphStatus, updateGraph } from '@clewmap/indexer';
import { parseUnifiedDiff, symbolsInRanges } from './diff.js';
import { GraphHolder, findRoot } from './graph.js';

/** Сколько элементов списка отдавать: агенту не нужен дамп всего графа. */
export const LIST_LIMIT = 50;
const SUMMARY_CHARS = 220;

type Json = Record<string, unknown>;

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function fail(message: string, extra: Json = {}) {
  return { ...text({ error: message, ...extra }), isError: true };
}

function short(s: string | null, n = SUMMARY_CHARS): string | null {
  if (!s) return null;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function loc(index: GraphIndex, id: string): string {
  const n = index.get(id);
  return `${index.fileOfSymbol(id) ?? '?'}:${(n?.range.start[0] ?? 0) + 1}`;
}

function summaryStatus(n: SymbolNode): 'ok' | 'stale' | 'missing' | 'n/a' {
  if (!SUMMARIZABLE_KINDS.has(n.kind)) return 'n/a';
  if (!validSummary(n)) return 'missing';
  return n.summary!.stale ? 'stale' : 'ok';
}

function brief(index: GraphIndex, id: string): Json {
  const n = index.get(id);
  const out: Json = { id, at: loc(index, id) };
  if (n?.layer) out.layer = n.layer;
  if (n?.entry) out.entry = `${n.entry.kind} ${n.entry.key}`;
  const s = n ? short(validSummary(n)) : null;
  if (s) out.summary = s;
  return out;
}

/** id по точному id, «file#name», квалифицированному или короткому имени. */
function resolve(index: GraphIndex, ref: string): string[] {
  if (index.get(ref)) return [ref];
  const r = ref.trim();
  const out: string[] = [];
  for (const id of index.symbols.keys()) {
    const q = qualifiedOf(id);
    if (q === r || q.split('.').pop() === r || id.endsWith(`#${r}`) || id.endsWith(`/${r}`))
      out.push(id);
  }
  return out.sort();
}

/** Расстояние Левенштейна: подсказка «может быть, вы имели в виду» для опечаток. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

function didYouMean(index: GraphIndex, ref: string): string[] {
  const hits = searchGraph(index, ref, 5).map((h) => h.id);
  if (hits.length) return hits;
  const q = ref.toLowerCase();
  return [...index.symbols.keys()]
    .map((id) => ({ id, d: editDistance(q, qualifiedOf(id).toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(q.length / 4)))
    .sort((x, y) => x.d - y.d || (x.id < y.id ? -1 : 1))
    .slice(0, 5)
    .map((x) => x.id);
}

function walk(
  index: GraphIndex,
  id: string,
  depth: number,
  dir: 'callers' | 'callees',
): { items: Json[]; truncated: boolean; external: string[] } {
  const seen = new Set([id]);
  const items: Json[] = [];
  const external = new Set<string>();
  let frontier = [id];
  let truncated = false;
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const edges =
        dir === 'callers'
          ? index
              .callersOf(cur)
              .map((e) => ({ to: e.from, via: e.via, kind: e.kind, line: e.line }))
          : (index.get(cur)?.calls ?? []).map((e) => {
              if (!e.resolved && d === 1) external.add(e.via ? `${e.target} (${e.via})` : e.target);
              return e.resolved ? { to: e.target, via: e.via, kind: e.kind, line: e.line } : null;
            });
      for (const e of edges) {
        if (!e || seen.has(e.to)) continue;
        seen.add(e.to);
        if (items.length >= LIST_LIMIT) {
          truncated = true;
          continue;
        }
        const item: Json = { ...brief(index, e.to), depth: d };
        if (d > 1) item.through = cur;
        if (e.kind !== 'call') item.link = `${e.kind}${e.via ? ` ${e.via}` : ''}`;
        items.push(item);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return { items, truncated, external: [...external].sort() };
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      resolve(err ? '' : out),
    ),
  );
}

const idInput = z
  .string()
  .min(1)
  .describe('Symbol id ("src/services/pricing.py#apply_promo") or a name ("apply_promo")');
const depthInput = z
  .number()
  .int()
  .min(1)
  .max(3)
  .default(1)
  .describe('How many steps to follow, 1–3');

/** MCP-сервер Clewmap над графом в `root`. Только чтение, кроме clewmap_update (связи без LLM). */
export function createClewmapServer(holder: GraphHolder): McpServer {
  const server = new McpServer(
    { name: 'clewmap', version: GENERATOR.replace(/^clewmap@/, '') },
    {
      instructions:
        'Clewmap keeps a call graph of this repository in .clewmap/ (built by tree-sitter, so edges are exact) ' +
        'with a plain-language summary of every function. Before changing a function, call clewmap_impact and ' +
        'clewmap_find_callers. To get to know the code, start with clewmap_search and clewmap_module_summary ' +
        'instead of grepping every file. Never edit .clewmap/ by hand: git hooks keep it up to date.',
    },
  );

  const lookup = async (ref: string) => {
    const index = await holder.get();
    const ids = resolve(index, ref);
    return { index, ids };
  };

  const ambiguous = (index: GraphIndex, ref: string, ids: string[]) =>
    ids.length
      ? fail(`"${ref}" matches ${ids.length} symbols; pass one id`, {
          matches: ids
            .slice(0, 20)
            .map((id) => ({ id, at: loc(index, id), kind: index.get(id)?.kind })),
        })
      : fail(`no symbol "${ref}"`, { didYouMean: didYouMean(index, ref) });

  server.registerTool(
    'clewmap_get_symbol',
    {
      title: 'Get a symbol',
      description:
        'Signature, file:line, layer, plain-language summary (and whether it is stale), the meaningful steps ' +
        'inside the function, what it calls and who calls it.',
      inputSchema: { name: idInput },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const { index, ids } = await lookup(name);
      if (ids.length !== 1) return ambiguous(index, name, ids);
      const id = ids[0]!;
      const n = index.get(id)!;
      const out: Json = {
        id,
        kind: n.kind,
        signature: n.signature,
        at: loc(index, id),
        layer: n.layer,
      };
      if (n.entry) out.entry = `${n.entry.kind} ${n.entry.key}`;
      out.summary = validSummary(n) ?? n.summary?.text ?? null;
      out.summaryStatus = summaryStatus(n);
      if (n.blocks?.length && n.blocks.every((b) => b.forBodyHash === n.bodyHash))
        out.steps = n.blocks.map((b) => ({
          lines: `${b.range.start[0] + 1}-${b.range.end[0] + 1}`,
          label: b.label,
          ...(b.text ? { text: b.text } : {}),
        }));
      const calls = new Map<string, string>();
      for (const e of n.calls)
        if (!calls.has(e.target))
          calls.set(e.target, e.kind === 'call' ? '' : `${e.kind}${e.via ? ` ${e.via}` : ''}`);
      out.calls = [...calls].map(([target, link]) => (link ? { target, link } : target));
      const callers = index.callersOf(id);
      out.calledBy = [...new Map(callers.map((e) => [e.from, e])).values()]
        .slice(0, LIST_LIMIT)
        .map((e) => ({
          id: e.from,
          at: `${index.fileOfSymbol(e.from)}:${e.line + 1}`,
          ...(e.kind !== 'call' ? { link: `${e.kind}${e.via ? ` ${e.via}` : ''}` } : {}),
        }));
      return text(out);
    },
  );

  for (const dir of ['callers', 'callees'] as const) {
    server.registerTool(
      dir === 'callers' ? 'clewmap_find_callers' : 'clewmap_find_callees',
      {
        title: dir === 'callers' ? 'Find callers' : 'Find callees',
        description:
          dir === 'callers'
            ? 'Who calls this symbol, transitively up to `depth` steps, including frontend requests and bot buttons that reach a backend handler.'
            : 'What this symbol calls, transitively up to `depth` steps, plus external calls (SDKs, network) one step away.',
        inputSchema: { id: idInput, depth: depthInput },
        annotations: { readOnlyHint: true },
      },
      async ({ id: ref, depth }) => {
        const { index, ids } = await lookup(ref);
        if (ids.length !== 1) return ambiguous(index, ref, ids);
        const r = walk(index, ids[0]!, depth, dir);
        const out: Json = { id: ids[0], [dir]: r.items };
        if (dir === 'callees' && r.external.length) out.external = r.external;
        if (r.truncated) out.truncated = `only the first ${LIST_LIMIT} are listed`;
        return text(out);
      },
    );
  }

  server.registerTool(
    'clewmap_impact',
    {
      title: 'What could break',
      description:
        'Symbols affected by a change: callers up to 3 steps away, the files they live in and the entry points ' +
        '(HTTP routes, bot commands and buttons) the change reaches. Pass `ids`, or a unified `diff`; with neither, ' +
        'uses the uncommitted changes in the working tree (git diff HEAD).',
      inputSchema: {
        ids: z.array(z.string()).optional().describe('Changed symbols: ids or names'),
        diff: z.string().optional().describe('A unified diff, e.g. the output of git diff'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, diff }) => {
      const index = await holder.get();
      let changed: string[] = [];
      const unknown: string[] = [];
      let source: string;
      if (ids?.length) {
        source = 'ids';
        for (const ref of ids) {
          const found = resolve(index, ref);
          if (found.length === 1) changed.push(found[0]!);
          else if (found.length > 1) changed.push(...found);
          else unknown.push(ref);
        }
      } else {
        source = diff ? 'diff' : 'git diff HEAD';
        const patch =
          diff ?? (await git(holder.root, ['diff', 'HEAD', '--unified=0', '--no-color']));
        changed = symbolsInRanges(index, parseUnifiedDiff(patch));
      }
      changed = [...new Set(changed)].sort();
      const all = index.impact(changed, 3);
      const affected = all
        .slice(0, LIST_LIMIT)
        .map((a) => ({ ...brief(index, a.id), depth: a.depth }));
      const files = [
        ...new Set([...changed, ...all.map((a) => a.id)].map((id) => index.fileOfSymbol(id)!)),
      ].sort();
      const entries = [...changed, ...all.map((a) => a.id)]
        .map((id) => index.get(id))
        .filter((n): n is SymbolNode => Boolean(n?.entry))
        .map((n) => ({ id: n.id, entry: `${n.entry!.kind} ${n.entry!.key}` }));
      const out: Json = {
        source,
        changed: changed.map((id) => brief(index, id)),
        affected,
        files,
        entryPoints: entries,
      };
      if (all.length > LIST_LIMIT)
        out.truncated = `${all.length} affected, only the first ${LIST_LIMIT} are listed`;
      if (unknown.length) out.unknown = unknown;
      if (!changed.length)
        out.note = 'No known symbol is changed (new files are not in the graph yet).';
      return text(out);
    },
  );

  server.registerTool(
    'clewmap_search',
    {
      title: 'Search the code map',
      description:
        'Fuzzy search over symbol names and the text of their summaries (no model involved). Use it to find where something is done.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('A name, part of a name, or words that would appear in a summary'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const index = await holder.get();
      const hits = searchGraph(index, query, limit);
      return text({
        query,
        results: hits.map((h) => ({
          ...brief(index, h.id),
          kind: index.get(h.id)?.kind,
          ...(h.bySummary ? { match: 'summary' } : {}),
        })),
      });
    },
  );

  server.registerTool(
    'clewmap_module_summary',
    {
      title: 'Describe a file',
      description:
        'The summary of a source file and its functions, classes and variables with one-line summaries.',
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('Path from the repository root, e.g. src/services/pricing.py'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      const index = await holder.get();
      const rel = toPosix(file).replace(/^\/+/, '');
      const m =
        index.modules.get(rel) ??
        [...index.modules.values()].find((x) => x.file.endsWith(`/${rel}`) || x.file === rel);
      if (!m) {
        const near = [...index.modules.keys()]
          .filter((f) => f.includes(rel.split('/').pop()!))
          .slice(0, 10);
        return fail(`no file "${file}" in the graph`, near.length ? { didYouMean: near } : {});
      }
      return text({
        file: m.file,
        language: m.language,
        layer: m.layer,
        summary: m.summary?.text ?? null,
        symbols: m.symbols.map((s) => {
          const item: Json = { name: qualifiedOf(s.id), kind: s.kind, line: s.range.start[0] + 1 };
          if (s.entry) item.entry = `${s.entry.kind} ${s.entry.key}`;
          const sum = short(validSummary(s), 160);
          if (sum) item.summary = sum;
          return item;
        }),
      });
    },
  );

  server.registerTool(
    'clewmap_status',
    {
      title: 'Graph status',
      description:
        'Whether the graph matches the files on disk, and how many summaries are missing or stale.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const st = await graphStatus(holder.root);
      const cut = (a: string[]) => (a.length > 20 ? [...a.slice(0, 20), `…+${a.length - 20}`] : a);
      return text({
        root: holder.root,
        upToDate: st.upToDate,
        changedFiles: cut(st.changed),
        newFiles: cut(st.added),
        removedFiles: cut(st.removed),
        symbols: st.symbols,
        withoutSummary: st.withoutSummary,
        stale: st.stale,
        queuedForSummaries: st.queued,
        lastCommit: st.lastCommit,
        head: st.head,
        hint: !st.upToDate
          ? 'Call clewmap_update to refresh edges for changed files.'
          : st.queued
            ? 'Summaries are written by `clewmap summarize` or the post-commit hook.'
            : undefined,
      });
    },
  );

  server.registerTool(
    'clewmap_update',
    {
      title: 'Refresh the graph',
      description:
        'Re-index changed files and rebuild edges (tree-sitter only, never calls a model, usually well under a second). ' +
        'Pass `files` to hint which files changed; others are re-checked by hash anyway.',
      inputSchema: { files: z.array(z.string()).optional() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ files }) => {
      const r = await updateGraph(
        holder.root,
        files?.length ? { kind: 'files', files: files.map(toPosix) } : { kind: 'worktree' },
      );
      holder.invalidate();
      const changed = r.diffs.filter(
        (d) =>
          d.added.length || d.removed.length || d.bodyChanged.length || d.signatureChanged.length,
      );
      return text({
        files: r.files,
        parsed: r.parsed,
        written: r.written,
        deleted: r.deleted,
        renamed: r.renamed,
        changedSymbols: changed
          .flatMap((d) => [...d.added, ...d.bodyChanged, ...d.signatureChanged])
          .slice(0, LIST_LIMIT),
        removedSymbols: changed.flatMap((d) => d.removed).slice(0, LIST_LIMIT),
        queuedForSummaries: r.queued,
        ms: r.ms,
      });
    },
  );

  return server;
}

/** `clewmap mcp`: stdio-сервер для корня, найденного от CLAUDE_PROJECT_DIR или текущей папки. */
export async function runStdioServer(
  cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
): Promise<void> {
  const root = findRoot(cwd);
  if (!root) {
    process.stderr.write(
      `clewmap mcp: no .clewmap/ found from ${cwd} up to the git root. Run: npx clewmap init --hooks\n`,
    );
    process.exit(1);
  }
  const holder = new GraphHolder(root);
  holder.watch();
  const server = createClewmapServer(holder);
  await server.connect(new StdioServerTransport());
  // stdin закрыли: дать ответить на запросы в работе (watcher больше не держит процесс), потом выйти.
  process.stdin.on('close', () => {
    holder.close();
    setTimeout(() => process.exit(0), 5000).unref();
  });
  process.on('SIGTERM', () => {
    holder.close();
    void server.close().finally(() => process.exit(0));
  });
}
