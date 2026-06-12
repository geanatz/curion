# Architecture (Phase 1 skeleton)

## Overview

Cortex MCP v2 is a project-local memory layer for AI agents. It
exposes a tiny MCP surface — two tools, one parameter each — and
keeps all state inside a project-local `.cortex/` directory.

```
┌────────────┐  stdio (JSON-RPC)  ┌────────────────────┐
│ MCP client │ ◀────────────────▶ │ cortex-mcp-v2      │
└────────────┘                    │  (McpServer)       │
                                   └────────┬───────────┘
                                            │
                           ┌────────────────┼─────────────────┐
                           ▼                ▼                 ▼
                   ┌──────────────┐ ┌──────────────┐  ┌──────────────────┐
                   │  logger.ts   │ │  storage.ts  │  │  providers/      │
                   │  (stderr)    │ │  (.cortex/,  │  │  memory-analysis │
                   │              │ │   sqlite)    │  │  (real adapter)  │
                   │              │ │              │  │  + http-client   │
                   │              │ │              │  │  + embedding     │
                   │              │ │              │  │  skeletons       │
                   └──────────────┘ └──────────────┘  └──────────────────┘
                           │
                           ▼
                   ┌──────────────┐
                   │ retrieval/   │
                   │ variants.ts  │
                   │  (skeleton)  │
                   └──────────────┘
```

## Module boundaries

- `src/server.ts` — pure factory. Builds the McpServer, registers
  the two public tools, returns. No transport attached.
- `src/index.ts` — stdio entrypoint. Wires the server to
  `StdioServerTransport`, initializes storage, handles SIGINT/SIGTERM.
- `src/tools/{remember,recall}.ts` — handlers. Pure functions of
  the validated input. No I/O in Phase 1 skeleton.
- `src/logging/logger.ts` — the single logging path. Writes to
  stderr; levels gated by `CORTEX_LOG_LEVEL`.
- `src/storage/storage.ts` — `.cortex/` + SQLite. Schema is
  intentionally minimal: no raw text column.
- `src/providers/memory-analysis.ts` — **real** provider adapter
  for structured memory-analysis calls. Owns the
  primary→fallback policy, a same-provider LLM repair attempt on
  parse failure, typed `AdapterSuccess` / `AdapterFailure` results,
  and env-driven config (`loadAdapterConfig`). Consumed by the
  prototype runner, not the MCP stdio server. The successful
  result exposes `llmRepairAttempts` (count of adapter-level
  provider round trips used to repair an unparsable response) and
  `parseStrategy` (the in-parser cleanup strategy); the two are
  independent and are documented on the interface.
- `src/providers/http-client.ts` — small OpenAI-compatible
  chat-completions HTTP client used by the adapter. Owns the
  `Authorization: Bearer ...` assembly, the per-request timeout
  (AbortController), and error classification. Returns sanitized
  `ProviderError` messages: the request's API key and common
  secret patterns (`Bearer <token>`, `sk-...`, `nvapi-...`, named
  JSON secret fields) are scrubbed from any server-derived or
  network-error message before it leaves the client.
- `src/providers/{types,minimax,nvidia-nim,provider-registry}.ts` —
  embedding-only `Provider` interface, two embedding skeletons
  (still placeholders), and a primary→fallback selector. The
  memory-analysis adapter does not go through these.
- `src/retrieval/variants.ts` — five variant placeholders + a
  `runAllVariants` harness.
- `src/retrieval/lexical.ts` — the current lexical ranker
  (token overlap with a small exact-phrase boost). Production
  default: threshold 0.2, top-K 5. This is the baseline the
  retrieval benchmark measures.
- `src/benchmark/` — retrieval benchmark harness: a hand-curated
  fixture corpus + query set, pure metric functions
  (rank1, current-truth@1, hit@1/3/5, no-answer TNR,
  per-family breakdown), and a CLI runner that exercises the
  production `rankLexical` function in-memory. No DB, no
  provider, no network. The harness is the reference point for
  future variants. The `src/benchmark/variants/` directory
  hosts the benchmark-only comparison points: `fts5.ts`
  (in-memory SQLite FTS5 with BM25), `vector.ts` (cosine
  similarity over a deterministic local hashed-bag-of-words
  embedding), and `hybrid.ts` (Reciprocal Rank Fusion over
  lexical / FTS5 / vector). All three are benchmark-only: they
  are not wired into the production `recall(text)` controller
  and the public MCP API is unchanged. Source-tree guards in
  the corresponding `tests/retrieval-*.test.ts` files enforce
  the "benchmark-only" contract.
- `src/benchmark/calibration.ts` — opt-in abstention / calibration
  experiment. Sweeps `threshold` / `margin` / `ratio` gates per
  variant, reports per-query score distributions and
  regression counts, and picks a "best" row per variant.
  Benchmark-only: never wired into the production `recall(text)`
  controller or the public MCP API.
- `src/safety/fixtures.ts` — seven input classes the system must
  classify and gate: `secret`, `mixed-safe-sensitive`, `raw-dump`,
  `vague-junk`, `prompt-injection`, `unsafe-preference`, and
  `self-conflict`. The class taxonomy matches the
  `SafetyClass` union in `src/safety/precheck.ts` exactly.
- `src/config/env.ts` — env reading. No secrets in repo.

## Phase 1 contracts (frozen)

- **Two public tools only:** `remember`, `recall`.
- **One public parameter per tool:** `text` (string, non-empty).
- **No knobs in the public API:** no kinds, states, filters,
  providers, debug, or storage arguments are accepted.
- **Stderr-only logging in stdio runtime.**
- **Project-local storage at `.cortex/`, gitignored.**
- **No raw original text persisted.** Schema has no text column.
- **Provider keys come from env vars only.**

## What is *not* in Phase 1

- A real `remember` that persists content.
- A real `recall` that consults any variant.
- A real provider HTTP call.
- Re-ranking, entity extraction, or temporal reweighting.
- MCP resources or prompts (only tools are exposed).
- Migration from v1.

These are intentionally deferred to later phases.
