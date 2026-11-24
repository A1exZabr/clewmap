// Показ экранов расширения по очереди для скриншотов. Следующий экран — когда появится файл-сигнал.
// CLEWMAP_DEMO=<проект> CLEWMAP_DEMO_SIGNAL=<файл> node dist/test/run.js
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ClewmapApi } from '../extension.js';

const ws = process.env.CLEWMAP_TEST_WORKSPACE!;
const signal = process.env.CLEWMAP_DEMO_SIGNAL!;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let api: ClewmapApi;

async function step(name: string): Promise<void> {
  writeFileSync(`${signal}.state`, name);
  writeFileSync(
    `${signal}.${name.split(' ')[0]}.json`,
    JSON.stringify({ type: 'state', state: api.panel.state() }),
  );
  const end = Date.now() + 10 * 60_000;
  while (!existsSync(signal) && Date.now() < end) await delay(200);
  rmSync(signal, { force: true });
}

export async function run(): Promise<void> {
  try {
    if (process.env.CLEWMAP_DEMO_SCENE === 'gif') {
      const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'clewmap-vscode')!;
      api = (await ext.activate()) as ClewmapApi;
      await api.ready;
      await gif();
    } else await demo();
  } catch (e) {
    writeFileSync(`${signal}.error`, e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  }
}

/** Сцены для GIF в README: строки над функциями → подсказка → коммит → «Влияние» и Δ. */
async function gif(): Promise<void> {
  const ORDER = 'src/bot/handlers/order.py';
  const PRICING = 'src/services/pricing.py';
  const create = `${ORDER}#create_order`;
  const promo = `${PRICING}#apply_promo`;
  const open = async (file: string) =>
    vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, file))),
      {
        preserveFocus: false,
      },
    );
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('clewmap.openOnGraph', create);
  let editor = await open(ORDER);
  editor.selection = new vscode.Selection(3, 0, 3, 0);
  editor.revealRange(new vscode.Range(0, 0, 20, 0), vscode.TextEditorRevealType.AtTop);
  await delay(1500);
  await step('plain');

  editor = await open(ORDER);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  editor.selection = new vscode.Selection(6, 14, 6, 14);
  await delay(400);
  await vscode.commands.executeCommand('editor.action.showHover');
  await step('hover');

  // Правка и коммит, как у разработчика: хук pre-commit обновит граф, post-commit напишет описание.
  const pricing = await open(PRICING);
  const text = pricing.document.getText();
  const from = 'return max(total - found.amount, 0)';
  const at = text.indexOf(from);
  await pricing.edit((b) =>
    b.replace(
      new vscode.Range(
        pricing.document.positionAt(at),
        pricing.document.positionAt(at + from.length),
      ),
      'return max(total - found.amount, 1)',
    ),
  );
  await pricing.document.save();
  await step('edited');
  execFileSync('git', ['commit', '-qam', 'Promo codes never make an order free'], {
    cwd: ws,
    stdio: 'pipe',
  });
  await api.panel.show('impact');
  editor = await open(ORDER);
  editor.selection = new vscode.Selection(6, 14, 6, 14);
  await delay(1500);
  await step('committed');

  // Описание новой версии apply_promo приходит из фона через несколько секунд.
  const end = Date.now() + 60_000;
  for (;;) {
    const n = api.ws.storeOfId(promo)?.index.get(promo);
    if ((n?.summary && n.summary.forBodyHash === n.bodyHash) || Date.now() > end) break;
    await delay(500);
  }
  editor = await open(ORDER);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  editor.selection = new vscode.Selection(6, 14, 6, 14);
  await delay(800);
  await vscode.commands.executeCommand('editor.action.showHover');
  await step('summary');
}

async function demo(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'clewmap-vscode')!;
  api = (await ext.activate()) as ClewmapApi;
  await api.ready;
  const ORDER = 'src/bot/handlers/order.py';
  const create = `${ORDER}#create_order`;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, ORDER)));

  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('clewmap.openOnGraph', create);
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
  editor.selection = new vscode.Selection(6, 14, 6, 14);
  editor.revealRange(new vscode.Range(0, 0, 20, 0), vscode.TextEditorRevealType.AtTop);
  await delay(1500);
  await vscode.commands.executeCommand('clewmap.openOnGraph', create);
  await vscode.window.showTextDocument(doc, { preserveFocus: false });
  await delay(500);
  await vscode.commands.executeCommand('editor.action.showHover');
  await step('neighbors + hover on apply_promo');

  await api.panel.show('impact');
  await step('impact');

  editor.selection = new vscode.Selection(5, 4, 5, 4);
  await vscode.commands.executeCommand('clewmap.showFlow', create);
  await step('flow');

  await api.panel.show('search', 'промокод');
  await step('search');

  await api.panel.runExplain(create);
  await step('explain');

  const catalog = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(ws, 'src/bot/handlers/catalog.py')),
  );
  await vscode.window.showTextDocument(catalog);
  await api.panel.show('neighbors');
  await step('catalog');
}
