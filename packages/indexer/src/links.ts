import type { Entry } from '@clewmap/core';
import type { Node } from 'web-tree-sitter';
import { memberPath, stringValue } from './adapters/common.js';
import type { RawLink, RawRegistration } from './adapters/types.js';

/**
 * Связи между фронтом, бэком и ботом. Всё детерминированно, по совпадению строк в коде:
 * маршрут "POST /api/checkout" у обработчика ↔ fetch('/api/checkout', { method: 'POST' }) на фронте;
 * callback_data="checkout" у кнопки ↔ F.data == "checkout" у обработчика.
 * Ничего не угадываем: нет точного совпадения — связь остаётся неразрешённой.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function args(call: Node): Node[] {
  return call.childForFieldName('arguments')?.namedChildren ?? [];
}

function positional(call: Node): Node[] {
  return args(call).filter((a) => a.type !== 'keyword_argument' && a.type !== 'comment');
}

function keyword(call: Node, name: string): Node | null {
  for (const a of args(call)) {
    if (a.type === 'keyword_argument' && a.childForFieldName('name')?.text === name) {
      return a.childForFieldName('value');
    }
  }
  return null;
}

function firstStringInList(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'list' || node.type === 'tuple' || node.type === 'array') {
    for (const c of node.namedChildren) {
      const v = stringValue(c);
      if (v !== null) return v;
    }
    return null;
  }
  return stringValue(node);
}

/** `F.data == "checkout"` → "checkout". */
function fDataEquals(node: Node | undefined): string | null {
  if (!node || node.type !== 'comparison_operator') return null;
  const [left, right] = node.namedChildren;
  if (!left || !right || !node.text.includes('==')) return null;
  const path = memberPath(left);
  if (path.length !== 2 || path[1] !== 'data') return null;
  return stringValue(right);
}

function commandName(node: Node | undefined): string | null {
  if (!node || node.type !== 'call') return null;
  const fn = memberPath(node.childForFieldName('function'));
  const name = fn[fn.length - 1];
  if (name === 'CommandStart') return 'start';
  if (name !== 'Command') return null;
  const first = positional(node)[0];
  return firstStringInList(first ?? keyword(node, 'commands'));
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  return `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/$/, '') || '/';
}

// ---------- Python ----------

/** Префиксы роутеров в файле: `router = APIRouter(prefix="/api")`, `bp = Blueprint(..., url_prefix="/api")`. */
export function pythonRouterPrefix(call: Node): string | null {
  const fn = memberPath(call.childForFieldName('function'));
  const name = fn[fn.length - 1];
  if (name === 'APIRouter') return stringValue(keyword(call, 'prefix'));
  if (name === 'Blueprint') return stringValue(keyword(call, 'url_prefix'));
  return null;
}

/** Точка входа по декоратору: FastAPI/Flask маршруты, aiogram callback и команды. */
export function pythonDecoratorEntry(
  decorator: Node,
  prefixes: ReadonlyMap<string, string>,
): Entry | null {
  const call = decorator.namedChildren.find((c) => c.type === 'call');
  if (!call) return null;
  const fn = memberPath(call.childForFieldName('function'));
  if (fn.length < 2) return null;
  const method = fn[fn.length - 1]!;
  const owner = fn.slice(0, -1).join('.');
  const prefix = prefixes.get(owner) ?? '';
  const first = positional(call)[0];

  if (HTTP_METHODS.includes(method)) {
    const path = stringValue(first);
    if (path?.startsWith('/'))
      return { kind: 'http-route', key: `${method.toUpperCase()} ${joinPath(prefix, path)}` };
    return null;
  }
  if (method === 'route' || method === 'api_route') {
    const path = stringValue(first);
    if (!path?.startsWith('/')) return null;
    const m = firstStringInList(keyword(call, 'methods')) ?? 'GET';
    return { kind: 'http-route', key: `${m.toUpperCase()} ${joinPath(prefix, path)}` };
  }
  if (method === 'callback_query' || method === 'callback_query_handler') {
    const data = fDataEquals(first) ?? stringValue(keyword(call, 'text'));
    return data !== null ? { kind: 'bot-callback', key: `callback:${data}` } : null;
  }
  if (method === 'message' || method === 'message_handler') {
    const cmd = commandName(first) ?? firstStringInList(keyword(call, 'commands'));
    return cmd !== null ? { kind: 'bot-command', key: `command:/${cmd.replace(/^\//, '')}` } : null;
  }
  return null;
}

/** Ссылка из вызова: кнопка с callback_data. */
export function pythonCallLink(call: Node): RawLink | undefined {
  const data = stringValue(keyword(call, 'callback_data'));
  return data !== null ? { kind: 'event', key: `callback:${data}` } : undefined;
}

/** Регистрация обработчика вызовом: python-telegram-bot и aiogram `.register(...)`. */
export function pythonRegistration(call: Node): RawRegistration | null {
  const fn = memberPath(call.childForFieldName('function'));
  const name = fn[fn.length - 1];
  const pos = positional(call);
  const handlerOf = (n: Node | undefined): string | null => {
    const p = memberPath(n);
    return p.length ? p.join('.') : null;
  };

  if (name === 'CallbackQueryHandler') {
    const handler = handlerOf(pos[0] ?? keyword(call, 'callback') ?? undefined);
    const pattern = stringValue(keyword(call, 'pattern') ?? pos[1]);
    if (handler && pattern !== null)
      return { handler, entry: { kind: 'bot-callback', key: `callback:${pattern}` } };
  }
  if (name === 'CommandHandler') {
    const cmd = firstStringInList(pos[0] ?? keyword(call, 'command'));
    const handler = handlerOf(pos[1] ?? keyword(call, 'callback') ?? undefined);
    if (handler && cmd !== null)
      return { handler, entry: { kind: 'bot-command', key: `command:/${cmd}` } };
  }
  if (name === 'register' && fn.length >= 2) {
    const kind = fn[fn.length - 2];
    const handler = handlerOf(pos[0]);
    if (handler && kind === 'callback_query') {
      const data = fDataEquals(pos[1]);
      if (data !== null)
        return { handler, entry: { kind: 'bot-callback', key: `callback:${data}` } };
    }
    if (handler && kind === 'message') {
      const cmd = commandName(pos[1]);
      if (cmd !== null) return { handler, entry: { kind: 'bot-command', key: `command:/${cmd}` } };
    }
  }
  return null;
}

// ---------- TypeScript / JavaScript ----------

function objectProp(obj: Node | undefined, key: string): Node | null {
  if (!obj || obj.type !== 'object') return null;
  for (const pair of obj.namedChildren) {
    if (pair.type !== 'pair') continue;
    const k = pair.childForFieldName('key');
    if (k && (k.text === key || stringValue(k) === key)) return pair.childForFieldName('value');
  }
  return null;
}

/** Ссылка из вызова: fetch('/api/x', { method }), axios.post('/api/x'), обёртки из links.httpClients. */
export function tsCallLink(call: Node, httpClients: readonly string[]): RawLink | undefined {
  const fn = memberPath(call.childForFieldName('function'));
  const pos = args(call);
  if (fn.length === 1 && fn[0] === 'fetch') {
    const path = stringValue(pos[0]);
    if (!path) return undefined;
    const method = stringValue(objectProp(pos[1], 'method')) ?? 'GET';
    return { kind: 'http', method: method.toUpperCase(), path };
  }
  if (
    fn.length === 2 &&
    (fn[0] === 'axios' || httpClients.includes(fn[0]!)) &&
    HTTP_METHODS.includes(fn[1]!)
  ) {
    const path = stringValue(pos[0]);
    if (!path) return undefined;
    return { kind: 'http', method: fn[1]!.toUpperCase(), path };
  }
  return undefined;
}

const SERVER_OBJECT = /^(app|router|server|routes?|api)$|(App|Router|app|router)$/;

/** Регистрация маршрута Express/Hono: app.post('/api/x', handler). */
export function tsRegistration(call: Node, httpClients: readonly string[]): RawRegistration | null {
  const fn = memberPath(call.childForFieldName('function'));
  if (fn.length !== 2) return null;
  const [obj, method] = fn as [string, string];
  if (obj === 'axios' || httpClients.includes(obj) || !SERVER_OBJECT.test(obj)) return null;
  if (!HTTP_METHODS.includes(method) && method !== 'all') return null;
  const pos = args(call);
  const path = stringValue(pos[0]);
  if (!path?.startsWith('/') || pos.length < 2) return null;
  const handler = memberPath(pos[pos.length - 1]);
  if (!handler.length) return null;
  const m = method === 'all' ? 'ANY' : method.toUpperCase();
  return { handler: handler.join('.'), entry: { kind: 'http-route', key: `${m} ${path}` } };
}

/**
 * Маршруты Next.js по пути файла:
 * pages/api/orders/[id].ts (default export) → "ANY /api/orders/[id]";
 * app/api/checkout/route.ts (export POST) → "POST /api/checkout".
 */
export function nextRouteEntries(file: string, exported: Iterable<string>): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const pages = /(?:^|\/)pages(\/api\/.+?)(?:\/index)?\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (pages) {
    out.set('default', { kind: 'http-route', key: `ANY ${pages[1]}` });
    return out;
  }
  const app = /(?:^|\/)app((?:\/.*)?)\/route\.(?:ts|js|mjs)$/.exec(file);
  if (app) {
    const route = (app[1] ?? '').replace(/\/\([^/]+\)/g, '') || '/';
    for (const name of exported) {
      if (HTTP_METHODS.includes(name.toLowerCase()) && name === name.toUpperCase()) {
        out.set(name, { kind: 'http-route', key: `${name} ${route}` });
      }
    }
  }
  return out;
}

// ---------- Сопоставление ----------

/**
 * Нормализует путь для сравнения: параметры `{id}`, `${id}`, `:id`, `[id]` → `{}`,
 * без query, без завершающего слэша, без ведущей подстановки базового адреса (`${API}/x` → `/x`).
 */
export function normalizeRoutePath(path: string): string {
  let p = path.trim();
  p = p.replace(/^\$\{[^}]*\}(?=\/)/, '');
  p = p.replace(/^https?:\/\/[^/]+/, '');
  p = p.split('?')[0]!.split('#')[0]!;
  p = p
    .split('/')
    .map((seg) =>
      seg.replace(/\$\{[^}]*\}|\{[^}]*\}|^:[A-Za-z_]\w*\??$|^\[\[?\.{0,3}[^\]]*\]\]?$/g, '{}'),
    )
    .join('/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

export function parseRouteKey(key: string): { method: string; path: string } | null {
  const m = /^([A-Z]+) (.+)$/.exec(key);
  return m ? { method: m[1]!, path: normalizeRoutePath(m[2]!) } : null;
}

/** Совпадает ли запрос клиента с маршрутом (с учётом общего префикса API). */
export function httpMatches(
  link: { method: string; path: string },
  routeKey: string,
  apiPrefix: string | null,
): boolean {
  const route = parseRouteKey(routeKey);
  if (!route) return false;
  if (route.method !== 'ANY' && route.method !== link.method.toUpperCase()) return false;
  const client = normalizeRoutePath(link.path);
  if (client === route.path) return true;
  if (apiPrefix) {
    const prefix = normalizeRoutePath(apiPrefix);
    if (normalizeRoutePath(joinPath(prefix, route.path)) === client) return true;
    if (normalizeRoutePath(joinPath(prefix, client)) === route.path) return true;
  }
  return false;
}

/** Совпадает ли callback кнопки с обработчиком. Ключ обработчика может быть регуляркой (pattern="^order_\d+$"). */
export function eventMatches(linkKey: string, entryKey: string): boolean {
  if (linkKey === entryKey) return true;
  const [lk, lv] = splitKey(linkKey);
  const [ek, ev] = splitKey(entryKey);
  if (lk !== ek || lv === null || ev === null) return false;
  const stripped = ev.replace(/^\^/, '').replace(/\$$/, '');
  if (stripped === lv) return true;
  if (!/[\\[\]()*+?.|{}]/.test(stripped)) return false;
  try {
    return new RegExp(ev).test(lv);
  } catch {
    return false;
  }
}

function splitKey(key: string): [string, string | null] {
  const i = key.indexOf(':');
  return i === -1 ? [key, null] : [key.slice(0, i), key.slice(i + 1)];
}

/** Текст `via` для ребра. */
export function linkVia(link: RawLink): string {
  return link.kind === 'http' ? `${link.method} ${link.path}` : link.key;
}
