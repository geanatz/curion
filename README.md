# Curion

[![npm](https://img.shields.io/npm/v/@geanatz/curion)](https://www.npmjs.com/package/@geanatz/curion)
![Node](https://img.shields.io/node/v/@geanatz/curion)
[![License](https://img.shields.io/github/license/geanatz/curion)](https://github.com/geanatz/curion/blob/main/LICENSE)

> Project-local memory layer for AI agents, exposed as a Model Context Protocol (MCP) stdio server.

---

## Why Curion

Curion gives your AI agent a **persistent memory of the project it is working in**.
Across sessions it can remember design decisions, architecture choices, team
conventions, and anything else you choose to store — and recall the relevant
pieces when you ask.

It runs as a local **MCP stdio server** that any compatible client can spawn.
Each project has its own private store at `.curion/`; memories are never
sent to a shared backend.

The public MCP API (the two tools, their strict input schemas, and the public
`text` / `structuredContent` surfaces) is stable and frozen.

---

## Install

Requires **Node.js `>= 22`** (matches the `engines.node` field in `package.json`).

```sh
# Recommended: install globally so the `curion` binary is on your PATH.
npm install -g @geanatz/curion
```

The package installs a `curion` CLI binary which is the MCP stdio server
entrypoint. When an MCP client spawns it, `curion` speaks JSON-RPC over
stdin/stdout and writes all logs to stderr. It is **not** an interactive
CLI — always start it through an MCP client that manages the stdio transport.

---

## Quick start (Claude Code)

Claude Code is the recommended MCP client. Registering Curion with
`--scope project` keeps the configuration inside the repo (via `.mcp.json`),
so every contributor gets the same server setup without touching their
global MCP config.

```sh
claude mcp add --scope project --transport stdio curion -- curion
```

Then configure a provider in your shell environment before launching
Claude Code (Curion does not load `.env` files):

```sh
# OpenAI-compatible (default)
export CURION_PRIMARY_API_KEY=sk-...
export CURION_PRIMARY_BASE_URL=https://api.openai.com/v1
export CURION_PRIMARY_MODEL=your-model-id

# Anthropic
export CURION_PRIMARY_API_FORMAT=anthropic
export CURION_PRIMARY_API_KEY=sk-ant-...
export CURION_PRIMARY_MODEL=your-model-id
```

For full client wiring (project-scoped `.mcp.json` with an `env` block,
team-shared config tips, etc.) see
[MCP client setup](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md#claude-code-recommended).

---

## Other MCP clients

Curion works with any MCP client that can spawn a stdio server. Full
configuration snippets and caveats:

- **[OpenAI Codex CLI](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md#openai-codex-cli)** — `config.toml` or `codex mcp add`.
- **[OpenCode](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md#opencode)** — `opencode.json`.
- **[Claude Desktop](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md#claude-desktop-generic--secondary)** — generic stdio client.
- **[Pi Coding Agent](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md#pi-coding-agent-no-native-mcp-support)** — Pi has no native MCP support; use Claude Code, Codex CLI, or OpenCode instead.
- **[Any other stdio MCP client](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md#other-mcp-clients-generic-stdio)** — spawn `curion` with provider env vars in the environment.

---

## Key features

- **Two tools, one surface.** `remember(text)` stores a piece of project
  memory; `recall(text)` retrieves the relevant pieces. Each takes a single
  `text` parameter — no kinds, states, filters, or knobs on the public API.
- **Raw input is never persisted.** Only controller-normalized summaries
  and metadata (kind, confidence, safety flags, timestamps) land in the
  local SQLite store.
- **Project-local by default.** Memory lives in `.curion/` inside the
  project. Memories are never sent to a shared backend.
- **Pluggable providers.** OpenAI-compatible (default) or Anthropic.
  Add a fallback provider, or enable opt-in semantic retrieval.
- **Stable, frozen public API.** The two tools, their strict input schemas,
  and the public `text` / `structuredContent` surfaces are stable and frozen.

See the full [API reference](https://github.com/geanatz/curion/blob/main/docs/reference.md) for statuses, output shapes,
and the `clarification_needed` contract.

---

## Privacy & storage

Each project has its own `.curion/` directory. Memories are stored locally
and are **never** sent to a shared backend.

```
<projectRoot>/.curion/
  curion.sqlite    # SQLite database (gitignored)
```

When semantic retrieval is enabled, Curion may semantically search
external **non-private** projects alongside the local project. **Private
projects are never surfaced.** Mark a project private with
`.curion/config.json`:

```json
{ "version": 1, "isPrivate": true }
```

See [Privacy & storage](https://github.com/geanatz/curion/blob/main/docs/privacy-storage.md) for the full story.

---

## Configuration essentials

Curion is configured entirely through environment variables passed by the
parent process. It does **not** load `.env` files.

The minimum is a primary provider (`CURION_PRIMARY_API_KEY`,
`CURION_PRIMARY_BASE_URL`, `CURION_PRIMARY_MODEL`, optionally
`CURION_PRIMARY_API_FORMAT`). Optional knobs cover a fallback provider,
semantic retrieval (`CURION_SEMANTIC_ENABLED`), and log level
(`CURION_LOG_LEVEL`).

See [Configuration](https://github.com/geanatz/curion/blob/main/docs/configuration.md) for the full variable list and
examples.

---

## Documentation

- **[MCP client setup](https://github.com/geanatz/curion/blob/main/docs/mcp-clients.md)** — Claude Code, Codex CLI,
  OpenCode, Claude Desktop, Pi caveat, generic stdio.
- **[Configuration](https://github.com/geanatz/curion/blob/main/docs/configuration.md)** — primary/fallback provider
  env vars, semantic retrieval, logging.
- **[API reference](https://github.com/geanatz/curion/blob/main/docs/reference.md)** — `remember` / `recall` tools,
  output shapes, statuses, `clarification_needed`.
- **[Privacy & storage](https://github.com/geanatz/curion/blob/main/docs/privacy-storage.md)** — local store layout,
  cross-project semantic search, private projects.

---

## Contributing

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/geanatz/curion/blob/main/CONTRIBUTING.md)
for the workflow, development setup, and testing expectations. Please
also read
[CODE_OF_CONDUCT.md](https://github.com/geanatz/curion/blob/main/CODE_OF_CONDUCT.md)
and
[SECURITY.md](https://github.com/geanatz/curion/blob/main/SECURITY.md).

---

## License

[Apache License 2.0](https://github.com/geanatz/curion/blob/main/LICENSE).