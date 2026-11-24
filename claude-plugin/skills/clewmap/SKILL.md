---
name: clewmap
description: Use the Clewmap code map (.clewmap/) to understand code and check what a change breaks. Use before changing, renaming or deleting a function, when asked "what breaks if…", "who calls…", "where is X done", or when getting to know an unfamiliar repository that has a .clewmap/ folder.
when_to_use: The repository has a .clewmap/ directory and the task involves editing functions, tracing a flow (button → API → database), reviewing impact, or exploring the codebase.
---

# Working with the Clewmap code map

This repository keeps a call graph in `.clewmap/`, built by tree-sitter (edges are exact, not guessed),
with a short plain-language summary of every function. The `graph` MCP server gives you tools over it.
They answer in milliseconds and never call a model.

## Before you change code

1. Call `clewmap_impact` with the functions you are about to change (`ids: ["apply_promo"]`). It returns
   the callers up to three steps away, the files they live in and the entry points the change reaches
   (HTTP routes, bot commands, buttons). With no arguments it reads the uncommitted `git diff HEAD`, so
   it is also the right check **after** editing.
2. Call `clewmap_find_callers` for every function whose signature or return value changes, and update
   those callers in the same change.
3. Mention the affected entry points in your summary to the user: "this also changes POST /api/checkout
   and the bot's checkout button".

## Getting to know the code

- Start with `clewmap_search` ("promo code", "payment link") and `clewmap_module_summary` for a file,
  not with grep over every file.
- `clewmap_get_symbol` gives the signature, location, summary, the steps inside the function and its
  callers and callees in one call.
- `clewmap_find_callees` with `depth: 2–3` follows a flow down to the database and external APIs;
  `clewmap_find_callers` follows it up to the button or route. Links marked `http` or `event` cross
  language boundaries (a frontend `fetch` to a Python route, a bot button to its handler).

## Rules

- Never edit files in `.clewmap/` by hand. Git hooks refresh the graph on every commit and write
  summaries in the background.
- If `clewmap_status` says the graph is out of date (you edited files), call `clewmap_update` before
  relying on callers or impact for those files. It only rebuilds edges and takes well under a second.
- A summary with `summaryStatus: "stale"` or `"missing"` may lag behind the code: read the code itself
  before relying on it.
- If the tools are missing or the server reports no `.clewmap/`, suggest `/clewmap:clewmap-init`.
