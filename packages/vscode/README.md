# Clewmap for VS Code and Cursor

A living map of your code, right in the editor. It reads the `.clewmap/` graph that the
[Clewmap CLI](https://github.com/A1exZabr/clewmap) keeps in your repository and shows:

- **A line above every function**: a plain-language summary, how many places call it, and which layers
  it reaches (data, external API…). Click to see callers or callees.
- **Hover** on a call or a function name: signature, layer, summary, who calls it, what it calls, and
  whether the last commit changed it. Instant: hover never asks a model.
- **Steps inside long functions**: alternating background, a thin line between steps and a label such as
  “① totals the cart”. Hover a line to read the step.
- **Layer stripes**: a colored stripe on lines that call into another layer, and a Δ on what the last
  commit touched.
- **Jumps across languages**: F12 on `fetch('/api/checkout')` or `callback_data="checkout"` opens the
  backend handler; Shift+F12 on a handler lists every button and request that leads to it.
- **The chain**: “Clewmap: Show the chain” walks from the entry point (button, route, bot command) down to
  data and external APIs. Alt+[ and Alt+] step through it.
- **Side panel**: neighbors graph, impact of the last commit, fuzzy search over names and summaries,
  and “Explain in more depth”, which asks your configured model once and caches the answer per code
  version.

## Getting started

```bash
npx clewmap init --hooks
```

Then open the folder. Everything stays local: the graph is plain JSON in your repository, summaries
come from `claude -p` on your subscription, the Anthropic API (`ANTHROPIC_API_KEY`) or Ollama.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `clewmap.codeLens.enabled` | `true` | line above functions |
| `clewmap.hover.enabled` | `true` | hover cards |
| `clewmap.layerStripes.enabled` | `true` | colored stripes |
| `clewmap.blocks.enabled` | `true` | steps inside functions |
| `clewmap.blocks.style` | `both` | `tint`, `label` or `both` |
| `clewmap.summaryLanguage` | `""` | language for “Explain in more depth” |

MIT license.
