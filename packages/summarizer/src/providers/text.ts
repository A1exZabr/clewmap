import { buildPrompt, parseResponse } from '../prompt.js';
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

  protected abstract complete(prompt: string, signal?: AbortSignal): Promise<string>;

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
      await this.complete(buildPrompt(batch, this.language), opts.signal),
      batch,
    );
  }
}
