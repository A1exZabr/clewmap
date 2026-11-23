import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, init, status } from './index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

describe('clewmap init / build / status on py-bot', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clewmap-cli-'));
    await cp(path.join(FIXTURES, 'py-bot'), root, { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('init writes a config with detected layers and gitignore lines', async () => {
    const r = await init(root);
    expect(r.languages).toEqual(['python']);
    const config = JSON.parse(await readFile(path.join(root, 'clewmap.config.json'), 'utf8'));
    expect(config.include).toEqual(['src/**']);
    expect(config.layers.handler.globs).toEqual(['src/bot/**']);
    expect(config.layers.service.globs).toEqual(['src/services/**']);
    expect(config.layers.data.globs).toEqual(['src/db/**']);
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.clewmap/.queue.json');
    expect((await init(root)).configCreated).toBe(false);
    expect((await readFile(path.join(root, '.gitignore'), 'utf8')).match(/queue/g)).toHaveLength(1);
  });

  it('status reports a stale graph before build and a fresh one after', async () => {
    expect((await status(root)).upToDate).toBe(false);
    const stats = await build(root);
    expect(stats.files).toBe(8);
    expect(stats.linkEdges).toBe(1);
    const s = await status(root);
    expect(s.upToDate).toBe(true);
    expect(s.withoutSummary).toBe(s.symbols);
  });
});
