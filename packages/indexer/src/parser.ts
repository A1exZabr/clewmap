import { createRequire } from 'node:module';
import { Language, Parser, type Tree } from 'web-tree-sitter';

export type SupportedLanguage = 'python' | 'typescript' | 'tsx' | 'javascript';

const require = createRequire(import.meta.url);

// Готовые .wasm из официальных пакетов грамматик (собраны под актуальный web-tree-sitter).
// Нативная часть этих пакетов не нужна и не собирается (pnpm.neverBuiltDependencies).
const GRAMMAR_WASM: Record<SupportedLanguage, string> = {
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
};

let initPromise: Promise<void> | null = null;
const languages = new Map<SupportedLanguage, Promise<Language>>();
const parsers = new Map<SupportedLanguage, Parser>();

/** Ленивая инициализация WASM-рантайма tree-sitter (один раз на процесс). */
export function initParser(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

function grammarPath(language: SupportedLanguage): string {
  return require.resolve(GRAMMAR_WASM[language]);
}

async function loadLanguage(language: SupportedLanguage): Promise<Language> {
  await initParser();
  let pending = languages.get(language);
  if (!pending) {
    pending = Language.load(grammarPath(language));
    languages.set(language, pending);
  }
  return pending;
}

/** Разобрать исходник; парсеры кэшируются по языку. */
export async function parse(source: string, language: SupportedLanguage): Promise<Tree> {
  const lang = await loadLanguage(language);
  let parser = parsers.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(language, parser);
  }
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter не смог разобрать файл (${language})`);
  return tree;
}
