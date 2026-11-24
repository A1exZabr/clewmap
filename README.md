# Clewmap

A living map of your codebase: plain-language explanations of every function and code block right in the editor, a call graph that updates on every commit, and a local MCP server so AI agents know what breaks before they change it.

Status: early development. See `docs/clewmap-vision.md` and `docs/clewmap-ai-plan.md`.

## Claude Code plugin

```
/plugin install clewmap --marketplace A1exZabr/clewmap
```

The plugin adds the `graph` MCP server (`clewmap_impact`, `clewmap_find_callers`, `clewmap_search`, …), a skill
that makes Claude check the impact of a change before editing, and the `/clewmap:clewmap-init` and
`/clewmap:clewmap-explain` commands. Any other MCP client can run the server with `npx -y clewmap mcp`.

## GitHub Action

Keeps `.clewmap/` in sync on every push to `main`: see [docs/github-action.md](docs/github-action.md).

## Development

```bash
pnpm install
pnpm build
pnpm test
```

License: MIT
