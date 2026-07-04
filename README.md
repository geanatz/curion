# Curion

[![npm](https://img.shields.io/npm/v/@geanatz/curion)](https://www.npmjs.com/package/@geanatz/curion)
![Node](https://img.shields.io/node/v/@geanatz/curion)
[![CI](https://img.shields.io/github/actions/workflow/status/geanatz/curion/ci.yml?branch=main&label=ci)](https://github.com/geanatz/curion/actions/workflows/ci.yml)
[![provenance](https://img.shields.io/badge/provenance-verified-blue)](https://docs.npmjs.com/generating-provenance-statements)
[![License](https://img.shields.io/github/license/geanatz/curion)](https://github.com/geanatz/curion/blob/main/LICENSE)

> **Project-local memory layer for AI agents, exposed as a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) stdio server.**

Curion gives your AI agent a **persistent memory of the project it is working
in**. Across sessions it can remember design decisions, architecture choices,
team conventions, and anything else you choose to store — and recall the
relevant pieces when you ask.

It runs as a local MCP stdio server that any compatible client can spawn.
Each project has its own private store at `.curion/`; memories are never
sent to a shared backend.

The public MCP API (the two tools, their strict input schemas, and the public
`text` / `structuredContent` surfaces) is stable and frozen.

---

## Table of contents

- [Why Curion](#why-curion)
- [Quick start](#quick-start)
- [Other MCP clients](#other-mcp-clients)
- [Example prompts](#example-prompts)
- [Key features](#key-features)
- [Privacy & storage](#privacy--storage)
- [Configuration essentials](#configuration-essentials)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Support, security, and contributing](#support-security-and-contributing)

---

## Why Curion

- **Persistent, project-local memory.** Design decisions, conventions, and
  "things to remember" survive across sessions inside `.curion/`.
- **Two tools, one surface.** `remember(text)` stores a piece of project
  memory; `recall(text)` retrieves the relevant pieces. Each takes a single
  `text` parameter — no kinds, states, filters, or knobs on the public API.
- **Private by default.** Memory lives in your project. Memories are never
  sent to a shared backend. Mark a project private with one line of JSON
  and it will never be surfaced by cross-project retrieval.
- **Pluggable providers.** OpenAI-compatible (default) or Anthropic. Add a
  fallback provider, or enable opt-in semantic retrieval.
- **Stable, frozen public API.** The two tools, their strict input schemas,
  and the public `text` / `structuredContent` surfaces are stable and frozen.

---

## Quick start

Requires **Node.js `>= 22`** (matches the `engines.node` field in `package.json`).

```sh
# Recommended: install globally so the `curion` binary is on your PATH.
npm install -g @geanatz/curion
```

The package installs a `curion` CLI binary which is the MCP stdio server
entrypoint. When an MCP client spawns it, `curion` speaks JSON-RPC over
stdin/stdout and writes all logs to stderr. It is **not** an interactive
CLI — always start it through an MCP client that manages the stdio transport.

> **stdio transport only.** Curion only exposes the stdio transport. It does
> **not** open any network sockets and does **not** run as a long-lived
> process you start from a terminal. The MCP host (your client) spawns
> `curion` as a subprocess and is responsible for the network boundary.
> See [Security model](docs/privacy-storage.md#security-model).

### Register with your MCP client

Claude Code is the recommended MCP client. Registering Curion with
`--scope project` keeps the configuration inside the repo (via
`.mcp.json`), so every contributor gets the same server setup without
touching their global MCP config.

```sh
claude mcp add --scope project --transport stdio curion -- curion
```

For Codex CLI, OpenCode, Claude Desktop, and other clients, see
[MCP client setup](docs/mcp-clients.md).

### Provide a provider

Curion has **no built-in provider defaults**. Configure a primary
provider in your shell environment before launching the MCP client
(Curion does not load `.env` files):

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

Full env-var reference: [Configuration](docs/configuration.md).

---

## Other MCP clients

Curion works with any MCP client that can spawn a stdio server. Full
configuration snippets and caveats:

- **[Claude Code (recommended)](docs/mcp-clients.md#claude-code-recommended)** — `claude mcp add --scope project --transport stdio curion -- curion`.
- **[OpenAI Codex CLI](docs/mcp-clients.md#openai-codex-cli)** — `config.toml` or `codex mcp add`.
- **[OpenCode](docs/mcp-clients.md#opencode)** — `opencode.json`.
- **[Claude Desktop](docs/mcp-clients.md#claude-desktop-generic--secondary)** — generic stdio client.
- **[Pi Coding Agent](docs/mcp-clients.md#pi-coding-agent-no-native-mcp-support)** — Pi has no native MCP support; use Claude Code, Codex CLI, or OpenCode instead.
- **[Any other stdio MCP client](docs/mcp-clients.md#other-mcp-clients-generic-stdio)** — spawn `curion` with provider env vars in the environment.

---

## Example prompts

Once your MCP client is connected, the agent can call `remember` and
`recall` directly. The strings below are exactly what an agent would pass
as the `text` parameter.

**Store a design decision:**

```text
remember: "We chose SQLite (better-sqlite3) over Postgres for the memory
store because the project is single-host and the binary footprint is
smaller. Migration to a hosted DB is not in scope."
```

**Store a convention:**

```text
remember: "Conventions: TypeScript strict mode on, 2-space indent,
double-quoted strings, Biome for lint+format. See CONTRIBUTING.md."
```

**Recall later:**

```text
recall: "Why did we pick SQLite over Postgres for the memory store?"
```

**Ask about a convention:**

```text
recall: "What are the project's formatting and lint conventions?"
```

The agent receives a calm prose `text` content block plus a structured
discriminated shape on `structuredContent`. Discriminate with
`structuredContent.status` (`saved` / `answered` / `weak_match` /
`no_memory` / `rejected` / `provider_error`). When
`clarification_needed` is present, the agent must ask the user the
`question` verbatim — see the
[API reference](docs/reference.md#clarification_needed).

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
- **Reproducible installs.** The npm package is published with Trusted
  Publishing and OIDC provenance (`publishConfig.provenance: true`); no
  long-lived `NPM_TOKEN` secret is required.

See the full [API reference](docs/reference.md) for statuses, output shapes,
and the `clarification_needed` contract.

---

## Privacy & storage

Each project has its own `.curion/` directory. Memories are stored locally
and are **never** sent to a shared backend.

```
<projectRoot>/.curion/
  curion.sqlite            # SQLite database (gitignored)
  trace.sqlite             # Local trace database (gitignored, opt-out via env)
  transformers-cache/      # Embedder cache when semantic retrieval is on
  config.json              # Project config (e.g. { isPrivate: true })
```

When semantic retrieval is enabled, Curion may semantically search
external **non-private** projects alongside the local project. **Private
projects are never surfaced.** Mark a project private with
`.curion/config.json`:

```json
{ "version": 1, "isPrivate": true }
```

See [Privacy & storage](docs/privacy-storage.md) for the full story,
including the security model, trace redaction, and `.curion/config.json`
semantics.

---

## Configuration essentials

Curion is configured entirely through environment variables passed by the
parent process. It does **not** load `.env` files.

The minimum is a primary provider (`CURION_PRIMARY_API_KEY`,
`CURION_PRIMARY_BASE_URL`, `CURION_PRIMARY_MODEL`, optionally
`CURION_PRIMARY_API_FORMAT`). Optional knobs cover a fallback provider,
semantic retrieval (`CURION_SEMANTIC_ENABLED`), log level
(`CURION_LOG_LEVEL`), and trace enable/disable
(`CURION_TRACE_ENABLED`).

See [Configuration](docs/configuration.md) for the full variable list and
examples.

---

## Troubleshooting

**Curion started but the agent can't see the tools.** The MCP host is the
process boundary. Make sure the spawn succeeded (look at stderr) and that
the host's tool list refresh picked up the new server. With Claude Code,
run `claude mcp list` to confirm `curion` is registered.

**"No relevant memory found." but you know you stored something.** The
controller only stores controller-normalized summaries, not raw input. If
your `remember` call was `rejected` (e.g. safety filter), no row was
written. With `CURION_LOG_LEVEL=debug`, the recall-side retrieval logs
the candidate set, scores, and threshold decisions.

**Tool returns `provider_error`.** The provider call failed. Check the
`reason` field on `structuredContent`, confirm the env vars are present
in the spawn environment (Curion does **not** load `.env` files), and
check the provider's own status page.

**Inspect the JSON-RPC stream.** The official
[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is the
canonical tool for ad-hoc debugging — it spawns the stdio server, lets you
list tools, and lets you invoke `remember` / `recall` with arbitrary
`text`:

```sh
npx -y @modelcontextprotocol/inspector curion
```

**Anything written to stdout corrupts the protocol.** All logging travels
on stderr (see [Configuration → Logging](docs/configuration.md#logging)).
If you wrap or redirect `curion`, never redirect or capture stdout —
redirect stderr instead. A single stray `console.log` from a wrapper will
break every subsequent JSON-RPC frame.

**Windows / `npx -y` gotchas.** If your MCP client does not resolve a
binary on `PATH` (common on Windows), use the `cmd /c npx` wrapper
described in [MCP client setup → Windows / `npx` wrapper](docs/mcp-clients.md#windows--npx-wrapper).
For project-local installs without a global `curion` on `PATH`, prefer
the **absolute path** to `node_modules/.bin/curion` rather than relying
on shell resolution — see the same page.

---

## Documentation

- **[MCP client setup](docs/mcp-clients.md)** — Claude Code, Codex CLI,
  OpenCode, Claude Desktop, Pi caveat, generic stdio, Windows `npx`
  wrapper, absolute-path guidance.
- **[Configuration](docs/configuration.md)** — primary/fallback provider
  env vars, semantic retrieval, logging, trace toggle.
- **[API reference](docs/reference.md)** — `remember` / `recall` tools,
  output shapes, statuses, `clarification_needed`.
- **[Privacy & storage](docs/privacy-storage.md)** — local store layout,
  cross-project semantic search, private projects, trace, security model.
- **[CHANGELOG](CHANGELOG.md)** — release notes (Keep a Changelog format).

---

## Support, security, and contributing

- **Bug reports and feature requests:** open a GitHub issue at
  [`github.com/geanatz/curion/issues`](https://github.com/geanatz/curion/issues).
- **Security issues:** do **not** file a public issue — see
  [SECURITY.md](SECURITY.md) for the private reporting channel. Expected
  response time is 7 days.
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow,
  development setup, and testing expectations. By participating, you
  agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
- **License:** [Apache License 2.0](LICENSE).