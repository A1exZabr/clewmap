import { SYSTEM_PROMPT } from '../prompt.js';
import { ProviderUnavailableError, SummarizeAbortedError } from '../types.js';
import { TextProvider } from './text.js';

export const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b';

export interface OllamaOptions {
  language: string;
  model?: string | null;
  host?: string;
  timeoutMs?: number;
}

/** Локальная модель через Ollama (http://localhost:11434): ничего не уходит из машины. */
export class OllamaProvider extends TextProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly host: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions) {
    super(opts.language);
    this.model = opts.model ?? DEFAULT_OLLAMA_MODEL;
    this.host = (opts.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(
      /\/$/,
      '',
    );
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  protected async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, system: SYSTEM_PROMPT, prompt, stream: false }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (signal?.aborted) throw new SummarizeAbortedError();
      throw new ProviderUnavailableError(
        `Ollama is not reachable at ${this.host} (${e instanceof Error ? e.message : String(e)}). Start it with \`ollama serve\`.`,
      );
    }
    if (res.status === 404)
      throw new ProviderUnavailableError(
        `Ollama has no model "${this.model}". Run \`ollama pull ${this.model}\`.`,
      );
    if (!res.ok)
      throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    this.addUsage(data.prompt_eval_count, data.eval_count);
    return data.response ?? '';
  }
}
