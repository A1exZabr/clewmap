import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONFIG_FILE,
  DEFAULT_LAYERS,
  FORMAT_VERSION,
  GENERATOR,
  listModuleFiles,
  parseConfig,
  readConfig,
  readManifest,
  readModule,
  sha256,
  writeManifest,
  type Language,
} from '@clewmap/core';
import {
  buildGraph,
  gitHead,
  grammarFor,
  languageOf,
  layerForDir,
  scanFiles,
} from '@clewmap/indexer';
import pc from 'picocolors';

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
  opts: { force?: boolean; log?: Log } = {},
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
      hooks: { preCommit: true, postCommit: true },
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

  log(`${pc.dim('next:')} clewmap build`);
  return { configCreated, languages, files: files.length };
}

/** `clewmap build`: полная индексация без описаний. */
export async function build(root: string, opts: { log?: Log } = {}) {
  const log = opts.log ?? (() => {});
  const stats = await buildGraph(root);
  const changed = stats.written + stats.deleted;
  log(
    `${pc.green('✓')} ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges ` +
      `(${stats.resolvedEdges} resolved, ${stats.linkEdges} cross-boundary) in ${stats.ms} ms`,
  );
  log(
    pc.dim(
      changed
        ? `${stats.written} module files written, ${stats.deleted} removed`
        : 'graph unchanged',
    ),
  );
  return stats;
}

export interface StatusResult {
  upToDate: boolean;
  lastCommit: string | null;
  head: string | null;
  changed: string[];
  added: string[];
  removed: string[];
  symbols: number;
  withoutSummary: number;
  stale: number;
}

/** `clewmap status`: актуален ли граф и сколько символов ждут описаний. */
export async function status(root: string, opts: { log?: Log } = {}): Promise<StatusResult> {
  const log = opts.log ?? (() => {});
  const manifest = await readManifest(root);
  if (!manifest) {
    log(`${pc.red('✗')} no .clewmap/ here — run ${pc.bold('clewmap init')} first`);
    return {
      upToDate: false,
      lastCommit: null,
      head: null,
      changed: [],
      added: [],
      removed: [],
      symbols: 0,
      withoutSummary: 0,
      stale: 0,
    };
  }
  const config = await readConfig(root);
  const head = await gitHead(root);
  const files = await scanFiles(root, config);
  const known = new Set(await listModuleFiles(root));
  const changed: string[] = [];
  const added: string[] = [];
  let symbols = 0;
  let withoutSummary = 0;
  let stale = 0;
  for (const file of files) {
    if (!known.has(file)) {
      added.push(file);
      continue;
    }
    known.delete(file);
    const m = await readModule(root, file);
    if (!m) continue;
    if (m.fileHash !== sha256(await readFile(path.join(root, file), 'utf8'))) changed.push(file);
    for (const s of m.symbols) {
      symbols++;
      if (!s.summary) withoutSummary++;
      else if (s.summary.stale) stale++;
    }
  }
  const removed = [...known].sort();
  const commitOk = head === null || manifest.lastCommit === head;
  const upToDate = commitOk && !changed.length && !added.length && !removed.length;

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
  log(`  symbols:  ${symbols}, without summary ${withoutSummary}, stale ${stale}`);
  if (!upToDate) log(`${pc.dim('run:')} clewmap build`);
  return {
    upToDate,
    lastCommit: manifest.lastCommit,
    head,
    changed,
    added,
    removed,
    symbols,
    withoutSummary,
    stale,
  };
}
