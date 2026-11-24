import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGraph, writeModule } from '@clewmap/core';
import { buildGraph } from '@clewmap/indexer';
import { GraphHolder, createClewmapServer, findRoot, parseUnifiedDiff } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures');
const BIN = path.resolve(HERE, '../../cli/dist/bin.js');
const PRICING = 'src/services/pricing.py';

let root: string;
let client: Client;
let holder: GraphHolder;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(r.content[0]!.text), isError: Boolean(r.isError) };
}

function git(...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-mcp-'));
  await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
  git('init', '-q');
  await buildGraph(root);
  const { modules } = await readGraph(root);
  for (const m of modules) {
    for (const s of m.symbols)
      if (s.kind !== 'variable')
        s.summary = {
          text: `${s.name} summary${s.name === 'apply_promo' ? ': applies the promo code to the total' : ''}`,
          forBodyHash: s.bodyHash,
          stale: false,
          model: 'test',
          createdAt: 'x',
        };
    await writeModule(root, m);
  }
  git('add', '-A');
  git('commit', '-qm', 'init', '--no-verify');
  holder = new GraphHolder(root);
  holder.watch();
  const server = createClewmapServer(holder);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  holder.close();
  await rm(root, { recursive: true, force: true });
});

describe('clewmap MCP server', () => {
  it('lists the eight tools with instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'clewmap_find_callees',
      'clewmap_find_callers',
      'clewmap_get_symbol',
      'clewmap_impact',
      'clewmap_module_summary',
      'clewmap_search',
      'clewmap_status',
      'clewmap_update',
    ]);
    expect(client.getInstructions()).toMatch(/clewmap_impact/);
  });

  it('clewmap_get_symbol: by name, with callers, callees and summary status', async () => {
    const { data } = await call('clewmap_get_symbol', { name: 'apply_promo' });
    expect(data).toMatchObject({
      id: `${PRICING}#apply_promo`,
      kind: 'function',
      signature: 'apply_promo(total, promo)',
      at: `${PRICING}:16`,
      layer: 'service',
      summaryStatus: 'ok',
    });
    expect(data.calls).toEqual(['src/db/promo_repo.py#get', `${PRICING}#is_expired`]);
    expect(data.calledBy.map((c: { id: string }) => c.id.split('#')[1]).sort()).toEqual([
      'api_checkout',
      'create_order',
      'preview_cart',
    ]);
  });

  it('clewmap_get_symbol: ambiguous names and typos get a helpful error', async () => {
    const amb = await call('clewmap_get_symbol', { name: 'get' });
    expect(amb.isError).toBe(true);
    expect(amb.data.matches).toHaveLength(2);
    const typo = await call('clewmap_get_symbol', { name: 'apply_promoo' });
    expect(typo.isError).toBe(true);
    expect(typo.data.didYouMean).toContain(`${PRICING}#apply_promo`);
  });

  it('clewmap_find_callers / callees with depth, links across the boundary and external calls', async () => {
    const up = await call('clewmap_find_callers', { id: 'create_order', depth: 3 });
    const names = up.data.callers.map(
      (c: { id: string; depth: number }) => `${c.id.split('#')[1]}@${c.depth}`,
    );
    // preview_cart рисует ту же кнопку: она в трёх шагах
    expect(names).toEqual(['on_checkout_click@1', 'checkout_keyboard@2', 'preview_cart@3']);
    expect(up.data.callers[1].link).toBe('event callback:checkout');

    const down = await call('clewmap_find_callees', { id: 'src/services/payments.py#create_link' });
    expect(down.data.callees).toEqual([]);
    expect(down.data.external).toEqual(['external:httpx.AsyncClient']);
  });

  it('clewmap_impact: "what breaks if I change apply_promo" names create_order and preview_cart', async () => {
    const { data } = await call('clewmap_impact', { ids: ['apply_promo'] });
    const direct = data.affected
      .filter((a: { depth: number }) => a.depth === 1)
      .map((a: { id: string }) => a.id.split('#')[1]);
    expect(direct.sort()).toEqual(['api_checkout', 'create_order', 'preview_cart']);
    expect(data.files).toContain('src/bot/handlers/catalog.py');
    expect(data.entryPoints).toEqual(
      expect.arrayContaining([
        { id: 'src/api/checkout.py#api_checkout', entry: 'http-route POST /api/checkout' },
        {
          id: 'src/bot/handlers/order.py#on_checkout_click',
          entry: 'bot-callback callback:checkout',
        },
      ]),
    );
  });

  it('clewmap_impact: with no arguments takes the uncommitted changes from git', async () => {
    const src = path.join(root, PRICING);
    const before = await readFile(src, 'utf8');
    await writeFile(
      src,
      before.replace('return max(total - found.amount, 0)', 'return max(total - found.amount, 1)'),
    );
    const { data } = await call('clewmap_impact');
    expect(data.source).toBe('git diff HEAD');
    expect(data.changed.map((c: { id: string }) => c.id)).toEqual([`${PRICING}#apply_promo`]);
    await writeFile(src, before);
  });

  it('parses unified diffs on the old side', () => {
    const r = parseUnifiedDiff(
      [
        '--- a/src/x.py',
        '+++ b/src/x.py',
        '@@ -10,2 +10,3 @@',
        '@@ -30,0 +32,4 @@',
        '--- /dev/null',
        '+++ b/new.py',
        '@@ -0,0 +1,3 @@',
      ].join('\n'),
    );
    expect(r).toEqual([
      { file: 'src/x.py', start: 9, end: 10 },
      { file: 'src/x.py', start: 29, end: 29 },
    ]);
  });

  it('clewmap_search and clewmap_module_summary', async () => {
    const s = await call('clewmap_search', { query: 'promo code' });
    expect(s.data.results[0].id).toBe(`${PRICING}#apply_promo`);
    expect(s.data.results[0].match).toBe('summary');
    const m = await call('clewmap_module_summary', { file: 'pricing.py' });
    expect(m.data.file).toBe(PRICING);
    expect(m.data.symbols.map((x: { name: string }) => x.name)).toEqual([
      'calc_total',
      'is_expired',
      'apply_promo',
    ]);
  });

  it('clewmap_status, then clewmap_update refreshes edges and the index reloads', async () => {
    const st = await call('clewmap_status');
    expect(st.data).toMatchObject({ upToDate: true, symbols: 24, withoutSummary: 0 });

    const src = path.join(root, PRICING);
    await writeFile(
      src,
      (await readFile(src, 'utf8')) +
        '\n\ndef apply_vat(total):\n    return calc_total([]) + total\n',
    );
    expect((await call('clewmap_status')).data.upToDate).toBe(false);
    const up = await call('clewmap_update', { files: [PRICING] });
    expect(up.data.changedSymbols).toContain(`${PRICING}#apply_vat`);
    const vat = await call('clewmap_get_symbol', { name: 'apply_vat' });
    expect(vat.data.calls).toEqual([`${PRICING}#calc_total`]);
    expect(vat.data.summaryStatus).toBe('missing');
  });

  it('picks up changes made to .clewmap/ by someone else (the summarize hook) without a restart', async () => {
    const m = (await readGraph(root)).modules.find((x) => x.file === PRICING)!;
    const calc = m.symbols.find((s) => s.name === 'calc_total')!;
    calc.summary = { ...calc.summary!, text: 'rewritten by the background summarize' };
    await writeModule(root, m);
    await new Promise((r) => setTimeout(r, 700));
    expect((await call('clewmap_get_symbol', { name: 'calc_total' })).data.summary).toBe(
      'rewritten by the background summarize',
    );
  });

  it('finds the root from a nested folder but not above the git root', () => {
    expect(findRoot(path.join(root, 'src/services'))).toBe(root);
    expect(findRoot(os.tmpdir())).toBeNull();
  });

  it('`clewmap mcp` speaks MCP over stdio and finds the project from CLAUDE_PROJECT_DIR', async () => {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      cwd: os.tmpdir(),
      env: { ...process.env, CLAUDE_PROJECT_DIR: path.join(root, 'src') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    const waitFor = async (id: number) => {
      for (let t = 0; t < 100; t++) {
        const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no answer');
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    expect((await waitFor(1)).result.serverInfo.name).toBe('clewmap');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'clewmap_impact', arguments: { ids: ['apply_promo'] } },
    });
    const res = await waitFor(2);
    expect(res.result.content[0].text).toContain('create_order');
    child.kill();
  });
});
