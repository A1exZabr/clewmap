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

async function step(name: string, keep?: () => Thenable<unknown>): Promise<void> {
  writeFileSync(`${signal}.state`, name);
  writeFileSync(
    `${signal}.${name.split(' ')[0]}.json`,
    JSON.stringify({ type: 'state', state: api.panel.state() }),
  );
  const end = Date.now() + 10 * 60_000;
  let last = 0;
  while (!existsSync(signal) && Date.now() < end) {
    // Подсказка закрывается, когда окно теряет фокус: на кадрах с ней показываем её снова.
    if (keep && Date.now() - last > 2000) {
      last = Date.now();
      await keep();
    }
    await delay(200);
  }
  rmSync(signal, { force: true });
}

export async function run(): Promise<void> {
  try {
    const scene = process.env.CLEWMAP_DEMO_SCENE;
    if (scene === 'gif' || scene === 'shots') {
      const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'clewmap-vscode')!;
      api = (await ext.activate()) as ClewmapApi;
      await api.ready;
      await (scene === 'gif' ? gif() : shots());
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

  const showHoverAt = async () => {
    editor = await open(ORDER);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(6, 14, 6, 14);
    await vscode.commands.executeCommand('editor.action.showHover');
  };
  await showHoverAt();
  await delay(400);
  await step('hover', showHoverAt);

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
  await showHoverAt();
  await delay(800);
  await step('summary', showHoverAt);
}

/** Кадры для README и Marketplace: обзор, подсказка, «Влияние», цепочка, поиск, объяснение. */
async function shots(): Promise<void> {
  const ORDER = 'src/bot/handlers/order.py';
  const create = `${ORDER}#create_order`;
  const open = async (file: string) =>
    vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, file))),
      { preserveFocus: false },
    );
  const focusAt = async (line: number, col: number) => {
    const ed = await open(ORDER);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    ed.selection = new vscode.Selection(line, col, line, col);
    ed.revealRange(new vscode.Range(0, 0, 20, 0), vscode.TextEditorRevealType.AtTop);
    return ed;
  };
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('clewmap.openOnGraph', create);
  await focusAt(3, 0);
  await delay(1500);
  await step('overview');

  await focusAt(6, 14);
  await delay(400);
  await step('hover', async () => {
    await focusAt(6, 14);
    await vscode.commands.executeCommand('editor.action.showHover');
  });

  await api.panel.show('impact');
  await focusAt(3, 0);
  await delay(800);
  await step('impact');

  await focusAt(5, 4);
  await vscode.commands.executeCommand('clewmap.showFlow', create);
  await delay(800);
  await step('flow');

  await api.panel.show('search', 'payment link');
  await delay(800);
  await step('search');

  await api.panel.runExplain(create);
  await delay(500);
  await step('explain');
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
