#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { build, hook, init, status, summarizeCommand, update } from './commands.js';

const program = new Command()
  .name('clewmap')
  .description(
    'A living map of your codebase: symbols, calls and plain-language summaries in .clewmap/',
  )
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'run as if started in <dir>', process.cwd());

const log = (line: string) => console.log(line);
const root = () => program.opts<{ cwd: string }>().cwd;

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

/** Общий таймаут команды: по истечении — предупреждение и выход с кодом 1 (хук не добавит .clewmap/). */
function withTimeout(ms: number | undefined): () => void {
  if (!ms) return () => {};
  const timer = setTimeout(() => {
    console.error(pc.yellow(`clewmap: timed out after ${ms} ms`));
    process.exit(1);
  }, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

program
  .command('init')
  .description('create clewmap.config.json and .clewmap/ in this repository')
  .option('--force', 'regenerate the config even if it exists')
  .option('--hooks', 'also install the git hooks (same as clewmap hook install)')
  .action(async (opts: { force?: boolean; hooks?: boolean }) => {
    await init(root(), { force: opts.force, hooks: opts.hooks, log });
  });

program
  .command('build')
  .description('index the whole repository, then write summaries for symbols that have none')
  .option('--no-summaries', 'only build the graph (tree-sitter, no LLM)')
  .action(async (opts: { summaries: boolean }) => {
    await build(root(), { log, summaries: opts.summaries });
  });

program
  .command('update')
  .description(
    're-index changed files, carry summaries over and queue the rest (never calls an LLM)',
  )
  .option('--staged', 'index what is staged for commit (used by the pre-commit hook)')
  .option('--since <ref>', 'take renames from git diff <ref>')
  .option('--files <files...>', 'files that changed (others are re-checked by hash anyway)')
  .option('-q, --quiet', 'print only what changed')
  .option('--timeout <ms>', 'give up after <ms> milliseconds', positiveInt)
  .option(
    '--hook <name>',
    'called from a git hook: with "pre-commit", then write summaries if hooks.summarize is "pre-commit" (outside --timeout)',
  )
  .action(
    async (opts: {
      hook?: string;
      staged?: boolean;
      since?: string;
      files?: string[];
      quiet?: boolean;
      timeout?: number;
    }) => {
      const cancel = withTimeout(opts.timeout);
      const mode = opts.staged
        ? ({ kind: 'staged' } as const)
        : opts.since
          ? ({ kind: 'since', ref: opts.since } as const)
          : opts.files
            ? ({ kind: 'files', files: opts.files } as const)
            : ({ kind: 'worktree' } as const);
      await update(root(), { mode, quiet: opts.quiet, log });
      cancel();
      // Описания в том же процессе: в режиме post-commit это ничего не стоит, лишний запуск node не нужен.
      if (opts.hook === 'pre-commit') await summarizeCommand(root(), { hook: 'pre-commit' });
    },
  );

program
  .command('summarize')
  .description('write summaries for the queued symbols')
  .option('--all', 'every symbol without an up-to-date summary')
  .option('--stale', 'only summaries marked stale')
  .option('--limit <n>', 'describe at most <n> symbols', positiveInt)
  .option('--background', 'run in a detached process, log to .clewmap/.cache/summarize.log')
  .option('-q, --quiet', 'no output')
  .option('--provider <name>', 'claude-cli, anthropic or ollama (overrides clewmap.config.json)')
  .option('--model <model>', 'model id (overrides clewmap.config.json)')
  .action(
    async (opts: {
      provider?: string;
      model?: string;
      all?: boolean;
      stale?: boolean;
      limit?: number;
      background?: boolean;
      quiet?: boolean;
    }) => {
      await summarizeCommand(root(), {
        mode: opts.all ? 'all' : opts.stale ? 'stale' : 'queue',
        limit: opts.limit,
        background: opts.background,
        quiet: opts.quiet,
        log: opts.quiet ? () => {} : log,
        providerName: opts.provider,
        model: opts.model,
      });
    },
  );

program
  .command('hook')
  .description('install or remove the git hooks (pre-commit: update, post-commit: summarize)')
  .argument('<action>', 'install | uninstall')
  .action(async (action: string) => {
    if (action !== 'install' && action !== 'uninstall')
      throw new InvalidArgumentError('expected install or uninstall');
    await hook(root(), action, { log });
  });

program
  .command('mcp')
  .description('run the MCP server over stdio (for Claude Code and other agents)')
  .action(async () => {
    // Без явного --cwd корень берём из CLAUDE_PROJECT_DIR (его задаёт Claude Code) или текущей папки.
    const explicit = program.getOptionValueSource('cwd') === 'cli';
    const { runStdioServer } = await import('@clewmap/mcp');
    await runStdioServer(explicit ? root() : undefined);
  });

program
  .command('status')
  .description('show whether the graph matches the code and how many summaries are pending')
  .action(async () => {
    await status(root(), { log });
  });

program.parseAsync().catch((e: unknown) => {
  console.error(pc.red(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
