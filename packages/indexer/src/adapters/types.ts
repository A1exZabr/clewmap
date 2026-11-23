import type { Entry, Language, Range, SymbolKind } from '@clewmap/core';
import type { Tree } from 'web-tree-sitter';
import type { SupportedLanguage } from '../parser.js';

/** Связь вызова с маршрутом или событием, найденная по тексту кода (до сопоставления). */
export type RawLink =
  { kind: 'http'; method: string; path: string } | { kind: 'event'; key: string };

/** Вызов внутри символа, как он написан в коде. Разрешается в id позже (resolve.ts). */
export interface RawCall {
  /** Цепочка имён вызываемого: ["orders_repo", "save"], ["self", "m"], ["fetch"]. Пусто — сложное выражение. */
  callee: string[];
  /** 0-based строка вызова. */
  line: number;
  /** Найденная связь http/event, если вызов — запрос к API или кнопка бота. */
  link?: RawLink;
}

export interface RawSymbol {
  /** Имя для id: "apply_promo", "Cart.total". */
  qualified: string;
  name: string;
  kind: SymbolKind;
  range: Range;
  signature: string;
  /** Текст определения целиком — для bodyHash. */
  body: string;
  /** Имя класса для методов: нужно, чтобы разрешать self.x() / this.x(). */
  parentClass?: string;
  /** Для переменной вида `cart = Cart()` / `new Cart()` — цепочка имён конструктора. */
  instanceOf?: string[];
  /** Точка входа, найденная по декоратору или пути файла. */
  entry?: Entry;
  calls: RawCall[];
}

/** Регистрация обработчика вызовом: app.post('/x', handler), CallbackQueryHandler(handler, pattern=...). */
export interface RawRegistration {
  handler: string;
  entry: Entry;
}

export interface RawImport {
  /** Имя в этом файле. */
  local: string;
  /** Модуль как записан: "services.pricing", "@/api/client", "react". */
  module: string;
  /** Импортированное имя; null — импорт модуля целиком (import x, from a import module, import * as ns). */
  imported: string | null;
  /** Python: число точек относительного импорта. */
  level?: number;
}

/** Всё, что адаптер достал из одного файла. Дерево после этого освобождается. */
export interface RawModule {
  file: string;
  language: Language;
  grammar: SupportedLanguage;
  fileHash: string;
  symbols: RawSymbol[];
  imports: RawImport[];
  /** Экспортируемое имя → локальное имя символа ("default" → "CheckoutButton"). */
  exports: Map<string, string>;
  /** `export * from './x'`: модули, чьи экспорты видны через этот файл. */
  starExports: string[];
  registrations: RawRegistration[];
}

export interface AdapterContext {
  file: string;
  /** Имена объектов-обёрток над HTTP-клиентом из конфига (links.httpClients). */
  httpClients: readonly string[];
}

export interface LanguageAdapter {
  language: Language;
  extensions: readonly string[];
  extract(
    tree: Tree,
    source: string,
    ctx: AdapterContext,
  ): Omit<RawModule, 'file' | 'language' | 'grammar' | 'fileHash'>;
}
