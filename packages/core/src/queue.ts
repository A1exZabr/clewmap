import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CLEWMAP_DIR } from './paths.js';
import { writeAtomic } from './store.js';

/**
 * Очередь описаний `.clewmap/.queue.json` (в .gitignore). Её пополняет `clewmap update`/`build`,
 * разбирает `clewmap summarize`. Здесь только формат и атомарные правки файла;
 * блокировка и обработка пачками — в @clewmap/summarizer.
 */

export const QUEUE_FILE = '.queue.json';
export const LOCK_FILE = '.lock';
export const CACHE_DIR = '.cache';

export const QueuePrioritySchema = z.enum(['high', 'low']);
export type QueuePriority = z.infer<typeof QueuePrioritySchema>;

export const QueueItemSchema = z.object({
  id: z.string(),
  /** high — код новый или изменился; low — устарело из-за сигнатуры соседа. */
  priority: QueuePrioritySchema,
  /** bodyHash, для которого нужно описание. Если код снова поменялся, задача устарела. */
  bodyHash: z.string(),
  attempts: z.number().int().min(0).default(0),
  addedAt: z.string(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const QueueSchema = z.object({
  version: z.literal(1),
  items: z.array(QueueItemSchema),
});
export type Queue = z.infer<typeof QueueSchema>;

export function queuePath(root: string): string {
  return path.join(root, CLEWMAP_DIR, QUEUE_FILE);
}

export async function readQueue(root: string): Promise<Queue> {
  try {
    return QueueSchema.parse(JSON.parse(await readFile(queuePath(root), 'utf8')));
  } catch {
    // нет файла или он битый: очередь можно восстановить командой summarize --all
    return { version: 1, items: [] };
  }
}

function sortItems(items: QueueItem[]): QueueItem[] {
  return items.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority === 'high'
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
}

export async function writeQueue(root: string, queue: Queue): Promise<void> {
  const parsed = QueueSchema.parse({ version: 1, items: sortItems([...queue.items]) });
  await writeAtomic(queuePath(root), JSON.stringify(parsed, null, 2) + '\n');
}

export interface EnqueueInput {
  id: string;
  priority: QueuePriority;
  bodyHash: string;
}

/** Добавляет задачи. Одна задача на id: новый bodyHash заменяет старый, high важнее low. */
export async function enqueue(root: string, inputs: readonly EnqueueInput[]): Promise<number> {
  if (!inputs.length) return 0;
  const queue = await readQueue(root);
  const byId = new Map(queue.items.map((i) => [i.id, i]));
  const now = new Date().toISOString();
  let added = 0;
  for (const input of inputs) {
    const old = byId.get(input.id);
    if (!old) added++;
    const priority: QueuePriority =
      old && old.bodyHash === input.bodyHash && old.priority === 'high' ? 'high' : input.priority;
    byId.set(input.id, {
      id: input.id,
      priority,
      bodyHash: input.bodyHash,
      attempts: old && old.bodyHash === input.bodyHash ? old.attempts : 0,
      addedAt: old?.addedAt ?? now,
    });
  }
  await writeQueue(root, { version: 1, items: [...byId.values()] });
  return added;
}

/** Убирает задачи по id (например, символ удалён или описан). */
export async function dequeue(
  root: string,
  done: ReadonlyMap<string, string | null>,
): Promise<void> {
  if (!done.size) return;
  const queue = await readQueue(root);
  const items = queue.items.filter((i) => {
    if (!done.has(i.id)) return true;
    const hash = done.get(i.id);
    // задачу для более нового кода, добавленную во время описания, не трогаем
    return hash !== null && hash !== i.bodyHash;
  });
  if (items.length !== queue.items.length) await writeQueue(root, { version: 1, items });
}
