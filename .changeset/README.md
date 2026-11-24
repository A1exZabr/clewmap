# Changesets

Clewmap ships one version for everything: the `clewmap` npm package, the VS Code extension and the
Claude Code plugin. Describe a change with `pnpm changeset` (choose `clewmap`), and before a release run
`pnpm version-packages`: it bumps `packages/clewmap`, writes the changelog and copies the version to the
extension, the plugin and the graph generator tag. Then tag `vX.Y.Z` and push the tag.
