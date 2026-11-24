# GitHub Action

The git hooks keep `.clewmap/` up to date for everyone who installed them. The action covers the rest:
commits made in the GitHub web editor, by bots, or by people without the hooks. On every push it updates
the graph (tree-sitter only, a few seconds) and commits the changed `.clewmap/` files back as
`clewmap[bot]` with `[skip ci]`, so the commit does not start the workflow again.

## Workflow

`.github/workflows/clewmap.yml`:

```yaml
name: Code map
on:
  push:
    branches: [main]

permissions:
  contents: write # to push the bot commit

concurrency:
  group: clewmap-${{ github.ref }}
  cancel-in-progress: false

jobs:
  map:
    runs-on: ubuntu-latest
    steps:
      - uses: A1exZabr/clewmap/action@main
```

On the first run in a repository without `.clewmap/` the action runs `clewmap init` and a full build, so
the map appears with the next commit.

## Summaries in CI

By default summaries are written on developers' machines (the post-commit hook, `claude -p` on their
subscription). To write them in CI instead, add an Anthropic API key as a repository secret and turn them on:

```yaml
      - uses: A1exZabr/clewmap/action@main
        with:
          summaries: true
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # model: claude-opus-5-5   # optional, this is the default
```

Only new and changed functions are described, and an unchanged function is never sent to the model again
(the summary is cached by the hash of its body). Without the key the step prints a warning and the graph
is still updated.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `version` | `latest` | version of the `clewmap` npm package |
| `cli` | | command that runs Clewmap instead of `npx -y clewmap@<version>`, e.g. `node ./node_modules/.bin/clewmap` |
| `since` | `github.event.before` | commit to diff against; a full rebuild runs when it is missing (first push, force push) |
| `summaries` | `false` | also write summaries |
| `anthropic-api-key` | | API key for summaries, from a secret |
| `model` | | model for summaries |
| `working-directory` | `.` | folder with `clewmap.config.json` |
| `commit-message` | `chore(clewmap): update the code map [skip ci]` | |
| `checkout` | `true` | set to `false` if your workflow already checked out the repository with full history |
| `token` | `github.token` | token used to push |

Output: `committed` is `"true"` when the action pushed a commit.

## Protected branches

If `main` requires pull requests, the bot cannot push to it. Either allow the GitHub Actions bot to bypass
the rule for this workflow, or run the action on pull requests (`on: pull_request`) so the map is updated in
the PR branch before it is merged.

## If a push races the action

When someone pushes while the action is running, its push is rejected; the action rebases its commit on the
new `main` and tries again (up to three times). Its commit only touches `.clewmap/`, so the rebase is clean
unless the other push changed `.clewmap/` too; in that case the next run fixes the graph.
