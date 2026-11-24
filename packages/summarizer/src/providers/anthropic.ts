import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../prompt.js';
import { ProviderUnavailableError, SummarizeAbortedError } from '../types.js';
import { TextProvider } from './text.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export interface AnthropicApiOptions {
  language: string;
  model?: string | null;
  /** Только для тестов; в работе ключ берётся из окружения. */
  client?: Anthropic;
}

/**
 * Anthropic API через официальный SDK. Ключ только из окружения (ANTHROPIC_API_KEY или профиль `ant auth login`).
 * Описания — простая задача, поэтому effort low; при отказе модели API сам повторит запрос на запасной.
 */
export class AnthropicApiProvider extends TextProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicApiOptions) {
    super(opts.language);
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    if (!opts.client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new ProviderUnavailableError(
        'ANTHROPIC_API_KEY is not set. Export it in your shell (clewmap never stores keys) ' +
          'or switch summaries.provider to "claude-cli".',
      );
    }
    this.client = opts.client ?? new Anthropic();
  }

  protected async complete(
    prompt: string,
    signal?: AbortSignal,
    system: string = SYSTEM_PROMPT,
  ): Promise<string> {
    try {
      const response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal },
      );
      const u = response.usage;
      this.addUsage(
        u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        u.output_tokens,
      );
      if (response.stop_reason === 'refusal')
        throw new Error('the model declined to describe this code');
      return response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError || signal?.aborted)
        throw new SummarizeAbortedError();
      if (e instanceof Anthropic.AuthenticationError)
        throw new ProviderUnavailableError(`Anthropic API rejected the key: ${e.message}`);
      throw e;
    }
  }
}
