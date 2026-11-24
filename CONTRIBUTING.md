# Contributing to Clewmap

Thanks for looking. Bug reports with a small repository that reproduces them are the most useful thing
you can send; pull requests are welcome too.

## Setup

```bash
pnpm install
pnpm build
pnpm test        # unit tests (Vitest)
pnpm lint
```

Node 20 or newer and pnpm 9. The tree-sitter grammars ship as `.wasm` files, nothing is compiled natively.

| Package | |
| --- | --- |
| `packages/core` | graph schema, reading and writing `.clewmap/`, the in-memory index, search |
| `packages/indexer` | tree-sitter parsing, edges, links across languages, incremental updates |
| `packages/summarizer` | summaries and blocks through `claude -p`, the Anthropic API or Ollama |
| `packages/cli` | the `clewmap` command and git hooks |
| `packages/mcp` | the MCP server |
| `packages/vscode` | the VS Code / Cursor extension |
| `packages/clewmap` | the published npm package (bundles everything above) |
| `claude-plugin/`, `action/` | the Claude Code plugin and the GitHub Action |

The extension has its own tests that run inside a real VS Code:

```bash
pnpm --filter clewmap-vscode test:vscode
```

## Rules the code keeps

- Edges between symbols are built only by tree-sitter. A model writes text: summaries, block labels,
  explanations. It never decides what calls what.
- One JSON file per source file, outgoing edges only, stable serialization. A rebuild of unchanged code
  must produce identical bytes.
- Summaries are cached by `bodyHash`; an unchanged function is never sent to a model again.
- Git hooks never block a commit for more than a couple of seconds and always exit with code 0. The
  only exception is the opt-in `hooks.summarize: "pre-commit"`.
- Hover in the extension never calls a model.
- Everything runs locally: no telemetry, no servers of our own, keys only from the environment.
- Child processes are spawned with an argument array, never through a shell.

## Pull requests

- One change per pull request, with a test that fails without it.
- `pnpm test`, `pnpm lint` and `pnpm format:check` pass.
- If the change is user-visible, add a changeset: `pnpm changeset`, choose `clewmap`.
- Changes to the `.clewmap/` format need an update of `docs/graph-format.md` and a note on compatibility.

## Adding a language

A language is an adapter in `packages/indexer/src/adapters/` that turns a tree-sitter tree into symbols,
calls and imports. Look at `python.ts` and `typescript.ts`, add a fixture under `fixtures/` and tests
that pin the expected edges.
