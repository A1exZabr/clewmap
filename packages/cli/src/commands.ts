import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CACHE_DIR,
  CLEWMAP_DIR,
  CONFIG_FILE,
  DEFAULT_LAYERS,
  FORMAT_VERSION,
  GENERATOR,
  parseConfig,
  readConfig,
  readManifest,
  readQueue,
  writeManifest,
  type Config,
  type Language,
} from '@clewmap/core';
import {
  buildGraph,
  gitBusy,
  graphStatus,
  grammarFor,
  languageOf,
  layerForDir,
  scanFiles,
  updateGraph,
  type GraphStatus,
  type SyncResult,
  type UpdateMode,
} from '@clewmap/indexer';
import {
  createProvider,
  readLock,
  isStale,
  summarize as runSummaries,
  type SummarizeMode,
  type SummarizeStats,
  type SummaryProvider,
} from '@clewmap/summarizer';
import pc from 'picocolors';
import { installHooks, uninstallHooks, type HookChange, type HookName } from './hooks.js';

export type Log = (line: string) => void;

const GITIGNORE_LINES = ['.clewmap/.queue.json', '.clewmap/.lock', '.clewmap/.cache/'];
const DEFAULT_EXCLUDE = [
  '**/tests/**',
  '**/test/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/migrations/**',
];

/** Убирает глобы, которые уже покрыты более общими (src/bot/** покрывает src/bot/handlers/**). */
function minimalGlobs(prefixes: Set<string>): string[] {
  const sorted = [...prefixes].sort();
  return sorted
    .filter((p) => !sorted.some((q) => q !== p && p.startsWith(`${q}/`)))
    .map((p) => `${p}/**`);
}

export interface InitResult {
  configCreated: boolean;
  languages: Language[];
  files: number;
}

/** `clewmap init`: конфиг по найденным языкам и папкам, манифест, строки в .gitignore. */
export async function init(
  root: string,
  opts: { force?: boolean; hooks?: boolean; log?: Log } = {},
): Promise<InitResult> {
  const log = opts.log ?? (() => {});
  const files = await scanFiles(root, parseConfig({ exclude: DEFAULT_EXCLUDE }));
  const languages = [...new Set(files.map((f) => languageOf(grammarFor(f)!)))].sort() as Language[];

  const configPath = path.join(root, CONFIG_FILE);
  let configCreated = false;
  if (existsSync(configPath) && !opts.force) {
    log(`${pc.yellow('•')} ${CONFIG_FILE} already exists, keeping it (use --force to regenerate)`);
  } else {
    const inSrc = files.length > 0 && files.every((f) => f.startsWith('src/'));
    const prefixes = new Map<string, Set<string>>();
    for (const file of files) {
      const dirs = file.split('/').slice(0, -1);
      for (let i = dirs.length - 1; i >= 0; i--) {
        const layer = layerForDir(dirs[i]!);
        if (!layer) continue;
        const set = prefixes.get(layer) ?? new Set<string>();
        set.add(dirs.slice(0, i + 1).join('/'));
        prefixes.set(layer, set);
        break;
      }
    }
    const layers: Record<string, { label: string; color: string; globs: string[] }> = {};
    for (const [name, meta] of Object.entries(DEFAULT_LAYERS)) {
      layers[name] = {
        ...meta,
        globs: name === 'external' ? [] : minimalGlobs(prefixes.get(name) ?? new Set()),
      };
    }
    const config = {
      include: inSrc ? ['src/**'] : ['**'],
      exclude: DEFAULT_EXCLUDE,
      layers,
      links: { apiPrefix: null, httpClients: [] },
      summaries: {
        provider: 'claude-cli',
        model: null,
        language: 'ru',
        batchSize: 20,
        blocksMinLines: 8,
      },
      hooks: {
        preCommit: true,
        postCommit: true,
        summarize: 'post-commit',
        summarizeTimeout: 120,
      },
    };
    parseConfig(config);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    configCreated = true;
    log(
      `${pc.green('✓')} created ${CONFIG_FILE} (${languages.join(', ') || 'no supported languages found'})`,
    );
  }

  if (!(await readManifest(root))) {
    await writeManifest(root, {
      formatVersion: FORMAT_VERSION,
      generator: GENERATOR,
      languages,
      lastCommit: null,
      updatedAt: new Date().toISOString(),
    });
    log(`${pc.green('✓')} created .clewmap/manifest.json`);
  }

  const gitignorePath = path.join(root, '.gitignore');
  const current = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    await appendFile(
      gitignorePath,
      `${prefix}${current ? '\n' : ''}# clewmap\n${missing.join('\n')}\n`,
      'utf8',
    );
    log(`${pc.green('✓')} added clewmap service files to .gitignore`);
  }

  if (opts.hooks) await hook(root, 'install', { log });
  else log(`${pc.dim('tip:')} clewmap hook install keeps the graph in sync on every commit`);
  log(`${pc.dim('next:')} clewmap build`);
  return { configCreated, languages, files: files.length };
}

function describeSync(stats: SyncResult): string {
  const parts = [`${stats.written} module file(s) written`];
  if (stats.deleted) parts.push(`${stats.deleted} removed`);
  if (stats.renamed) parts.push(`${stats.renamed} renamed`);
  if (stats.queued) parts.push(`${stats.queued} queued for summaries`);
  if (stats.staleMarked) parts.push(`${stats.staleMarked} summaries marked stale`);
  return stats.written + stats.deleted + stats.queued + stats.staleMarked
    ? parts.join(', ')
    : 'graph unchanged';
}

function printSummaries(stats: SummarizeStats, log: Log): void {
  if (stats.locked) return;
  const parts = [`${stats.done} described`];
  if (stats.failed) parts.push(pc.yellow(`${stats.failed} failed`));
  if (stats.skipped) parts.push(`${stats.skipped} skipped`);
  parts.push(`${stats.remaining} left in queue`);
  log(
    `${stats.failed ? pc.yellow('•') : pc.green('✓')} summaries: ${parts.join(', ')} in ${(stats.ms / 1000).toFixed(1)} s` +
      (stats.tokens && (stats.tokens.input || stats.tokens.output)
        ? pc.dim(` (${formatTokens(stats.tokens)})`)
        : ''),
  );
}

function formatTokens(t: { input: number; output: number }): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `tokens: ${k(t.input)} in, ${k(t.output)} out`;
}

/** `clewmap build`: полная индексация, затем описания всего, чего ещё нет (если не --no-summaries). */
export async function build(
  root: string,
  opts: { log?: Log; summaries?: boolean; provider?: SummaryProvider } = {},
) {
  const log = opts.log ?? (() => {});
  const stats = await buildGraph(root);
  log(
    `${pc.green('✓')} ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges ` +
      `(${stats.resolvedEdges} resolved, ${stats.linkEdges} cross-boundary) in ${stats.ms} ms`,
  );
  log(pc.dim(describeSync(stats)));
  if (opts.summaries !== false) {
    const config = await readConfig(root);
    const s = await runSummaries(root, {
      provider: opts.provider ?? createProvider(config),
      config,
      log: (l) => log(pc.dim(l)),
    });
    printSummaries(s, log);
  }
  return stats;
}

export interface UpdateOptions {
  mode: UpdateMode;
  quiet?: boolean;
  log?: Log;
}

/**
 * `clewmap update`: переиндексирует изменённое, переносит описания, ставит задачи в очередь.
 * Никогда не вызывает LLM. Молча выходит, если граф не создан или идёт rebase/merge.
 */
export async function update(root: string, opts: UpdateOptions): Promise<SyncResult | null> {
  const log = opts.log ?? (() => {});
  if (process.env.CLEWMAP_SKIP) return null;
  if (!(await readManifest(root).catch(() => null))) {
    if (!opts.quiet)
      log(`${pc.yellow('•')} no .clewmap/ here — run ${pc.bold('clewmap init')} first`);
    return null;
  }
  if (opts.mode.kind === 'staged' && (await gitBusy(root))) {
    if (!opts.quiet) log(pc.dim('rebase/merge/cherry-pick in progress, skipping'));
    return null;
  }
  const stats = await updateGraph(root, opts.mode);
  if (!opts.quiet) {
    log(`${pc.green('✓')} ${stats.parsed} file(s) re-parsed of ${stats.files} in ${stats.ms} ms`);
    log(pc.dim(describeSync(stats)));
  } else if (stats.written || stats.deleted) {
    log(`clewmap: ${describeSync(stats)}`);
  }
  return stats;
}

export interface SummarizeCliOptions {
  mode?: SummarizeMode;
  limit?: number;
  background?: boolean;
  quiet?: boolean;
  log?: Log;
  provider?: SummaryProvider;
  /** Для --background: как перезапустить себя (node + путь к bin.js). */
  self?: { node: string; bin: string };
  /** Вызов из хука: pre-commit описывает, только если hooks.summarize = "pre-commit". */
  hook?: HookName;
  /** Провайдер и модель поверх clewmap.config.json (для CI: --provider anthropic). */
  providerName?: string;
  model?: string;
}

export function summarizeLogPath(root: string): string {
  return path.join(root, CLEWMAP_DIR, CACHE_DIR, 'summarize.log');
}

/** Окружение для фонового процесса: без переменных git из хука. */
function detachedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

/** `clewmap summarize`: разбирает очередь описаний; --background — отсоединённым процессом. */
export async function summarizeCommand(
  root: string,
  opts: SummarizeCliOptions = {},
): Promise<SummarizeStats | { background: true; pid: number | undefined } | null> {
  const log = opts.log ?? (() => {});
  if (process.env.CLEWMAP_SKIP) return null;
  if (!(await readManifest(root).catch(() => null))) {
    if (!opts.quiet)
      log(`${pc.yellow('•')} no .clewmap/ here — run ${pc.bold('clewmap init')} first`);
    return null;
  }
  if (opts.hook === 'pre-commit') return preCommitSummaries(root, opts);
  const mode = opts.mode ?? 'queue';
  if (opts.background) {
    if (mode === 'queue' && !(await readQueue(root)).items.length) return null;
    const holder = await readLock(root);
    if (holder && !isStale(holder, 2 * 60 * 60 * 1000)) return null;
    const self = opts.self ?? { node: process.execPath, bin: process.argv[1]! };
    const logFile = summarizeLogPath(root);
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `\n=== ${new Date().toISOString()} summarize (${mode}) ===\n`);
    const fd = openSync(logFile, 'a');
    const args = [self.bin, '--cwd', root, 'summarize'];
    if (mode === 'all') args.push('--all');
    if (mode === 'stale') args.push('--stale');
    if (opts.limit) args.push('--limit', String(opts.limit));
    if (opts.providerName) args.push('--provider', opts.providerName);
    if (opts.model) args.push('--model', opts.model);
    const child = spawn(self.node, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: detachedEnv(),
      windowsHide: true,
    });
    child.unref();
    if (!opts.quiet)
      log(
        `${pc.green('✓')} summarizing in background (pid ${child.pid}), log: ${path.relative(root, logFile)}`,
      );
    return { background: true, pid: child.pid };
  }
  const base: Config = await readConfig(root);
  const config: Config = {
    ...base,
    summaries: {
      ...base.summaries,
      ...(opts.providerName ? { provider: opts.providerName } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    },
  };
  const stats = await runSummaries(root, {
    provider: opts.provider ?? createProvider(config),
    config,
    mode,
    limit: opts.limit,
    log: (l) => log(pc.dim(l)),
  });
  printSummaries(stats, log);
  return stats;
}

/**
 * Описания из pre-commit (hooks.summarize = "pre-commit"): коммит ждёт, пока модель опишет изменённый код,
 * чтобы описания уехали в том же коммите. Ждёт не дольше hooks.summarizeTimeout секунд (null — сколько нужно);
 * по истечении текущий вызов отменяется, готовое остаётся, остальное доделает post-commit в фоне.
 * Сообщения идут в stderr: git показывает их, пока коммит ждёт. Никогда не бросает.
 */
async function preCommitSummaries(
  root: string,
  opts: SummarizeCliOptions,
): Promise<SummarizeStats | null> {
  const say = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  let config: Config;
  try {
    config = await readConfig(root);
  } catch {
    return null;
  }
  if (config.hooks.summarize !== 'pre-commit' || (await gitBusy(root))) return null;
  const queued = (await readQueue(root).catch(() => ({ items: [] }))).items.length;
  if (!queued) return null;
  const limit = config.hooks.summarizeTimeout;
  say(
    `clewmap: describing changed code before the commit (${queued} in queue, ` +
      `${limit === null ? 'no time limit' : `up to ${limit} s`}; CLEWMAP_SKIP=1 skips)…`,
  );
  const ctrl = new AbortController();
  const timer = limit === null ? null : setTimeout(() => ctrl.abort(), limit * 1000);
  timer?.unref();
  try {
    const stats = await runSummaries(root, {
      provider: opts.provider ?? createProvider(config),
      config,
      mode: 'queue',
      log: () => {},
      signal: ctrl.signal,
      waitForLock: true,
      retries: 1,
    });
    const tokens = stats.tokens ? `, ${formatTokens(stats.tokens)}` : '';
    const left = stats.remaining
      ? `; ${stats.remaining} left for the background run after the commit`
      : '';
    say(
      `clewmap: ${stats.done} described in ${(stats.ms / 1000).toFixed(1)} s${tokens}` +
        `${stats.aborted ? ' (time limit reached)' : ''}${left}`,
    );
    return stats;
  } catch (e) {
    say(
      `clewmap: summaries skipped (${e instanceof Error ? e.message : String(e)}), the commit goes on`,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `clewmap hook install | uninstall`. */
export async function hook(
  root: string,
  action: 'install' | 'uninstall',
  opts: { log?: Log; self?: { node: string; bin: string } } = {},
): Promise<HookChange[]> {
  const log = opts.log ?? (() => {});
  let changes: HookChange[];
  if (action === 'install') {
    const config = await readConfig(root).catch(() => null);
    const hooks: HookName[] = [];
    if (config?.hooks.preCommit !== false) hooks.push('pre-commit');
    if (config?.hooks.postCommit !== false) hooks.push('post-commit');
    const self =
      opts.self ??
      (process.argv[1] ? { node: process.execPath, bin: path.resolve(process.argv[1]) } : null);
    changes = await installHooks(root, { hooks, fallback: self });
  } else {
    changes = await uninstallHooks(root);
  }
  for (const c of changes)
    log(`${pc.green('✓')} ${c.hook}: ${c.action} (${path.relative(root, c.file)})`);
  if (!changes.length) log(pc.dim('no clewmap hooks found'));
  return changes;
}

export type StatusResult = Omit<GraphStatus, 'initialized'>;

/** `clewmap status`: актуален ли граф и сколько символов ждут описаний. */
export async function status(root: string, opts: { log?: Log } = {}): Promise<StatusResult> {
  const log = opts.log ?? (() => {});
  const st = await graphStatus(root);
  const result: StatusResult = { ...st };
  delete (result as Partial<GraphStatus>).initialized;
  if (!st.initialized) {
    log(`${pc.red('✗')} no .clewmap/ here — run ${pc.bold('clewmap init')} first`);
    return result;
  }
  const { upToDate, changed, added, removed, symbols, withoutSummary, stale, queued, head } = st;
  const manifest = { lastCommit: st.lastCommit };
  log(`${upToDate ? pc.green('✓ graph is up to date') : pc.yellow('• graph is out of date')}`);
  log(
    `  commit:   ${manifest.lastCommit?.slice(0, 8) ?? 'none'}${head ? ` (HEAD ${head.slice(0, 8)})` : ''}`,
  );
  const list = (label: string, items: string[]) => {
    if (!items.length) return;
    log(
      `  ${label} ${items.length}: ${items.slice(0, 5).join(', ')}${items.length > 5 ? ', …' : ''}`,
    );
  };
  list('changed:', changed);
  list('new:    ', added);
  list('removed:', removed);
  log(
    `  symbols:  ${symbols}, without summary ${withoutSummary}, stale ${stale}, queued ${queued}`,
  );
  if (!upToDate) log(`${pc.dim('run:')} clewmap update`);
  else if (queued) log(`${pc.dim('run:')} clewmap summarize`);
  return result;
}
