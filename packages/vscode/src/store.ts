import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  GraphIndex,
  readConfig,
  readGraph,
  readManifest,
  readModule,
  sha256,
  type Config,
  type Manifest,
  type ModuleFile,
} from '@clewmap/core';
import { commitChanges, headInfo } from './git.js';
import { layersOf, type LayerInfo } from './model/graph.js';
import type { LastCommit } from './model/hover.js';
import { emptyModel, exactModel, locateInText, type DocModel } from './model/locate.js';

const DEBOUNCE_MS = 300;

/**
 * Граф одного корня проекта в памяти: модули, индекс, конфиг, последний коммит, актуальность файлов.
 * Следит за `.clewmap/**\/*.json` и перечитывает только изменённые модули (с дебаунсом 300 мс).
 */
export class GraphStore implements vscode.Disposable {
  index = new GraphIndex([]);
  config: Config | null = null;
  layers: Map<string, LayerInfo> = layersOf(null);
  manifest: Manifest | null = null;
  lastCommit: LastCommit | null = null;
  /** Файлы, чей текст на диске уже не совпадает с fileHash в графе. */
  outdated = new Set<string>();
  freshnessChecked = false;

  private readonly modules = new Map<string, ModuleFile>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly docs = new Map<string, { version: number; model: DocModel }>();
  private readonly docJobs = new Map<string, Promise<DocModel>>();

  private constructor(readonly root: string) {}

  static async open(root: string): Promise<GraphStore> {
    const store = new GraphStore(root);
    await store.loadAll();
    store.watch();
    return store;
  }

  /** Путь от корня с «/», как в графе. null — файл вне этого корня. */
  relative(fsPath: string): string | null {
    const rel = path.relative(this.root, fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  uriOf(file: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, ...file.split('/')));
  }

  module(file: string): ModuleFile | undefined {
    return this.modules.get(file);
  }

  private async loadAll(): Promise<void> {
    const [graph, config, manifest] = await Promise.all([
      readGraph(this.root).catch(() => ({ modules: [] as ModuleFile[] })),
      readConfig(this.root).catch(() => null),
      readManifest(this.root).catch(() => null),
    ]);
    this.modules.clear();
    for (const m of graph.modules) this.modules.set(m.file, m);
    this.config = config;
    this.layers = layersOf(config);
    this.manifest = manifest;
    this.rebuild();
    await this.refreshCommit();
    void this.checkFreshness();
  }

  private rebuild(): void {
    this.index = new GraphIndex(this.modules.values());
    this.docs.clear();
  }

  private watch(): void {
    const pattern = new vscode.RelativePattern(
      this.root,
      '{.clewmap/**/*.json,clewmap.config.json}',
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const service = path.join(this.root, '.clewmap', '.cache');
    const queue = (uri: vscode.Uri) => {
      // Кэш, очередь и объяснения — не граф: их записи не должны перестраивать индекс.
      if (uri.fsPath.startsWith(service + path.sep) || uri.fsPath.endsWith('.queue.json')) return;
      this.pending.add(uri.fsPath);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
    };
    watcher.onDidChange(queue, null, this.disposables);
    watcher.onDidCreate(queue, null, this.disposables);
    watcher.onDidDelete(queue, null, this.disposables);
    this.disposables.push(watcher);

    // Новый коммит без изменений графа (например, только документация) тоже меняет «последний коммит».
    const head = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, '.git/logs/HEAD'),
    );
    const onHead = () => void this.refreshCommit().then(() => this.emitter.fire());
    head.onDidChange(onHead, null, this.disposables);
    head.onDidCreate(onHead, null, this.disposables);
    this.disposables.push(head);

    vscode.workspace.onDidSaveTextDocument(
      (doc) => void this.checkFile(doc.uri.fsPath),
      null,
      this.disposables,
    );
  }

  private async flush(): Promise<void> {
    const paths = [...this.pending];
    this.pending.clear();
    const modulesDir = path.join(this.root, '.clewmap', 'modules');
    let manifestChanged = false;
    for (const p of paths) {
      if (p === path.join(this.root, 'clewmap.config.json')) {
        this.config = await readConfig(this.root).catch(() => null);
        this.layers = layersOf(this.config);
        continue;
      }
      if (p === path.join(this.root, '.clewmap', 'manifest.json')) {
        manifestChanged = true;
        continue;
      }
      const rel = path.relative(modulesDir, p);
      if (rel.startsWith('..') || !rel.endsWith('.json')) continue;
      const file = rel.slice(0, -'.json'.length).split(path.sep).join('/');
      const m = await readModule(this.root, file).catch(() => null);
      if (m) this.modules.set(file, m);
      else this.modules.delete(file);
    }
    if (manifestChanged) this.manifest = await readManifest(this.root).catch(() => null);
    this.rebuild();
    if (manifestChanged) await this.refreshCommit();
    void this.checkFreshness();
    this.emitter.fire();
  }

  async reload(): Promise<void> {
    await this.loadAll();
    this.emitter.fire();
  }

  private async refreshCommit(): Promise<void> {
    const head = await headInfo(this.root);
    if (!head) {
      this.lastCommit = null;
      return;
    }
    if (this.lastCommit?.sha === head.sha) return;
    this.lastCommit = { ...head, changed: await commitChanges(this.root, head.sha) };
  }

  /** Сверяет fileHash каждого модуля с файлом на диске: так статус знает, отстаёт ли граф. */
  private async checkFreshness(): Promise<void> {
    const outdated = new Set<string>();
    const files = [...this.modules.keys()];
    for (let i = 0; i < files.length; i += 32) {
      await Promise.all(
        files.slice(i, i + 32).map(async (file) => {
          const text = await readFile(path.join(this.root, file), 'utf8').catch(() => null);
          if (text === null || sha256(text) !== this.modules.get(file)?.fileHash)
            outdated.add(file);
        }),
      );
    }
    const changed =
      !this.freshnessChecked ||
      outdated.size !== this.outdated.size ||
      [...outdated].some((f) => !this.outdated.has(f));
    this.outdated = outdated;
    this.freshnessChecked = true;
    if (changed) this.emitter.fire();
  }

  private async checkFile(fsPath: string): Promise<void> {
    const file = this.relative(fsPath);
    const m = file ? this.modules.get(file) : undefined;
    if (!file || !m) return;
    const text = await readFile(fsPath, 'utf8').catch(() => null);
    const isOutdated = text === null || sha256(text) !== m.fileHash;
    if (isOutdated === this.outdated.has(file)) return;
    if (isOutdated) this.outdated.add(file);
    else this.outdated.delete(file);
    this.emitter.fire();
  }

  /** Последняя готовая модель документа, без ожидания (для hover: ответ должен быть мгновенным). */
  peek(doc: vscode.TextDocument): DocModel | null {
    const file = this.relative(doc.uri.fsPath);
    if (!file) return null;
    const cached = this.docs.get(doc.uri.toString());
    if (cached) return cached.model;
    const m = this.modules.get(file);
    if (!m) return emptyModel(file);
    // Пока модель не посчитана: если файл не правили, позиции из графа точны.
    return !doc.isDirty && !this.outdated.has(file) ? exactModel(m) : null;
  }

  /** Модель документа для его текущей версии: символы графа на своих местах в тексте. */
  docModel(doc: vscode.TextDocument): Promise<DocModel> {
    const key = doc.uri.toString();
    const cached = this.docs.get(key);
    if (cached && cached.version === doc.version) return Promise.resolve(cached.model);
    const jobKey = `${key}@${doc.version}`;
    const running = this.docJobs.get(jobKey);
    if (running) return running;
    const file = this.relative(doc.uri.fsPath);
    const m = file ? this.modules.get(file) : undefined;
    const version = doc.version;
    const job = (m ? locateInText(m, doc.getText()) : Promise.resolve(emptyModel(file ?? ''))).then(
      (model) => {
        this.docJobs.delete(jobKey);
        const current = this.docs.get(key);
        if (!current || current.version <= version) this.docs.set(key, { version, model });
        return model;
      },
    );
    this.docJobs.set(jobKey, job);
    return job;
  }

  forget(doc: vscode.TextDocument): void {
    this.docs.delete(doc.uri.toString());
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
