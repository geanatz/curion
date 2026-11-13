# Project direction

## Purpose

Curion provides project-local persistent memory to compatible AI agents through
an MCP stdio server. This document identifies the stable product boundaries on
the `main` code line. For behavior details, use the implementation and the
linked reference documents rather than experimental-branch descriptions.

## Product boundaries

- The public MCP interface exposes exactly two tools: `remember(text)` and
  `recall(text)`, with strict inputs and public `text` / `structuredContent`
  responses. Do not expand or change this contract without explicit approval.
- MCP transport is `stdio`. The MCP client spawns the server.
- The memory store is project-local under `.curion/`; it is runtime data, not
  repository documentation. Do not inspect, reset, or migrate a real store as
  part of docs or test maintenance.
- Provider configuration comes from the parent process environment in the
  `main` code line. Do not document an interactive setup CLI as available
  until it is integrated and verified on that baseline.
- Keep documentation in `docs/` and preserve data when changing storage.
  A schema change needs an isolated migration test.

## Decisions and evidence

Owner approval is required for changes to accepted product behavior and for
destructive or externally consequential actions. Worktree contents,
experimental results, draft plans, and unmerged pull requests are not proof of
approval or release readiness.

See [decision retrieval](decisions/README.md) for how to handle undocumented
choices. This file describes product boundaries, not a record of approval for
an experiment or a release.

## Release process

For future versions, manually dispatch `.github/workflows/publish.yml` on
`main` with the exact version and `PUBLISH` confirmation. The workflow
verifies Linux/macOS/Windows, publishes npm with provenance, and **only on
successful npm publication** creates the matching tag and GitHub Release
from the version's `CHANGELOG.md` entry. It attaches no duplicate packages.
The release step may be retried independently if the GitHub API fails
after npm publication. This process does not authorize automatic releases.

## Documentation

- [API contract](reference.md)
- [Configuration](configuration.md)
- [MCP clients](mcp-clients.md)
- [Privacy and storage](privacy-storage.md)
- [Decision retrieval](decisions/README.md)
