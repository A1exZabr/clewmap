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
  // Уведомление «расширения временно отключены» приходит с задержкой и попадает в кадр.
  await vscode.commands.executeCommand('notifications.clearAll');
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

/**
 * Сцены для GIF в README. Каждый шаг — настоящий кадр VS Code; курсор и клики дорисовываются при сборке GIF
 * (scripts/make-demo-gif.py), поэтому шаги идут ровно в том порядке, в каком по ним «кликает» курсор.
 */
async function gif(): Promise<void> {
  const ORDER = 'src/bot/handlers/order.py';
  const PRICING = 'src/services/pricing.py';
  const create = `${ORDER}#create_order`;
  const promo = `${PRICING}#apply_promo`;
  const open = async (file: string, line: number, col: number) => {
    const ed = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, file))),
      { preserveFocus: false },
    );
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    ed.selection = new vscode.Selection(line, col, line, col);
    ed.revealRange(new vscode.Range(0, 0, 20, 0), vscode.TextEditorRevealType.AtTop);
    return ed;
  };
  const hoverAt = (file: string, line: number, col: number) => async () => {
    await open(file, line, col);
    await vscode.commands.executeCommand('editor.action.showHover');
  };
  const run = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args);

  await run('workbench.action.closeAuxiliaryBar');
  await run('workbench.action.closeSidebar');
  await run('workbench.action.closeAllEditors');
  await run('notifications.clearAll');
  await open(ORDER, 4, 0);
  await delay(1500);
  await step('start');

  // Наведение на вызов apply_promo.
  await hoverAt(ORDER, 6, 14)();
  await delay(400);
  await step('hover', hoverAt(ORDER, 6, 14));
  await run('editor.action.hideHover');
  await open(ORDER, 4, 0);

  // Клик по «вызывают: 2» над create_order — список вызывающих.
  void run('clewmap.showCallers', create);
  await delay(800);
  await step('callers');
  await run('workbench.action.closeQuickOpen');

  // Клик по описанию над create_order — граф соседей в боковой панели.
  await run('clewmap.openOnGraph', create);
  // Боковая панель шире (редактор уже), чтобы граф читался в GIF.
  await open(ORDER, 4, 0);
  for (let i = 0; i < 5; i++) await run('workbench.action.decreaseViewWidth');
  await delay(1500);
  await step('graph');

  // Клик по узлу apply_promo в графе — переход к функции.
  let ed = await open(PRICING, 15, 4);
  await delay(800);
  await step('pricing');

  // Правка: курсор после «0» в последней строке, 0 → 1, сохранение.
  const L = 23;
  const col = ed.document.lineAt(L).text.lastIndexOf('0');
  ed = await open(PRICING, L, col + 1);
  await delay(300);
  await step('caret');
  await ed.edit((b) => b.delete(new vscode.Range(L, col, L, col + 1)));
  ed.selection = new vscode.Selection(L, col, L, col);
  await delay(300);
  await step('typing');
  await ed.edit((b) => b.insert(new vscode.Position(L, col), '1'));
  ed.selection = new vscode.Selection(L, col + 1, L, col + 1);
  await delay(600);
  await step('typed');
  await ed.document.save();
  await delay(800);
  await step('edited');

  // Коммит из панели Source Control: сообщение, кнопка Commit. Хуки срабатывают как у разработчика.
  await run('workbench.view.scm');
  const gitExt = vscode.extensions.getExtension('vscode.git');
  const gitApi = (await gitExt?.activate())?.getAPI(1);
  const repoDeadline = Date.now() + 15_000;
  while (!gitApi?.repositories?.length && Date.now() < repoDeadline) await delay(300);
  const repo = gitApi?.repositories?.[0];
  if (!repo) throw new Error('the git extension did not find the repository');
  await delay(1000);
  await step('scm');
  const message = 'Promo codes never make an order free';
  for (const n of [11, 23, message.length]) {
    repo.inputBox.value = message.slice(0, n);
    await delay(200);
    await step(`msg${n}`);
  }
  execFileSync('git', ['commit', '-qam', message], { cwd: ws, stdio: 'pipe' });
  repo.inputBox.value = '';
  await run('git.refresh');
  await delay(1500);
  await step('committed');

  // Клик по значку Clewmap, затем по вкладке «Влияние».
  await run('workbench.view.extension.clewmap');
  await delay(1000);
  await step('panel');
  await api.panel.show('impact');
  await open(PRICING, L, col + 1);
  await delay(1000);
  await step('impact');

  // Описание новой версии apply_promo приходит из фона через несколько секунд.
  const end = Date.now() + 90_000;
  for (;;) {
    const n = api.ws.storeOfId(promo)?.index.get(promo);
    if ((n?.summary && n.summary.forBodyHash === n.bodyHash) || Date.now() > end) break;
    await delay(500);
  }
  await hoverAt(PRICING, 15, 6)();
  await delay(800);
  await step('summary', hoverAt(PRICING, 15, 6));
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
