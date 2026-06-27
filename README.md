# Curion

Project-local memory layer for AI agents, exposed as a Model Context Protocol
(MCP) stdio server. `v0.1.0` is tagged. The public MCP API (the two tools,
their strict input schemas, and the public `text` / `structuredContent`
surfaces) is stable and frozen.

## What is Curion

Curion runs in your project directory and remembers what your AI agent learns
across sessions — design decisions, architecture choices, team conventions, and
anything else you store via `remember(text)`. When you ask via `recall(text)`,
it retrieves relevant memories from your local project store.

Curion is **not** a shared team memory. Each project has its own private store.
Memories are never sent to a shared backend — everything stays local.

## Quickstart

```sh
# Build
npm run build

# Configure your OpenAI-compatible provider (required for remember + recall)
export CURION_PRIMARY_API_KEY=sk-...
export CURION_PRIMARY_BASE_URL=https://api.openai.com/v1
export CURION_PRIMARY_MODEL=gpt-5.5

# Start the MCP server (stdio — stdout is MCP protocol only, logs go stderr)
./dist/index.js
```

### MCP client configuration

Curion communicates over stdio. Configure your MCP client to spawn it:

**Claude Desktop** (`~/.claude.json` or project-level):

```json
{
  "mcpServers": {
    "curion": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "CURION_PRIMARY_API_KEY": "sk-...",
        "CURION_PRIMARY_BASE_URL": "https://api.openai.com/v1",
        "CURION_PRIMARY_MODEL": "gpt-4o"
      }
    }
  }
}
```

**Other MCP clients**: spawn `node dist/index.js` with the provider env vars in
the environment. No `.env` file is loaded — secrets must be passed by the parent
process.

## Environment variables

Curion does **not** load `.env` files. All configuration is via environment
variables passed by the parent process.

### Required (provider configuration)

Curion has **no built-in provider defaults**. You must configure at least a
primary provider to use `remember()` and `recall()`.

| Variable | Description |
|---|---|
| `CURION_PRIMARY_API_KEY` | API key for the primary provider. |
| `CURION_PRIMARY_BASE_URL` | Base URL for the primary provider's endpoint. For OpenAI-compatible providers this is the base URL for `/chat/completions`. For Anthropic, this defaults to `https://api.anthropic.com` when `CURION_PRIMARY_API_FORMAT=anthropic` and is not set. |
| `CURION_PRIMARY_MODEL` | Model id for the primary provider. |
| `CURION_PRIMARY_API_FORMAT` | API format: `openai-compatible` (default) or `anthropic`. Controls whether to use the OpenAI-compatible HTTP path or the official Anthropic SDK. |

Optional: `CURION_PRIMARY_PROVIDER_LABEL` (auto-detected from base URL), `CURION_PRIMARY_STRICT_JSON` (default false).

### Optional

| Variable | Default | Description |
|---|---|---|
| `CURION_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error`. |
| `CURION_PROJECT_ROOT` | `process.cwd()` | Project root override. |

#### Fallback provider (opt-in)

The fallback slot is empty by default. To add a fallback provider:

```sh
export CURION_FALLBACK_API_KEY=...
export CURION_FALLBACK_BASE_URL=https://api.example.com/v1
export CURION_FALLBACK_MODEL=your-model-id
export CURION_FALLBACK_API_FORMAT=openai-compatible  # or "anthropic"
```

Optional: `CURION_FALLBACK_PROVIDER_LABEL`, `CURION_FALLBACK_STRICT_JSON`.

#### Semantic retrieval (opt-in)

Semantic retrieval is **off by default**. Enable it with:

```sh
export CURION_SEMANTIC_ENABLED=1
```

When enabled, Curion runs both lexical (token-overlap) and semantic (dense
vector) retrieval, then fuses the rankings. This recovers paraphrase matches
that the lexical ranker misses.

| Variable | Default | Description |
|---|---|---|
| `CURION_SEMANTIC_ENABLED` | `0` | Set to `1` to enable semantic retrieval. |
| `CURION_SEMANTIC_ALLOW_REMOTE` | `1` | Set to `0` to disable Hugging Face CDN model download. |
| `CURION_SEMANTIC_CACHE_DIR` | `<projectRoot>/.curion/transformers-cache/` | Local model cache directory. |
| `CURION_SEMANTIC_MODEL_ID` | `Xenova/bge-small-en-v1.5` | Embedder model id. |

The default embedder (`Xenova/bge-small-en-v1.5`, 384-dim, quantized, ~25 MB)
runs entirely on-device (CPU, no GPU). First launch downloads the ONNX model
from Hugging Face CDN and caches it locally.

## Privacy and cross-project memory

Each project has its own `.curion/` directory. Memories are stored locally and
are **never** sent to a shared backend.

When semantic retrieval is enabled (`CURION_SEMANTIC_ENABLED=1`), Curion may
semantically search external non-private projects alongside the local project.
**Private projects are never surfaced.**

To mark a project private, create `.curion/config.json` in the project root:

```json
{ "version": 1, "isPrivate": true }
```

## Storage

```
<projectRoot>/.curion/
  curion.sqlite    # SQLite database (gitignored)
```

The database schema is additive and idempotent. **Raw input text is never
persisted** — only controller-normalized summaries and metadata (kind, confidence,
safety flags, timestamps).

## Tools

Exactly two tools. Each accepts a single `text` parameter (string, required,
non-empty). No kinds, states, filters, providers, or other knobs.

### `remember(text: string)`

Store a piece of project memory.

Runs a local safety pre-check, the provider adapter for analysis, controller
validation, and persistence. **Raw input is never persisted.**

**Statuses:** `saved` | `rejected` | `provider_error`

### `recall(text: string)`

Retrieve relevant project memory.

Runs lexical retrieval over the local store, ambiguity and resolved-history
detectors, and synthesis.

**Statuses:** `answered` | `weak_match` | `no_memory` | `rejected` | `provider_error`

## Output shapes

Each tool returns a `text` content block (human-readable prose) and a
`structuredContent` payload (clean discriminated shape). Use `status` on
`structuredContent` to discriminate.

### `structuredContent` — recall

```typescript
{ status: "answered",     answer: string, notes?: string }
{ status: "weak_match",   summaries: string[], coverage: { topScore: number, supportingCount: number }, clarification_needed?: ClarificationNeeded }
{ status: "no_memory",   clarification_needed?: ClarificationNeeded }
{ status: "rejected",     reason: string, clarification_needed?: ClarificationNeeded }
{ status: "provider_error", reason: string }
```

### `structuredContent` — remember

```typescript
{ status: "saved",              summary: string, kind: string, confidence?: number }
{ status: "rejected",           reason: string, clarification_needed?: ClarificationNeeded }
{ status: "provider_error",      reason: string }
```

### `clarification_needed` object

When present on a user-intent-uncertainty status (`rejected`, `no_memory`, `weak_match`), the agent must ask the user the `question` verbatim. `suggestions` is an optional rephrase-hint list, present only when useful; suggestions are aids, never assumptions. `provider_error` never carries `clarification_needed`.

```typescript
{ question: string, suggestions?: string[] }
```

## Build and test

```sh
npm run build      # TypeScript → dist/
npm run test       # Run all tests
npm start          # Run the MCP server (after build)
npm run clean      # Remove dist/
```

## Project layout

```
src/
  index.ts              # MCP stdio server entry point
  server.ts             # MCP server wiring
  controller/           # remember + recall controller
  providers/           # Provider adapters (OpenAI-compatible)
  retrieval/            # Lexical + semantic retrieval
    semantic/           # Production semantic retrieval (opt-in)
  storage/             # SQLite persistence
  safety/              # Input safety pre-check
  tools/               # MCP tool implementations
  config/              # Env reading, project config
  log/
  trace/
  prototype/           # Provider prototype runner (not production)
  benchmark/           # Retrieval benchmark harness (not production)
    variants/          # Benchmark-only ranker variants (FTS5, dense, hybrid)
tests/
  contracts.test.ts     # API contract tests
  mcp-stdio-e2e.test.ts # End-to-end stdio tests
  retrieval-*.test.ts   # Retrieval tests
  remember-*.test.ts   # Remember tests
```

## Benchmark and research

Deep retrieval benchmarking, abstention calibration, temporal/current-truth
experiments, and embedder candidate studies are documented in
[`src/benchmark/README.md`](src/benchmark/README.md).

## License

Licensed under the Apache License, Version 2.0. See LICENSE for details.
