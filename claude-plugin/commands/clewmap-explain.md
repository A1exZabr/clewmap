---
description: Explain a function or class in depth using the Clewmap code map — what it does, the steps inside it, who calls it and what it reaches.
argument-hint: "<function name or file#name>"
allowed-tools: mcp__plugin_clewmap_graph__clewmap_get_symbol, mcp__plugin_clewmap_graph__clewmap_find_callers, mcp__plugin_clewmap_graph__clewmap_find_callees, mcp__plugin_clewmap_graph__clewmap_search, Read
---

Explain `$ARGUMENTS` to the user in depth.

1. Call `clewmap_get_symbol` with it. If the name is ambiguous or unknown, pick from the matches or call
   `clewmap_search`, and say which symbol you chose.
2. Call `clewmap_find_callers` with `depth: 2` and `clewmap_find_callees` with `depth: 2`.
3. Read the code of the symbol (the `at` field gives file and line).
4. Write the explanation in the user's language: what it is for, how it works step by step (use the
   `steps` from the graph when present), what it reads and changes (data, network, state), who calls it
   up to the entry point (route, button, command) and what it relies on, and edge cases visible in the
   code. Describe what the code does; do not review it or propose changes unless asked.
