import {
  GraphIndex,
  dequeue,
  enqueue,
  readConfig,
  readGraph,
  readModule,
  readQueue,
  writeModule,
  writeQueue,
  type CodeBlock,
  type Config,
  type EnqueueInput,
  type QueueItem,
  type Summary,
  type SymbolNode,
} from '@clewmap/core';
import { SUMMARIZABLE_KINDS } from '@clewmap/indexer';
import { acquireLock, readLock } from './lock.js';
import { callLevels, makeBatches } from './order.js';
import { SourceCache, prepareRequest, type PreparedRequest } from './requests.js';
import {
  ProviderUnavailableError,
  SummarizeAbortedError,
  type SummaryProvider,
  type SummaryResult,
} from './types.js';

export type SummarizeMode = 'queue' | 'all' | 'stale';

export interface SummarizeOptions {
  provider: SummaryProvider;
  config?: Config;
  /** queue — только очередь; all — все символы без актуального описания; stale — только устаревшие. */
  mode?: SummarizeMode;
  /** Сколько символов описать за запуск. */
  limit?: number;
  log?: (line: string) => void;
  /** Повторов пачки после первой неудачи (пауза 1 с, 2 с, 4 с…). */
  retries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  lockStaleMs?: number;
  /** Остановка по лимиту времени: текущий вызов отменяется, сделанное сохранено, остальное ждёт в очереди. */
  signal?: AbortSignal;
  /** Если блокировку держит другой процесс, ждать её (до signal), а не уходить сразу. */
  waitForLock?: boolean;
}

export interface SummarizeStats {
  /** Блокировку держит другой процесс: этот ничего не делал. */
  locked: boolean;
  done: number;
  failed: number;
  /** Пропущены: исходник не совпал с графом или символа уже нет. */
  skipped: number;
  remaining: number;
  batches: number;
  ms: number;
  /** Остановлен по signal (лимит времени). */
  aborted: boolean;
  /** Токены за этот запуск, если провайдер их сообщает. */
  tokens: { input: number; output: number } | null;
}

/** После стольких неудачных попыток задача остаётся в очереди, но не мешает остальным. */
const MAX_ATTEMPTS = 5;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Пауза, которая заканчивается раньше, если пришёл signal. */
function pause(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return Promise.race([
    sleep(ms),
    new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
  ]);
}

function needsSummary(s: SymbolNode, mode: SummarizeMode): boolean {
  if (!SUMMARIZABLE_KINDS.has(s.kind)) return false;
  const valid = s.summary !== null && s.summary.forBodyHash === s.bodyHash;
  if (mode === 'stale') return valid && s.summary!.stale;
  return !valid || s.summary!.stale;
}

/** Задача ещё актуальна: символ есть, код тот же, описания для этого кода нет или оно устарело. */
function stillNeeded(item: QueueItem, index: GraphIndex): boolean {
  const s = index.get(item.id);
  if (!s || s.bodyHash !== item.bodyHash || !SUMMARIZABLE_KINDS.has(s.kind)) return false;
  return !s.summary || s.summary.forBodyHash !== s.bodyHash || s.summary.stale;
}

function toBlocks(prepared: PreparedRequest, result: SummaryResult): CodeBlock[] | null {
  const st = prepared.statements;
  if (!st || !result.blocks) return null;
  return result.blocks.map((b) => ({
    range: { start: st[b.from]!.range.start, end: st[b.to]!.range.end },
    statements: [b.from, b.to] as [number, number],
    label: b.label,
    text: b.text,
    forBodyHash: prepared.request.bodyHash,
  }));
}

/**
 * Записывает описания в модули на диске. Модуль перечитывается перед записью, и описание
 * ставится, только если код символа не поменялся, пока модель думала (bodyHash тот же).
 */
async function applyResults(
  root: string,
  index: GraphIndex,
  results: Map<string, { summary: Summary; blocks: CodeBlock[] | null }>,
): Promise<Set<string>> {
  const byFile = new Map<string, string[]>();
  for (const id of results.keys()) {
    const file = index.fileOfSymbol(id);
    if (!file) continue;
    byFile.set(file, [...(byFile.get(file) ?? []), id]);
  }
  const applied = new Set<string>();
  for (const [file, ids] of byFile) {
    const module = await readModule(root, file).catch(() => null);
    if (!module) continue;
    let changed = false;
    for (const s of module.symbols) {
      const r = results.get(s.id);
      if (!r || !ids.includes(s.id) || s.bodyHash !== r.summary.forBodyHash) continue;
      s.summary = r.summary;
      if (r.blocks || s.blocks?.some((b) => b.forBodyHash !== s.bodyHash)) s.blocks = r.blocks;
      changed = true;
      applied.add(s.id);
      const mem = index.get(s.id);
      if (mem) {
        mem.summary = s.summary;
        mem.blocks = s.blocks;
      }
    }
    if (changed) await writeModule(root, module);
  }
  return applied;
}

async function bumpAttempts(root: string, ids: readonly string[]): Promise<void> {
  const queue = await readQueue(root);
  const set = new Set(ids);
  for (const item of queue.items) if (set.has(item.id)) item.attempts++;
  await writeQueue(root, queue);
}

/**
 * `clewmap summarize`: разбирает очередь `.clewmap/.queue.json` под блокировкой `.clewmap/.lock`.
 * Листья графа описываются первыми, пачками по batchSize; неудачная пачка повторяется
 * с экспоненциальной паузой; результаты пишутся после каждой пачки, так что прерванный
 * запуск ничего не теряет.
 */
export async function summarize(root: string, opts: SummarizeOptions): Promise<SummarizeStats> {
  const started = performance.now();
  const log = opts.log ?? (() => {});
  const mode = opts.mode ?? 'queue';
  const config = opts.config ?? (await readConfig(root));
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 3;
  const retryBaseMs = opts.retryBaseMs ?? 1000;
  const stats: SummarizeStats = {
    locked: false,
    done: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    batches: 0,
    ms: 0,
    aborted: false,
    tokens: null,
  };
  const signal = opts.signal;
  const usageAtStart = opts.provider.usage ? { ...opts.provider.usage } : null;
  const finish = () => {
    stats.ms = Math.round(performance.now() - started);
    stats.aborted = signal?.aborted ?? false;
    const u = opts.provider.usage;
    if (u && usageAtStart)
      stats.tokens = {
        input: u.input - usageAtStart.input,
        output: u.output - usageAtStart.output,
      };
    return stats;
  };

  let lock = await acquireLock(root, { staleMs: opts.lockStaleMs });
  if (!lock && opts.waitForLock) {
    const holder = await readLock(root);
    log(`waiting for another summarize (pid ${holder?.pid ?? '?'}) to finish…`);
    while (!lock && !signal?.aborted) {
      await pause(sleep, 500, signal);
      lock = await acquireLock(root, { staleMs: opts.lockStaleMs });
    }
  }
  if (!lock) {
    const holder = await readLock(root);
    if (!signal?.aborted)
      log(`another summarize is running (pid ${holder?.pid ?? '?'}), leaving the queue to it`);
    stats.locked = true;
    return finish();
  }

  try {
    const sources = new SourceCache(root);
    const attempted = new Set<string>();
    let budget = opts.limit ?? Infinity;

    if (mode !== 'queue') {
      const { modules } = await readGraph(root);
      const inputs: EnqueueInput[] = [];
      for (const m of modules)
        for (const s of m.symbols)
          if (needsSummary(s, mode))
            inputs.push({
              id: s.id,
              priority: s.summary?.stale ? 'low' : 'high',
              bodyHash: s.bodyHash,
            });
      await enqueue(root, inputs);
    }

    // Пока очередь пополняется (хук мог добавить задачи во время работы), берём новые.
    while (budget > 0 && !signal?.aborted) {
      const { modules } = await readGraph(root);
      const index = new GraphIndex(modules);
      const queue = await readQueue(root);
      const obsolete = new Map<string, string | null>();
      const items: QueueItem[] = [];
      for (const item of queue.items) {
        if (!stillNeeded(item, index)) obsolete.set(item.id, item.bodyHash);
        else if (!attempted.has(item.id) && item.attempts < MAX_ATTEMPTS) items.push(item);
      }
      await dequeue(root, obsolete);
      if (mode === 'stale') {
        for (let i = items.length - 1; i >= 0; i--)
          if (!index.get(items[i]!.id)?.summary?.stale) items.splice(i, 1);
      }
      if (!items.length) break;

      const levels = callLevels(
        items.map((i) => i.id),
        index,
      );
      const rank = (i: QueueItem) => (i.priority === 'high' ? 0 : 1_000_000) + levels.get(i.id)!;
      items.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
      const picked = items.slice(0, budget);
      budget -= picked.length;
      for (const i of picked) attempted.add(i.id);

      for (const batch of makeBatches(picked, rank, config.summaries.batchSize)) {
        if (signal?.aborted) break;
        // Запросы собираются перед каждой пачкой: у вызывающих уже есть свежие описания вызываемых.
        const prepared: PreparedRequest[] = [];
        for (const item of batch) {
          const p = await prepareRequest(item.id, index, config, sources);
          if (p) prepared.push(p);
          else stats.skipped++;
        }
        if (!prepared.length) continue;
        stats.batches++;

        let results: SummaryResult[] | null = null;
        for (let attempt = 0; attempt <= retries && !signal?.aborted; attempt++) {
          try {
            results = await opts.provider.summarize(
              prepared.map((p) => p.request),
              { signal },
            );
            break;
          } catch (e) {
            if (e instanceof ProviderUnavailableError) throw e;
            if (e instanceof SummarizeAbortedError || signal?.aborted) break;
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt === retries) {
              log(`batch of ${prepared.length} failed: ${msg}`);
              break;
            }
            const wait = retryBaseMs * 2 ** attempt;
            log(`batch failed (${msg}), retrying in ${Math.round(wait / 1000)} s`);
            await pause(sleep, wait, signal);
          }
        }
        // Отмена по лимиту времени не считается неудачей: задачи остаются в очереди как были.
        if (!results && signal?.aborted) break;
        if (!results) {
          stats.failed += prepared.length;
          await bumpAttempts(
            root,
            prepared.map((p) => p.request.id),
          );
          continue;
        }

        const now = new Date().toISOString();
        const byId = new Map(prepared.map((p) => [p.request.id, p]));
        const toApply = new Map<string, { summary: Summary; blocks: CodeBlock[] | null }>();
        for (const r of results) {
          const p = byId.get(r.id)!;
          toApply.set(r.id, {
            summary: {
              text: r.summary,
              forBodyHash: p.request.bodyHash,
              stale: false,
              model: opts.provider.model,
              createdAt: now,
            },
            blocks: toBlocks(p, r),
          });
        }
        const applied = await applyResults(root, index, toApply);
        const doneMap = new Map<string, string | null>();
        for (const id of applied) doneMap.set(id, byId.get(id)!.request.bodyHash);
        await dequeue(root, doneMap);
        stats.done += applied.size;
        const missing = prepared.filter((p) => !applied.has(p.request.id)).map((p) => p.request.id);
        if (missing.length) {
          stats.failed += missing.length;
          await bumpAttempts(root, missing);
        }
        log(`described ${stats.done} symbol(s)…`);
      }
    }

    const { modules } = await readGraph(root);
    const index = new GraphIndex(modules);
    stats.remaining = (await readQueue(root)).items.filter((i) => stillNeeded(i, index)).length;
  } finally {
    await lock.release();
  }
  return finish();
}
