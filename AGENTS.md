# Repository guidance

- Consult [project direction](docs/direction.md) and
  [decision retrieval](docs/decisions/README.md) before changing the
  product contract or interpreting historical project decisions.
- Check claims against the current source and tests; do not treat experimental
  docs, benchmarks, or unmerged work as approval or as live behavior.
- Keep documentation in `docs/`. The `.curion/` directory contains runtime
  memory data and must not be used for repository documentation or test fixtures.
- Preserve dirty or active worktrees. Do not push, merge, rebase, deploy,
  delete worktrees, touch live data, or perform external actions without
  explicit authorization.
