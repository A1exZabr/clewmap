import { EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt, type ExplainContext } from '../explain.js';
import { SYSTEM_PROMPT, buildPrompt, parseResponse } from '../prompt.js';
import type {
  SummarizeCallOptions,
  SummaryProvider,
  SummaryRequest,
  SummaryResult,
  TokenUsage,
} from '../types.js';

/** Общая часть провайдеров: промпт → текст ответа → разбор JSON. */
export abstract class TextProvider implements SummaryProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  readonly usage: TokenUsage = { input: 0, output: 0 };

  constructor(protected readonly language: string) {}

  /** Один запрос к модели. system — системный промпт (описания или «объяснить подробнее»). */
  protected abstract complete(
    prompt: string,
    signal?: AbortSignal,
    system?: string,
  ): Promise<string>;

  protected addUsage(input: number | undefined, output: number | undefined): void {
    this.usage.input += input ?? 0;
    this.usage.output += output ?? 0;
  }

  async summarize(
    batch: readonly SummaryRequest[],
    opts: SummarizeCallOptions = {},
  ): Promise<SummaryResult[]> {
    if (!batch.length) return [];
    return parseResponse(
      await this.complete(buildPrompt(batch, this.language), opts.signal, SYSTEM_PROMPT),
      batch,
    );
  }

  async explain(ctx: ExplainContext, opts: SummarizeCallOptions = {}): Promise<string> {
    const text = await this.complete(
      buildExplainPrompt(ctx, this.language),
      opts.signal,
      EXPLAIN_SYSTEM_PROMPT,
    );
    return text.trim();
  }
}
