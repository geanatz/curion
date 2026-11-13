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

See [accepted decisions and provenance](decisions/README.md) for
scope-specific authority and supersession. This file describes enduring
product boundaries; historical approvals do not authorize future operations.

## Release process

For future versions, manually dispatch `.github/workflows/publish.yml` on
`main` with the exact version and `PUBLISH` confirmation. The workflow
verifies Linux/macOS/Windows, publishes npm with provenance, and **only on
successful npm publication** creates the matching tag and GitHub Release
from the version's `CHANGELOG.md` entry. It attaches no duplicate packages.
The release step can be retried without a second npm publication if the
GitHub API fails afterward. The integrated GitHub Release step has passed
static/synthetic checks, but its real end-to-end behavior remains unverified
until a separately approved future release. This process does **not**
authorize automatic releases or provider-backed test calls.

Outstanding work belongs in GitHub Issues, particularly
[legacy Windows ACLs (#8)](https://github.com/geanatz/curion/issues/8) and
[optional offline MCP success tests (#6)](https://github.com/geanatz/curion/issues/6).
Experimental adaptive-recall [PR #1](https://github.com/geanatz/curion/pull/1)
remains separate from the published product.

## Documentation

- [API contract](reference.md)
- [Configuration](configuration.md)
- [MCP clients](mcp-clients.md)
- [Privacy and storage](privacy-storage.md)
- [Accepted decisions and provenance](decisions/README.md)
