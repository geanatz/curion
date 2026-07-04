# Configuration

Curion is configured entirely through environment variables passed by the
parent process (your MCP client, shell, or process manager). Curion does
**not** load `.env` files — secrets must be passed by the parent process.

For client-specific wiring (where these env vars go in `.mcp.json`,
`config.toml`, etc.), see [MCP client setup](mcp-clients.md).

## Table of contents

- [Required: a primary provider](#required-a-primary-provider)
- [Optional: a fallback provider](#optional-a-fallback-provider)
- [Optional: semantic retrieval](#optional-semantic-retrieval)
- [Logging](#logging)
- [Local trace](#local-trace)
- [Per-request adapter knobs](#per-request-adapter-knobs)
- [Project root and `.curion/config.json`](#project-root-and-curionconfigjson)
- [Operator checklist](#operator-checklist)

---

## Required: a primary provider

Curion has **no built-in provider defaults**. You must configure at least a
primary provider to use `remember` and `recall`.

| Variable                  | Description |
|---------------------------|---|
| `CURION_PRIMARY_API_KEY`  | API key for the primary provider. |
| `CURION_PRIMARY_BASE_URL` | Base URL for the primary provider's endpoint. For OpenAI-compatible providers this is the base URL for `/chat/completions`. For Anthropic, this defaults to `https://api.anthropic.com` when `CURION_PRIMARY_API_FORMAT=anthropic` and is not set. |
| `CURION_PRIMARY_MODEL`    | Model id for the primary provider (e.g. `gpt-4o`, or any Anthropic model you have access to). |
| `CURION_PRIMARY_API_FORMAT` | API format: `openai-compatible` (default) or `anthropic`. Controls whether to use the OpenAI-compatible HTTP path or the official Anthropic SDK. |

Optional primary-provider knobs:

| Variable                          | Default           | Description |
|-----------------------------------|-------------------|---|
| `CURION_PRIMARY_PROVIDER_LABEL`   | auto-detected from base URL | Human-readable label used in logs. |
| `CURION_PRIMARY_STRICT_JSON`      | `false`           | Set to `true` to enforce stricter JSON-shape handling for the provider response. |

### Examples

OpenAI-compatible (default format):

```sh
export CURION_PRIMARY_API_KEY=sk-...
export CURION_PRIMARY_BASE_URL=https://api.openai.com/v1
export CURION_PRIMARY_MODEL=gpt-4o
```

Anthropic:

```sh
export CURION_PRIMARY_API_FORMAT=anthropic
export CURION_PRIMARY_API_KEY=sk-ant-...
export CURION_PRIMARY_MODEL=your-anthropic-model
```

---

## Optional: a fallback provider

The fallback slot is empty by default. To add one, mirror the primary
variables with the `CURION_FALLBACK_` prefix:

```sh
export CURION_FALLBACK_API_KEY=...
export CURION_FALLBACK_BASE_URL=https://api.example.com/v1
export CURION_FALLBACK_MODEL=your-model-id
export CURION_FALLBACK_API_FORMAT=openai-compatible   # or "anthropic"
```

Optional fallback knobs: `CURION_FALLBACK_PROVIDER_LABEL`,
`CURION_FALLBACK_STRICT_JSON`.

The fallback is engaged only when the primary provider call fails
(network error, 5xx, or auth/rejected-with-retryable-reason). It is not
a parallel ensemble.

---

## Optional: semantic retrieval

Semantic retrieval is **off by default**. When enabled, Curion runs both
lexical (token-overlap) and semantic (dense vector) retrieval, then fuses the
rankings. This recovers paraphrase matches that the lexical ranker misses.

Enable it with:

```sh
export CURION_SEMANTIC_ENABLED=1
```

| Variable                       | Default                              | Description |
|--------------------------------|--------------------------------------|---|
| `CURION_SEMANTIC_ENABLED`      | `0`                                  | Set to `1` to enable semantic retrieval. |
| `CURION_SEMANTIC_ALLOW_REMOTE` | `1`                                  | Set to `0` to disable Hugging Face CDN model download (requires the model to already be cached locally). |
| `CURION_SEMANTIC_CACHE_DIR`    | `<projectRoot>/.curion/transformers-cache/` | Local model cache directory. |
| `CURION_SEMANTIC_MODEL_ID`     | `Xenova/bge-small-en-v1.5`           | Embedder model id. |

The default embedder (`Xenova/bge-small-en-v1.5`, 384-dim, quantized,
~25 MB) runs entirely on-device (CPU, no GPU). First launch downloads the
ONNX model from Hugging Face CDN and caches it locally. If the embedder
fails to load (or remote download is disabled and the model is not cached),
Curion gracefully falls back to lexical-only — the core memory functions
remain fully available.

When semantic retrieval is enabled, Curion may also semantically search
**non-private** external projects. Mark a project private via
`.curion/config.json` — see
[Privacy & storage](privacy-storage.md#cross-project-semantic-search).

---

## Logging

| Variable          | Default | Description |
|-------------------|---------|---|
| `CURION_LOG_LEVEL`| `info`  | Minimum log level: `debug`, `info`, `warn`, `error`. |

Logs are written to **stderr** so they cannot corrupt the MCP protocol
stream on stdout. Set `CURION_LOG_LEVEL=debug` for verbose retrieval and
controller diagnostics. With `debug`, the recall-side retrieval logs
the candidate set, lexical scores, the ranker threshold, and the
synthesis-decision trace — useful for "I stored it but `recall` says
`no_memory`" investigations.

> **Never redirect or capture stdout.** Anything written to stdout
> corrupts the MCP JSON-RPC frame stream. If you need to suppress or
> capture logs, redirect stderr (`2>/dev/null`, `2>curion.log`, or the
> client's per-server stderr-capture hook), not stdout.

---

## Local trace

Curion keeps a separate, local trace database (`.curion/trace.sqlite`)
that records a `run` + `input/output` event pair per public tool
invocation, plus internal retrieval diagnostics (lexical rankings,
selected candidates, superseded demotions). The trace is **on** by
default. Trace payloads are redacted before write: raw input and
sensitive keys are stripped.

| Variable                | Default | Description |
|-------------------------|---------|---|
| `CURION_TRACE_ENABLED`  | `on`    | Set to `0`, `false`, `no`, or `off` to disable the trace writer. The DB is never opened when disabled. |

The trace writer itself does **not** auto-purge on startup. The default
retention window for the internal `purgeTraceRunsOlderThan` helper is
30 days; pruning is left to whatever external task or operator chooses
to invoke it. The trace DB lives entirely inside `.curion/` and is
gitignored.

The trace is **not** part of the public MCP surface. It is internal to
Curion, lives only inside the project's `.curion/`, and is never sent
over the wire to the agent. See
[Privacy & storage → Local trace](privacy-storage.md#local-trace) for
the full contract.

---

## Per-request adapter knobs

These knobs tune the provider adapter's HTTP behavior. They apply to
both primary and fallback providers in the same way.

| Variable                        | Default | Description |
|---------------------------------|---------|---|
| `CURION_ADAPTER_TIMEOUT_MS`     | `30000` | Per-request timeout in milliseconds for provider HTTP calls. |
| `CURION_ADAPTER_MAX_TOKENS`     | (see below) | Max output tokens for the memory-analysis / synthesis calls. When unset, each role falls back to its own default: `1024` for memory-analysis and `4096` for recall-synthesis. |

Lower `CURION_ADAPTER_TIMEOUT_MS` makes hung connections fail faster;
raise it if your provider is consistently slow. Raising
`CURION_ADAPTER_MAX_TOKENS` may improve synthesis quality at higher
cost; lowering it is a budget guardrail.

---

## Project root and `.curion/config.json`

By default, Curion creates and reads `.curion/` relative to
`process.cwd()`. On a shared host where the working directory is not
trustworthy, set the project root explicitly:

| Variable               | Default            | Description |
|------------------------|--------------------|---|
| `CURION_PROJECT_ROOT`  | `process.cwd()`    | Absolute path to the project root. `.curion/` is created and read inside this directory. |

The per-project config file lives at
`<projectRoot>/.curion/config.json`. The only recognized field is
`isPrivate`:

```json
{ "version": 1, "isPrivate": true }
```

A private project is invisible to the cross-project recall system — no
memories, no labels, no hints. Missing file, malformed JSON, or missing
field all default to **non-private** (this is intentional: we do not
want to accidentally hide a project due to a corrupt config file).

---

## Operator checklist

- [ ] Primary provider configured (`CURION_PRIMARY_API_KEY`,
      `CURION_PRIMARY_BASE_URL`, `CURION_PRIMARY_MODEL`, optional
      `CURION_PRIMARY_API_FORMAT`).
- [ ] (Optional) Fallback provider configured with the `CURION_FALLBACK_`
      prefix.
- [ ] (Optional) `CURION_SEMANTIC_ENABLED=1` for paraphrase recall.
- [ ] (Optional) `CURION_LOG_LEVEL=debug` during initial bring-up; drop
      back to `info` for steady state.
- [ ] (Optional) `CURION_TRACE_ENABLED=0` if you want zero on-disk trace
      activity.
- [ ] (Optional) `.curion/config.json` with `{ "isPrivate": true }` for
      projects that must never surface in cross-project recall.
- [ ] `.env` is **not** sufficient — secrets must come from the parent
      process's environment.

---

## `.env` files are loaded only by the prototype runner

The MCP stdio server runtime (`curion` invoked by your MCP client) does
not load `.env` files. The `dotenv`-style loader in
`src/config/env-loader.ts` is wired into the **prototype runner** (`npm
run prototype`) and the benchmark harness only — never into the MCP
server. A stray `.env` in the working directory will not override your
provider config when the server runs.