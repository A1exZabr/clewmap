# The `.clewmap/` graph format

Clewmap stores the code map inside your repository, next to the code, in plain JSON. The format is open:
any tool can read it without Clewmap installed. This document is the reference; the zod schema in
`packages/core/src/schema.ts` is the source of truth and validates every file on read.

Format version: **1**.

## Layout

```
clewmap.config.json              # settings: include/exclude, layers, links, summaries, hooks
.clewmap/
├── manifest.json                # format version, languages, commit the graph matches
└── modules/
    └── src/services/pricing.py.json   # one file per source file, same path + ".json"
```

One JSON per source file keeps diffs small and merge conflicts local: changing `pricing.py` touches only
`pricing.py.json`. Service files (`.clewmap/.queue.json`, `.clewmap/.lock`, `.clewmap/.cache/`) are
gitignored by `clewmap init`.

Only **outgoing** edges are stored. "Who calls X" is computed in memory by reversing them
(`GraphIndex.calledBy` in `@clewmap/core`), so a new caller never rewrites the callee's file.

## manifest.json

```json
{
  "formatVersion": 1,
  "generator": "clewmap@0.1.0",
  "languages": ["python", "typescript"],
  "lastCommit": "54e896b5…",
  "updatedAt": "2026-11-22T14:43:58.019Z"
}
```

`lastCommit` is the `HEAD` the graph was built on (`null` outside git). `updatedAt` changes only when
some module file actually changed, so a rebuild of unchanged code leaves every byte in place.

## Module file

```json
{
  "file": "src/bot/handlers/order.py",
  "language": "python",
  "fileHash": "sha256 of the file contents",
  "layer": "handler",
  "summary": null,
  "symbols": [ … ]
}
```

| Field      | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `file`     | path from the repository root, always with `/`                                    |
| `language` | `python`, `typescript` (also `.tsx`) or `javascript` (also `.jsx`)                |
| `fileHash` | sha256 of the source; `clewmap status` compares it with the file on disk          |
| `layer`    | layer of the file from `clewmap.config.json` globs or folder names, or `null`     |
| `summary`  | plain-language description of the module (written later by the summarizer)       |

## Symbol

```json
{
  "id": "src/bot/handlers/order.py#create_order",
  "kind": "function",
  "name": "create_order",
  "range": { "start": [4, 0], "end": [12, 16] },
  "signature": "create_order(message, cart)",
  "signatureHash": "…",
  "bodyHash": "…",
  "layer": "handler",
  "calls": [
    { "target": "src/services/pricing.py#calc_total", "line": 5, "resolved": true, "kind": "call" },
    { "target": "src/services/pricing.py#apply_promo", "line": 6, "resolved": true, "kind": "call" },
    { "target": "src/db/orders_repo.py#save", "line": 7, "resolved": true, "kind": "call" },
    { "target": "src/services/payments.py#create_link", "line": 8, "resolved": true, "kind": "call" }
  ],
  "summary": null,
  "blocks": null
}
```

- **`id`** is `<file>#<name>`; methods are `<file>#<Class>.<method>`. A second definition with the same
  name in one file gets `~2`, `~3`.
- **`kind`**: `function`, `method`, `class` or `variable` (module-level assignments such as
  `router = APIRouter()` or `export const cart = new Cart()`). Functions nested inside other functions
  are not separate symbols: their calls belong to the enclosing one, so a React component owns the calls
  of its inline handlers.
- **`range`**: `[line, column]`, both **0-based**, from the first decorator or `export` keyword to the
  end of the body.
- **`signatureHash`** changes when the signature changes; callers' summaries are then marked `stale`.
- **`bodyHash`** is sha256 of the body with comments removed and whitespace collapsed. Reformatting or
  editing comments does not change it, so the summary is not regenerated.
- **`entry`** (optional): how the outside world reaches this symbol. See [Links](#links).

## Edges

```json
{ "target": "src/db/orders_repo.py#save", "line": 7, "resolved": true, "kind": "call" }
```

| Field      | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `target`   | id of a symbol in the repository, or `external:<name>` for code outside it               |
| `line`     | 0-based line of the call                                                                 |
| `resolved` | `true` when `target` is a symbol of this repository                                      |
| `kind`     | `call` (plain call), `http` (frontend request → backend route), `event` (button → handler) |
| `via`      | for `http` / `event`: what connected the two sides, e.g. `"POST /api/checkout"`          |

Edges are built only by tree-sitter, never by an LLM. A call is resolved through the file's imports and
local definitions: `from services.pricing import apply_promo`, `from services import payments`
(`payments.create_link()`), tsconfig `paths` aliases (`@/api/client`), relative imports, re-exports,
`self.x()` / `this.x()`, and one piece of light inference, `cart = new Cart()` → `cart.label()` is
`Cart.label`.

What stays out of the graph on purpose:

- builtins (`len`, `print`, `console.log`, `JSON.parse`);
- method calls on local variables and parameters (`message.answer()`, `res.json()`): they cannot be
  resolved honestly without types and would only add noise;
- method calls on values (`texts.PAY.format()` is `str.format`, not a call of `PAY`).

Calls into third-party packages are kept as `external:<package>.<name>`, for example
`external:httpx.AsyncClient` or `external:react.useState`. A symbol that calls a known network SDK
(`httpx`, `requests`, `fetch`, `axios`, payment SDKs…) gets the layer `external`.

## Links

Links connect code across language and process boundaries — the frontend button, the API route it hits,
the bot button and its handler — by exact string match, never by guessing.

**Entries** are found on handlers:

| Source                                                   | `entry`                                            |
| -------------------------------------------------------- | -------------------------------------------------- |
| FastAPI / Flask `@router.post("/api/checkout")`          | `{ "kind": "http-route", "key": "POST /api/checkout" }` |
| `APIRouter(prefix="/api")`, `Blueprint(url_prefix=...)`  | prefix is joined into the key                      |
| Express / Hono `app.post('/api/checkout', handler)`      | `http-route` on `handler`                          |
| Next.js `pages/api/x.ts`, `app/api/x/route.ts` `POST`    | `ANY /api/x`, `POST /api/x`                        |
| aiogram `@router.callback_query(F.data == "checkout")`   | `{ "kind": "bot-callback", "key": "callback:checkout" }` |
| aiogram `Command("start")`, python-telegram-bot handlers | `bot-command` `command:/start`, `bot-callback`     |

**Requests and buttons** are found on callers: `fetch(url, { method })`, `axios.get/post/...`,
wrappers listed in `links.httpClients` (`api.post('/x')`), and `callback_data="checkout"` on bot buttons.

They match by method + path, where `{id}`, `${id}`, `:id` and `[id]` are the same parameter, a leading
`${API_URL}` is ignored, and `links.apiPrefix` may be added on either side. Bot callbacks match exactly or
by the handler's regex (`pattern="^order_\d+$"`). A match becomes a resolved edge:

```json
{
  "target": "py-bot/src/api/checkout.py#api_checkout",
  "line": 8,
  "resolved": true,
  "kind": "http",
  "via": "POST /api/checkout"
}
```

No match keeps `kind` and `via` but leaves the edge unresolved (`external:fetch`), so you still see the
request that has no handler in the repository.

## Summaries and blocks

Both are `null` until the summarizer runs.

```json
"summary": {
  "text": "Creates an order: totals the cart, applies the promo code, saves it and sends a payment link.",
  "forBodyHash": "…",
  "stale": false,
  "model": "claude-…",
  "createdAt": "2026-11-22T15:00:00.000Z"
}
```

A summary is valid while `forBodyHash` equals the symbol's `bodyHash`. `stale: true` means the code is
the same but a neighbour's signature changed.

`blocks` split a long function into meaningful steps for highlighting in the editor. Boundaries always
come from tree-sitter: `statements` are indices of top-level statements of the body, the model only
groups them and writes the label.

```json
"blocks": [
  {
    "range": { "start": [5, 4], "end": [6, 42] },
    "statements": [0, 1],
    "label": "totals the cart with promo",
    "text": "Sums the items and applies the promo code if it is still valid.",
    "forBodyHash": "…"
  }
]
```

## Stability guarantees

- Keys are written in schema order, symbols are sorted by position, edges by line, target, kind and via;
  indentation is 2 spaces with a trailing newline.
- Files are written atomically (temp file + rename) and only when their content changes.
- A rebuild of unchanged code produces identical bytes, so `.clewmap/` can be committed and reviewed like
  code.
