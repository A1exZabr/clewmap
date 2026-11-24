// Тесты внутри настоящего VS Code (Extension Development Host). Запуск: pnpm --filter clewmap-vscode test:vscode
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ClewmapApi } from '../extension.js';

const ws = process.env.CLEWMAP_TEST_WORKSPACE!;
const uri = (file: string) => vscode.Uri.file(path.join(ws, file));
const ORDER = 'src/bot/handlers/order.py';
const CATALOG = 'src/bot/handlers/catalog.py';
const PRICING = 'src/services/pricing.py';

async function until<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  ms = 8000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function hoverText(hovers: vscode.Hover[]): string {
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
    .join('\n---\n');
}

const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({
      name,
      ok: false,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      ms: Date.now() - t0,
    });
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'clewmap-vscode');
  assert.ok(ext, 'extension is loaded');
  const api = (await ext.activate()) as ClewmapApi;
  await api.ready;

  await test('finds the graph and the last commit', async () => {
    assert.equal(api.ws.stores.length, 1);
    const store = api.ws.stores[0]!;
    assert.equal(store.index.symbols.size, 24);
    assert.equal(store.lastCommit?.subject, 'promo never goes to zero');
    assert.deepEqual([...store.lastCommit!.changed], [[`${PRICING}#apply_promo`, 'body']]);
    await until(() => store.freshnessChecked, 'freshness check');
    assert.equal(store.outdated.size, 0);
  });

  const order = await vscode.workspace.openTextDocument(uri(ORDER));
  const editor = await vscode.window.showTextDocument(order);

  await test('CodeLens above create_order: summary, callers, what it reaches', async () => {
    const lenses = await until(async () => {
      const l =
        (await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          order.uri,
        )) ?? [];
      return l.length ? l : null;
    }, 'code lenses');
    const atCreate = lenses
      .filter((l) => l.range.start.line === 4)
      .map((l) => l.command?.title ?? '');
    assert.ok(atCreate[0]!.startsWith('create_order: test summary'), atCreate[0] ?? '');
    assert.ok(atCreate[0]!.length <= 90);
    assert.ok(atCreate.includes('callers: 1'), atCreate.join(' | '));
    // подписи слоёв — из clewmap.config.json, init пишет их по-русски
    assert.ok(atCreate.includes('reaches: Сервис, Данные, Внешний API'), atCreate.join(' | '));
    // строка с def, а не с декоратором над ней
    const atClick = lenses
      .filter((l) => l.range.start.line === 16)
      .map((l) => l.command?.title ?? '');
    assert.ok(atClick.includes('← button catalog.py:8 · callback:checkout'), atClick.join(' | '));
  });

  await test('hover on a call: summary, layer, callers, last commit — fast and without a model', async () => {
    const pos = new vscode.Position(6, 14); // apply_promo(…)
    const first = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      order.uri,
      pos,
    );
    const text = hoverText(first);
    assert.match(text, /`apply_promo\(total, promo\)`/);
    assert.match(text, /background-color:#F2A65A/);
    assert.match(text, /pricing\.py:16/);
    assert.match(text, /\*\*Calls:\*\* \[`promo_repo\.get`\]/);
    assert.match(text, /Changed in the last commit [0-9a-f]{7}: promo never goes to zero/);
    const t0 = performance.now();
    await vscode.commands.executeCommand('vscode.executeHoverProvider', order.uri, pos);
    const ms = performance.now() - t0;
    const own = api.hover.lastMs;
    console.log(
      `  hover: ${own.toFixed(2)} ms inside Clewmap, ${ms.toFixed(1)} ms round trip through VS Code`,
    );
    assert.ok(own < 20, `hover took ${own} ms inside Clewmap`);
    assert.ok(ms < 150, `hover round trip took ${ms} ms`);
  });

  await test('hover on a line inside a block shows the step', async () => {
    const text = hoverText(
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        order.uri,
        new vscode.Position(10, 4),
      ),
    );
    assert.match(text, /\*\*③ tells the user\*\*/);
  });

  await test('stripes, Δ and blocks are painted', async () => {
    const snap = await until(() => api.painter.snapshots.get(order.uri.toString()), 'paint');
    assert.deepEqual(snap.stripes.service, [5, 6]);
    assert.deepEqual(snap.stripes.data, [7, 24]);
    assert.deepEqual(snap.stripes.external, [8, 25]);
    assert.deepEqual(snap.changed, [6]);
    assert.deepEqual(
      snap.blocks.map((b) => b.label),
      ['totals the cart', 'saves and pays', 'tells the user'],
    );
  });

  await test('F12 on callback_data="checkout" opens the handler; Shift+F12 lists the button', async () => {
    const catalog = await vscode.workspace.openTextDocument(uri(CATALOG));
    const line = catalog.lineAt(7).text;
    const col = line.indexOf('"checkout"') + 3;
    assert.ok(col > 3, `no checkout in: ${line}`);
    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      catalog.uri,
      new vscode.Position(7, col),
    );
    const loc = defs.find((d) => ('uri' in d ? d.uri : d.targetUri).fsPath.endsWith('order.py'));
    assert.ok(loc, JSON.stringify(defs));
    const range = 'range' in loc ? loc.range : loc.targetRange;
    assert.equal(range.start.line, 16);

    const refs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      order.uri,
      new vscode.Position(16, 12),
    );
    assert.ok(
      refs.some((r) => r.uri.fsPath.endsWith('catalog.py') && r.range.start.line === 7),
      JSON.stringify(refs),
    );
  });

  await test('the chain goes from the bot button down to the payment API; Alt+] walks it', async () => {
    editor.selection = new vscode.Selection(5, 4, 5, 4);
    await vscode.commands.executeCommand('clewmap.showFlow');
    const flow = api.flow();
    assert.ok(flow);
    const names = flow.steps.map((s) => s.id.split('#')[1]);
    assert.deepEqual(names.slice(0, flow.current + 1), [
      'checkout_keyboard',
      'on_checkout_click',
      'create_order',
    ]);
    assert.ok(names.includes('create_link'));
    await vscode.commands.executeCommand('clewmap.flowForward');
    assert.ok(vscode.window.activeTextEditor!.document.uri.fsPath.endsWith('pricing.py'));
    await vscode.commands.executeCommand('clewmap.flowBack');
    await vscode.commands.executeCommand('clewmap.flowBack');
    assert.equal(vscode.window.activeTextEditor!.selection.active.line, 16);
  });

  await test('panel: neighbors of create_order and the impact of the last commit', async () => {
    await vscode.commands.executeCommand('clewmap.openOnGraph', `${ORDER}#create_order`);
    const state = api.panel.state();
    assert.equal(state.neighbors.center, `${ORDER}#create_order`);
    const cols = Object.fromEntries(state.neighbors.nodes.map((n) => [n.label, n.col]));
    assert.equal(cols.on_checkout_click, -1);
    assert.equal(cols['pricing.apply_promo'], 1);
    assert.ok(state.neighbors.nodes.find((n) => n.label === 'pricing.apply_promo')!.changed);
    assert.deepEqual(
      state.impact.changed.map((c) => c.label),
      ['pricing.apply_promo'],
    );
    assert.deepEqual(
      state.impact.affected
        .filter((a) => a.depth === 1)
        .map((a) => a.label)
        .sort(),
      ['api_checkout', 'create_order', 'preview_cart'],
    );
    assert.ok(state.status.fresh);
    assert.equal(state.legend.length, 4);
  });

  await test('edits move the lenses with the code and mark an edited function', async () => {
    const doc = await vscode.workspace.openTextDocument(uri(ORDER));
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), '# one\n# two\n'));
    const lenses = await until(async () => {
      const l =
        (await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          doc.uri,
        )) ?? [];
      return l.some((x) => x.range.start.line === 6) ? l : null;
    }, 'shifted lenses');
    assert.ok(
      lenses.filter((l) => l.range.start.line === 6)[0]!.command!.title.startsWith('create_order:'),
    );
    const hover = hoverText(
      await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        doc.uri,
        new vscode.Position(8, 14),
      ),
    );
    assert.match(hover, /apply_promo/);

    await ed.edit((b) => b.insert(new vscode.Position(7, 0), '    cart = cart\n'));
    const edited = await until(async () => {
      const l =
        (await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          doc.uri,
        )) ?? [];
      const title = l.find((x) => x.range.start.line === 6)?.command?.title ?? '';
      return title.includes('graph is behind this file') ? title : null;
    }, 'edited marker');
    assert.ok(edited);
    const snap = await until(() => {
      const s = api.painter.snapshots.get(doc.uri.toString());
      return s && s.blocks.length === 0 ? s : null;
    }, 'blocks hidden for the edited function');
    assert.equal(snap.stripes.service, undefined);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await test('explanations come from the cache while the code is the same', async () => {
    const id = `${PRICING}#apply_promo`;
    const store = api.ws.storeOfId(id)!;
    const { explanationPath } = await import('../explainer.js');
    const { writeAtomic } = await import('@clewmap/core');
    await writeAtomic(
      explanationPath(store.root, id),
      JSON.stringify({
        id,
        forBodyHash: store.index.get(id)!.bodyHash,
        language: 'ru',
        text: 'cached text',
        model: 'test',
        createdAt: 'x',
      }),
    );
    const hit = await api.explainer.cached(id);
    assert.equal(hit?.text, 'cached text');
    await api.panel.runExplain(id);
    const state = api.panel.state();
    assert.equal(state.explain?.status, 'done');
    assert.equal(state.explain?.cached, true);
    const queue = JSON.parse(
      await readFile(path.join(store.root, '.clewmap/.queue.json'), 'utf8').catch(
        () => '{"items":[]}',
      ),
    );
    assert.ok(Array.isArray(queue.items));
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results)
    console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${r.ms} ms)${r.error ? `\n${r.error}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) throw new Error(`${failed.length} test(s) failed`);
}
