import type { ExplainContext } from './explain.js';
import type { Entry, SymbolKind } from '@clewmap/core';

/** Вызываемый символ в контексте запроса: имя и уже готовое описание (1 шаг по графу). */
export interface CalleeContext {
  target: string;
  name: string;
  summary: string | null;
  via?: string;
}

/** Оператор тела функции для смысловых блоков. Номера и границы — от tree-sitter. */
export interface StatementContext {
  index: number;
  line: number;
  text: string;
}

export interface SummaryRequest {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  language: string;
  layer: string | null;
  signature: string;
  entry?: Entry;
  /** Код символа целиком. */
  code: string;
  bodyHash: string;
  callees: CalleeContext[];
  /** Операторы тела, если функция длиннее summaries.blocksMinLines; иначе блоки не нужны. */
  statements: StatementContext[] | null;
}

export interface SummaryBlockResult {
  from: number;
  to: number;
  label: string;
  text: string | null;
}

export interface SummaryResult {
  id: string;
  summary: string;
  blocks?: SummaryBlockResult[] | null;
}

export interface TokenUsage {
  /** Все входные токены, включая кэш. */
  input: number;
  output: number;
}

export interface SummarizeCallOptions {
  /** Отмена вызова: лимит времени в pre-commit. */
  signal?: AbortSignal;
}

export interface SummaryProvider {
  readonly name: string;
  /** Модель, которая пишется в summary.model. */
  readonly model: string;
  /** Сколько токенов провайдер потратил с момента создания, если он это знает. */
  readonly usage?: TokenUsage;
  summarize(
    batch: readonly SummaryRequest[],
    opts?: SummarizeCallOptions,
  ): Promise<SummaryResult[]>;
  /** «Объяснить подробнее»: развёрнутый текст в Markdown по узкому контексту. */
  explain?(ctx: ExplainContext, opts?: SummarizeCallOptions): Promise<string>;
}

/** Вызов отменён по лимиту времени: задачи остаются в очереди без штрафа. */
export class SummarizeAbortedError extends Error {
  constructor(message = 'summarize was cancelled') {
    super(message);
    this.name = 'SummarizeAbortedError';
  }
}

/** Ошибка, после которой повторять бессмысленно (нет claude в PATH, нет ключа). */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
