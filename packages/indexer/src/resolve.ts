import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { RawImport, RawModule, RawSymbol } from './adapters/types.js';

/**
 * Разрешение вызовов в id символов. Только по таблице импортов и локальным определениям —
 * никакого вывода типов, кроме одного случая: переменная `cart = new Cart()` знает свой класс.
 *
 * Что не попадает в граф совсем: встроенные функции (len, print, console.log, JSON.parse)
 * и вызовы методов у локальных переменных и параметров (message.answer, res.json) —
 * их нельзя честно разрешить без типов, а как «внешние» они только шумят.
 */

export interface ResolvedTarget {
  target: string;
  resolved: boolean;
}

type Binding =
  | { kind: 'project'; file: string; symbol: string | null }
  | { kind: 'external'; module: string; symbol: string | null };

const PY_BUILTINS = new Set(
  (
    'print len sum round max min range enumerate zip map filter sorted reversed list dict set tuple str int float bool ' +
    'bytes bytearray isinstance issubclass getattr setattr hasattr delattr super type open iter next abs any all repr ' +
    'hash id vars dir format callable object staticmethod classmethod property divmod pow chr ord hex bin oct input ' +
    'exec eval compile globals locals frozenset slice memoryview complex aiter anext breakpoint'
  ).split(' '),
);

const JS_GLOBALS = new Set(
  (
    'console JSON Math Object Array Promise Number String Boolean Symbol Date RegExp Error TypeError RangeError Map Set ' +
    'WeakMap WeakSet Reflect Proxy Intl BigInt parseInt parseFloat isNaN isFinite setTimeout setInterval clearTimeout ' +
    'clearInterval queueMicrotask structuredClone encodeURIComponent decodeURIComponent encodeURI decodeURI require ' +
    'window document globalThis alert confirm atob btoa super import'
  ).split(' '),
);

/** Глобальные функции, которые считаются внешним API (сеть). */
const JS_EXTERNAL_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

interface TsPaths {
  dir: string;
  baseUrl: string | null;
  paths: [string, string[]][];
}

function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Ищет ближайший tsconfig.json / jsconfig.json вверх от файла и читает baseUrl + paths. */
export class TsConfigResolver {
  private readonly cache = new Map<string, TsPaths | null>();

  constructor(private readonly readFile: (rel: string) => string | null) {}

  static forRoot(root: string): TsConfigResolver {
    return new TsConfigResolver((rel) => {
      try {
        return readFileSync(posix.join(root.replace(/\\/g, '/'), rel), 'utf8');
      } catch {
        return null;
      }
    });
  }

  forFile(file: string): TsPaths | null {
    let dir = posix.dirname(file);
    for (;;) {
      const found = this.load(dir === '.' ? '' : dir);
      if (found) return found;
      if (dir === '.' || dir === '' || dir === '/') return null;
      dir = posix.dirname(dir);
    }
  }

  private load(dir: string): TsPaths | null {
    if (this.cache.has(dir)) return this.cache.get(dir)!;
    let result: TsPaths | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const text = this.readFile(dir ? `${dir}/${name}` : name);
      if (text === null) continue;
      try {
        const json = JSON.parse(stripJsonc(text)) as {
          compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
        };
        const opts = json.compilerOptions ?? {};
        result = {
          dir,
          baseUrl: opts.baseUrl ? posix.normalize(posix.join(dir, opts.baseUrl)) : null,
          paths: Object.entries(opts.paths ?? {}),
        };
      } catch {
        result = { dir, baseUrl: null, paths: [] };
      }
      break;
    }
    this.cache.set(dir, result);
    return result;
  }
}

export class ProjectTable {
  readonly modules = new Map<string, RawModule>();
  /** file → qualified → id (первое определение с таким именем). */
  private readonly ids = new Map<string, Map<string, string>>();
  /** file → массив id параллельно RawModule.symbols. */
  readonly symbolIds = new Map<string, string[]>();
  private readonly bindings = new Map<string, Map<string, Binding>>();

  constructor(
    raws: Iterable<RawModule>,
    private readonly ts: TsConfigResolver | null = null,
  ) {
    for (const m of raws) this.modules.set(m.file, m);
    for (const m of this.modules.values()) {
      const byName = new Map<string, string>();
      const list: string[] = [];
      const used = new Set<string>();
      for (const s of m.symbols) {
        let id = `${m.file}#${s.qualified}`;
        for (let n = 2; used.has(id); n++) id = `${m.file}#${s.qualified}~${n}`;
        used.add(id);
        list.push(id);
        if (!byName.has(s.qualified)) byName.set(s.qualified, id);
      }
      this.ids.set(m.file, byName);
      this.symbolIds.set(m.file, list);
    }
    for (const m of this.modules.values()) {
      const map = new Map<string, Binding>();
      for (const imp of m.imports) map.set(imp.local, this.bindImport(m, imp));
      this.bindings.set(m.file, map);
    }
  }

  idOf(file: string, qualified: string): string | undefined {
    return this.ids.get(file)?.get(qualified);
  }

  symbolOf(file: string, qualified: string): RawSymbol | undefined {
    return this.modules.get(file)?.symbols.find((s) => s.qualified === qualified);
  }

  // ---------- модули ----------

  private pythonModule(dotted: string, fromFile: string, level: number): string | null {
    const rel = dotted ? dotted.split('.').join('/') : '';
    const tryBase = (base: string): string | null => {
      const prefix = base ? `${base}/` : '';
      for (const cand of rel
        ? [`${prefix}${rel}.py`, `${prefix}${rel}/__init__.py`]
        : [`${prefix}__init__.py`]) {
        if (this.modules.has(cand)) return cand;
      }
      return null;
    };
    let dir = posix.dirname(fromFile);
    if (dir === '.') dir = '';
    if (level > 0) {
      for (let i = 1; i < level; i++) dir = dir.includes('/') ? posix.dirname(dir) : '';
      return tryBase(dir);
    }
    // Абсолютный импорт: корень пакетов может быть любой папкой-предком (часто src/).
    for (;;) {
      const found = tryBase(dir);
      if (found) return found;
      if (!dir) return null;
      dir = dir.includes('/') ? posix.dirname(dir) : '';
    }
  }

  private tsFile(base: string): string | null {
    const norm = posix.normalize(base);
    if (this.modules.has(norm)) return norm;
    const noJs = norm.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const ext of TS_EXTENSIONS) if (this.modules.has(noJs + ext)) return noJs + ext;
    for (const ext of TS_EXTENSIONS)
      if (this.modules.has(`${norm}/index${ext}`)) return `${norm}/index${ext}`;
    return null;
  }

  private tsModule(spec: string, fromFile: string): string | null {
    if (spec.startsWith('.')) return this.tsFile(posix.join(posix.dirname(fromFile), spec));
    const cfg = this.ts?.forFile(fromFile);
    if (cfg) {
      const base = cfg.baseUrl ?? cfg.dir;
      for (const [pattern, targets] of cfg.paths) {
        const star = pattern.indexOf('*');
        let rest: string | null = null;
        if (star === -1) rest = pattern === spec ? '' : null;
        else if (
          spec.startsWith(pattern.slice(0, star)) &&
          spec.endsWith(pattern.slice(star + 1))
        ) {
          rest = spec.slice(star, spec.length - (pattern.length - star - 1));
        }
        if (rest === null) continue;
        for (const t of targets) {
          const found = this.tsFile(posix.join(base, t.replace('*', rest)));
          if (found) return found;
        }
      }
      if (cfg.baseUrl) {
        const found = this.tsFile(posix.join(cfg.baseUrl, spec));
        if (found) return found;
      }
    }
    return null;
  }

  private bindImport(m: RawModule, imp: RawImport): Binding {
    if (m.language === 'python') {
      const level = imp.level ?? 0;
      if (imp.imported !== null) {
        // from a import b: b может быть подмодулем
        const sub = this.pythonModule(
          imp.module ? `${imp.module}.${imp.imported}` : imp.imported,
          m.file,
          level,
        );
        if (sub) return { kind: 'project', file: sub, symbol: null };
      }
      const file = this.pythonModule(imp.module, m.file, level);
      if (file) return { kind: 'project', file, symbol: imp.imported };
      return { kind: 'external', module: imp.module, symbol: imp.imported };
    }
    const file = this.tsModule(imp.module, m.file);
    if (file) return { kind: 'project', file, symbol: imp.imported };
    return {
      kind: 'external',
      module: imp.module,
      symbol: imp.imported === 'default' ? null : imp.imported,
    };
  }

  /** Экспортированное имя модуля → (файл, локальное имя символа), с проходом по реэкспортам. */
  lookupExport(
    file: string,
    name: string,
    depth = 0,
  ): { file: string; qualified: string } | Binding | null {
    if (depth > 8) return null;
    const m = this.modules.get(file);
    if (!m) return null;
    const local = m.exports.get(name) ?? (this.ids.get(file)?.has(name) ? name : undefined);
    if (local !== undefined) {
      if (this.ids.get(file)?.has(local)) return { file, qualified: local };
      const b = this.bindings.get(file)?.get(local);
      if (b?.kind === 'project') {
        if (b.symbol === null) return b;
        return this.lookupExport(b.file, b.symbol, depth + 1);
      }
      if (b) return b;
    }
    for (const spec of m.starExports) {
      const target = this.tsModule(spec, file);
      if (!target) continue;
      const found = this.lookupExport(target, name, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /** Символ-класс, к которому относится цепочка (класс напрямую или переменная `x = new Class()`). */
  private classOf(
    file: string,
    qualified: string,
    depth = 0,
  ): { file: string; cls: string } | null {
    if (depth > 4) return null;
    const sym = this.symbolOf(file, qualified);
    if (!sym) return null;
    if (sym.kind === 'class') return { file, cls: sym.qualified };
    if (sym.kind === 'variable' && sym.instanceOf) {
      const t = this.resolvePath(file, null, sym.instanceOf);
      if (t?.resolved) {
        const [tf, tq] = splitId(t.target);
        return this.classOf(tf, tq, depth + 1);
      }
    }
    return null;
  }

  private member(file: string, qualified: string, rest: string[]): ResolvedTarget | null {
    if (rest.length === 0) {
      const id = this.idOf(file, qualified);
      return id ? { target: id, resolved: true } : null;
    }
    const cls = this.classOf(file, qualified);
    if (cls && rest.length === 1) {
      const id = this.idOf(cls.file, `${cls.cls}.${rest[0]}`);
      if (id) return { target: id, resolved: true };
    }
    return null;
  }

  /** Разрешает цепочку имён в контексте файла и (необязательно) символа-владельца. */
  resolvePath(file: string, owner: RawSymbol | null, callee: string[]): ResolvedTarget | null {
    if (!callee.length) return null;
    const m = this.modules.get(file);
    if (!m) return null;
    const isPy = m.language === 'python';
    const [head, ...rest] = callee as [string, ...string[]];

    if (head === 'self' || head === 'this' || head === 'cls') {
      if (owner?.parentClass && rest.length === 1) {
        const id = this.idOf(file, `${owner.parentClass}.${rest[0]}`);
        if (id) return { target: id, resolved: true };
      }
      return null;
    }

    // Локальное определение
    if (this.idOf(file, head)) {
      const r = this.member(file, head, rest);
      if (r) return r;
      return rest.length ? null : { target: `external:${callee.join('.')}`, resolved: false };
    }

    // Импорт
    const b = this.bindings.get(file)?.get(head);
    if (b) return this.resolveViaBinding(b, rest, callee, isPy);

    // Встроенное / глобальное
    if (isPy) {
      if (PY_BUILTINS.has(head) || /(?:Error|Exception|Warning)$/.test(head)) return null;
    } else {
      if (JS_EXTERNAL_GLOBALS.has(head))
        return { target: `external:${callee.join('.')}`, resolved: false };
      if (JS_GLOBALS.has(head)) return null;
    }
    // Локальные переменные, параметры, вложенные функции — не разрешаем и не шумим.
    return null;
  }

  private resolveViaBinding(
    b: Binding,
    rest: string[],
    callee: string[],
    isPy: boolean,
  ): ResolvedTarget | null {
    if (b.kind === 'external') {
      const parts = [b.module, ...(b.symbol ? [b.symbol] : []), ...rest];
      return { target: `external:${parts.join('.')}`, resolved: false };
    }
    let file = b.file;
    let path = rest;
    if (b.symbol === null) {
      // Импорт модуля целиком. Python: съедаем подмодули (import a → a.b.f()).
      if (isPy) {
        while (path.length > 1) {
          const sub = this.pythonSubmodule(file, path[0]!);
          if (!sub) break;
          file = sub;
          path = path.slice(1);
        }
      }
      if (!path.length) return null;
      const target = this.lookupExport(file, path[0]!);
      return this.finish(target, path.slice(1), callee);
    }
    const target = this.lookupExport(file, b.symbol);
    return this.finish(target, path, callee);
  }

  private finish(
    target: ReturnType<ProjectTable['lookupExport']>,
    rest: string[],
    callee: string[],
  ): ResolvedTarget | null {
    if (!target) return { target: `external:${callee.join('.')}`, resolved: false };
    if ('qualified' in target) {
      // texts.PAY.format(): символ проекта найден, дальше — метод значения. Это не вызов символа.
      return this.member(target.file, target.qualified, rest);
    }
    return this.resolveViaBinding(target, rest, callee, false);
  }

  private pythonSubmodule(file: string, name: string): string | null {
    const dir = file.endsWith('/__init__.py') ? posix.dirname(file) : null;
    if (!dir) return null;
    for (const cand of [`${dir}/${name}.py`, `${dir}/${name}/__init__.py`])
      if (this.modules.has(cand)) return cand;
    return null;
  }

  /** Обработчик из регистрации (`app.post('/x', handler)`) → id символа. */
  resolveHandler(file: string, handler: string): string | null {
    const r = this.resolvePath(file, null, handler.split('.'));
    return r?.resolved ? r.target : null;
  }
}

export function splitId(id: string): [string, string] {
  const i = id.indexOf('#');
  return [id.slice(0, i), id.slice(i + 1)];
}
