#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { build, init, status } from './commands.js';

const program = new Command()
  .name('clewmap')
  .description(
    'A living map of your codebase: symbols, calls and plain-language summaries in .clewmap/',
  )
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'run as if started in <dir>', process.cwd());

const log = (line: string) => console.log(line);
const root = () => program.opts<{ cwd: string }>().cwd;

program
  .command('init')
  .description('create clewmap.config.json and .clewmap/ in this repository')
  .option('--force', 'regenerate the config even if it exists')
  .action(async (opts: { force?: boolean }) => {
    await init(root(), { force: opts.force, log });
  });

program
  .command('build')
  .description('index the whole repository (tree-sitter, no LLM)')
  .option('--no-summaries', 'skip summaries (the only mode until summaries land)')
  .action(async () => {
    await build(root(), { log });
  });

program
  .command('status')
  .description('show whether the graph matches the code and HEAD')
  .action(async () => {
    await status(root(), { log });
  });

program.parseAsync().catch((e: unknown) => {
  console.error(pc.red(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
