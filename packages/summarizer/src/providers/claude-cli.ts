import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_PROMPT } from '../prompt.js';
import { ProviderUnavailableError, SummarizeAbortedError } from '../types.js';
import { TextProvider } from './text.js';

export interface ClaudeCliOptions {
  language: string;
  model?: string | null;
  /** Таймаут одного вызова, мс. */
  timeoutMs?: number;
  /** Имя бинаря, для тестов. */
  command?: string;
}

/** Переменные git из хука (GIT_DIR, GIT_INDEX_FILE…) не должны утекать в дочерний claude. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLEWMAP_SKIP: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

/**
 * `claude -p` из Claude Code: работает по подписке пользователя, без ключа.
 * Запускается в пустой временной папке, без хуков и плагинов (только project-настройки, которых там нет),
 * без MCP, инструментов, слеш-команд и сохранения сессии: ему нужен только текст.
 */
export class ClaudeCliProvider extends TextProvider {
  readonly name = 'claude-cli';
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly requestedModel: string | null;
  private readonly cwd: string;

  constructor(opts: ClaudeCliOptions) {
    super(opts.language);
    this.requestedModel = opts.model ?? null;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.command = opts.command ?? 'claude';
    this.cwd = mkdtempSync(path.join(os.tmpdir(), 'clewmap-claude-'));
  }

  /** Модель, которую claude реально использовал (из ответа), для поля summary.model. */
  private lastModel: string | null = null;

  get model(): string {
    return this.requestedModel ?? this.lastModel ?? 'claude-cli';
  }

  protected complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--tools',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt',
      SYSTEM_PROMPT,
    ];
    if (this.requestedModel) args.push('--model', this.requestedModel);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new SummarizeAbortedError());
      const child = spawn(this.command, args, {
        cwd: this.cwd,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`claude -p timed out after ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new SummarizeAbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (e.code === 'ENOENT') {
          reject(
            new ProviderUnavailableError(
              '`claude` is not in PATH. Install Claude Code (https://claude.com/claude-code) and log in, ' +
                'or set summaries.provider to "anthropic" (ANTHROPIC_API_KEY) or "ollama" in clewmap.config.json.',
            ),
          );
        } else reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return;
        let data: {
          result?: unknown;
          is_error?: boolean;
          modelUsage?: Record<string, unknown>;
          usage?: {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
            output_tokens?: number;
          };
        };
        try {
          data = JSON.parse(stdout) as typeof data;
        } catch {
          return reject(
            new Error(`claude -p exited with ${code}: ${(stderr || stdout).trim().slice(0, 400)}`),
          );
        }
        if (data.is_error || typeof data.result !== 'string') {
          return reject(
            new Error(`claude -p failed: ${String(data.result ?? stderr).slice(0, 400)}`),
          );
        }
        const u = data.usage;
        if (u)
          this.addUsage(
            (u.input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0),
            u.output_tokens,
          );
        const models = Object.keys(data.modelUsage ?? {});
        if (models.length) this.lastModel = models[0]!;
        resolve(data.result);
      });
      child.stdin.end(prompt);
    });
  }
}
