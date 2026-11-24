import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, type Tree } from 'web-tree-sitter';

export type SupportedLanguage = 'python' | 'typescript' | 'tsx' | 'javascript';

// Готовые .wasm из официальных пакетов грамматик (собраны под актуальный web-tree-sitter).
// Нативная часть этих пакетов не нужна и не собирается (pnpm.neverBuiltDependencies).
const GRAMMAR_WASM: Record<SupportedLanguage, string> = {
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
};

let initPromise: Promise<void> | null = null;
/** Папка с .wasm, если они лежат не в node_modules (собранное расширение VS Code). */
let wasmDir: string | null = null;

/**
 * Брать web-tree-sitter.wasm и грамматики из одной папки, а не из node_modules.
 * Нужно бандлам (расширение VS Code), где пакетов грамматик нет. Вызывать до первого разбора.
 */
export function setWasmDir(dir: string): void {
  wasmDir = dir;
}
const languages = new Map<SupportedLanguage, Promise<Language>>();
const parsers = new Map<SupportedLanguage, Parser>();

/** Ленивая инициализация WASM-рантайма tree-sitter (один раз на процесс). */
export function initParser(): Promise<void> {
  initPromise ??= wasmDir
    ? Parser.init({ locateFile: (name: string) => path.join(wasmDir!, name) })
    : Parser.init();
  return initPromise;
}

function grammarPath(language: SupportedLanguage): string {
  if (wasmDir) return path.join(wasmDir, path.basename(GRAMMAR_WASM[language]));
  // createRequire лениво: в CJS-бандле import.meta.url пуст, а туда мы приходим только с wasmDir.
  return createRequire(import.meta.url).resolve(GRAMMAR_WASM[language]);
}

/** Имена .wasm, которые нужно положить в папку для setWasmDir. */
export const WASM_FILES = ['web-tree-sitter.wasm', ...Object.values(GRAMMAR_WASM)];

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
