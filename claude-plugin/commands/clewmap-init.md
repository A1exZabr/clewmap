---
description: Set up Clewmap in this repository — build the code map, write summaries and install the git hooks.
argument-hint: "[--no-summaries]"
allowed-tools: Bash(npx -y clewmap:*), Bash(npx clewmap:*), Bash(git status:*), Read
---

Set up Clewmap in the current repository.

1. Run `npx -y clewmap init --hooks`. It creates `clewmap.config.json` with the detected languages and
   layers, adds the service files to `.gitignore` and installs the pre-commit and post-commit hooks
   (it only appends its own block to existing hooks).
2. Show the user the detected `include` and `layers` from `clewmap.config.json` in two or three lines and
   ask whether they look right only if something is obviously off (for example `include` is `**` in a
   monorepo with several apps).
3. Run `npx -y clewmap build` to index the code and write summaries. If the arguments contain
   `--no-summaries`, run `npx -y clewmap build --no-summaries` instead. Summaries use `claude -p` on the
   user's subscription by default; the first run on a big repository can take several minutes, so tell
   the user before starting.
4. Run `npx -y clewmap status` and report: files and symbols in the graph, how many summaries were
   written, and that the hooks will keep `.clewmap/` up to date on every commit.
5. Suggest committing `clewmap.config.json` and `.clewmap/` so the whole team gets the map.

Arguments: $ARGUMENTS
