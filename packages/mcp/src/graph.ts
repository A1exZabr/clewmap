import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  CLEWMAP_DIR,
  GraphIndex,
  MANIFEST_FILE,
  readConfig,
  readGraph,
  readManifest,
  type Config,
  type Manifest,
} from '@clewmap/core';

/**
 * Корень проекта: ищем `.clewmap/manifest.json` от start вверх, но не выше корня git-репозитория
 * (папки с `.git`) — чтобы не подхватить граф из соседнего проекта выше по дереву.
 */
export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CLEWMAP_DIR, MANIFEST_FILE))) return dir;
    if (existsSync(path.join(dir, '.git'))) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Граф в памяти. Следит за `.clewmap/` и перечитывает его через 300 мс после последнего изменения. */
export class GraphHolder {
  index = new GraphIndex([]);
  config: Config | null = null;
  manifest: Manifest | null = null;
  loadedAt = 0;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | undefined;
  private loading: Promise<void> | null = null;
  private dirty = true;

  constructor(readonly root: string) {}

  /** Свежий индекс: при первом обращении и после изменений `.clewmap/` перечитывает граф. */
  async get(): Promise<GraphIndex> {
    if (this.dirty) await this.reload();
    return this.index;
  }

  async reload(): Promise<void> {
    this.loading ??= (async () => {
      this.dirty = false;
      const [graph, config, manifest] = await Promise.all([
        readGraph(this.root),
        readConfig(this.root).catch(() => null),
        readManifest(this.root).catch(() => null),
      ]);
      this.index = new GraphIndex(graph.modules);
      this.config = config;
      this.manifest = manifest;
      this.loadedAt = Date.now();
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(path.join(this.root, CLEWMAP_DIR), { recursive: true }, (_e, name) => {
        const file = String(name ?? '');
        // Кэш, очередь и блокировка — не граф.
        if (file.startsWith('.cache') || file.startsWith(`.queue`) || file.startsWith('.lock'))
          return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.dirty = true;
        }, 300);
      });
      this.watcher.on('error', () => {
        // Нет наблюдения — значит, перечитываем на каждый запрос.
        this.watcher = null;
        this.dirty = true;
      });
    } catch {
      this.watcher = null;
    }
  }

  /** Принудительно перечитать при следующем запросе (после clewmap_update). */
  invalidate(): void {
    this.dirty = true;
  }

  close(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }
}
