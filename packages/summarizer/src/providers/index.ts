import type { Config } from '@clewmap/core';
import type { SummaryProvider } from '../types.js';
import { AnthropicApiProvider } from './anthropic.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { OllamaProvider } from './ollama.js';

export { AnthropicApiProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
export { ClaudeCliProvider } from './claude-cli.js';
export { OllamaProvider, DEFAULT_OLLAMA_MODEL } from './ollama.js';
export { TextProvider } from './text.js';

/** Провайдер по summaries.provider из конфига: claude-cli (по умолчанию), anthropic, ollama. */
export function createProvider(config: Config): SummaryProvider {
  const { provider, model, language } = config.summaries;
  switch (provider) {
    case 'claude-cli':
      return new ClaudeCliProvider({ language, model });
    case 'anthropic':
      return new AnthropicApiProvider({ language, model });
    case 'ollama':
      return new OllamaProvider({ language, model });
    default:
      throw new Error(
        `unknown summaries.provider "${provider}" (expected claude-cli, anthropic or ollama)`,
      );
  }
}
