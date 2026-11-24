import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { CLEWMAP_DIR, parseConfig, sha256, writeAtomic } from '@clewmap/core';
import { createProvider } from '@clewmap/summarizer';
import { explainContext } from './model/explain.js';
import type { Workspace } from './workspace.js';

export interface Explanation {
  id: string;
  forBodyHash: string;
  language: string;
  text: string;
  model: string;
  createdAt: string;
}

export function explanationPath(root: string, id: string): string {
  return path.join(root, CLEWMAP_DIR, '.cache', 'explanations', `${sha256(id).slice(0, 24)}.json`);
}

/**
 * «Объяснить подробнее»: узкий контекст (код + соседи на 1–2 шага + описание модуля) → провайдер
 * из clewmap.config.json. Ответ кэшируется по bodyHash: пока код тот же, модель второй раз не зовём.
 */
export class Explainer {
  constructor(private readonly ws: Workspace) {}

  language(root: string): string {
    const own = vscode.workspace.getConfiguration('clewmap').get<string>('summaryLanguage', '');
    return own || this.ws.stores.find((s) => s.root === root)?.config?.summaries.language || 'en';
  }

  async cached(id: string): Promise<Explanation | null> {
    const store = this.ws.storeOfId(id);
    const node = store?.index.get(id);
    if (!store || !node) return null;
    try {
      const e = JSON.parse(await readFile(explanationPath(store.root, id), 'utf8')) as Explanation;
      return e.forBodyHash === node.bodyHash && e.language === this.language(store.root) ? e : null;
    } catch {
      return null;
    }
  }

  async explain(id: string, signal?: AbortSignal): Promise<Explanation & { cached: boolean }> {
    const hit = await this.cached(id);
    if (hit) return { ...hit, cached: true };
    const store = this.ws.storeOfId(id);
    const node = store?.index.get(id);
    const file = store?.index.fileOfSymbol(id);
    if (!store || !node || !file) throw new Error(vscode.l10n.t('The symbol is not in the graph.'));

    // Код берём из текущего текста файла (с несохранёнными правками), по месту символа сейчас.
    const doc = await vscode.workspace.openTextDocument(store.uriOf(file));
    const model = await store.docModel(doc);
    const located = model.symbols.find((s) => s.node.id === id);
    const range = located?.range ?? node.range;
    const code = doc.getText(
      new vscode.Range(range.start[0], 0, Math.min(range.end[0] + 1, doc.lineCount), 0),
    );
    const ctx = explainContext(store.index, id, code);
    if (!ctx) throw new Error(vscode.l10n.t('The symbol is not in the graph.'));

    const config = store.config ?? parseConfig({});
    const language = this.language(store.root);
    const provider = createProvider({ ...config, summaries: { ...config.summaries, language } });
    if (!provider.explain)
      throw new Error(vscode.l10n.t('This summary provider cannot explain code.'));
    const text = await provider.explain(ctx, { signal });
    const result: Explanation = {
      id,
      forBodyHash: node.bodyHash,
      language,
      text,
      model: provider.model,
      createdAt: new Date().toISOString(),
    };
    await writeAtomic(explanationPath(store.root, id), JSON.stringify(result, null, 2) + '\n');
    return { ...result, cached: false };
  }
}
