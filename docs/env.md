# Environment variables

Cortex MCP v2 reads configuration from process.env only. **No API keys
are stored in the repository.** All keys are passed at process start
time by the operator (or a secrets manager).

## Variable reference

| Variable                         | Purpose                                                      | Required? | Default     |
|----------------------------------|--------------------------------------------------------------|-----------|-------------|
| `CORTEX_LOG_LEVEL`               | Minimum log level: `debug`, `info`, `warn`, `error`.         | No        | `info`      |
| `CORTEX_PROJECT_ROOT`            | Override the project root used to resolve `.cortex/`.        | No        | `process.cwd()` |
| `CORTEX_PROVIDER_PRIMARY_KEY`    | API key for the primary provider (MiniMax).                  | No*       | unset       |
| `MINIMAX_API_KEY`                | Alias for `CORTEX_PROVIDER_PRIMARY_KEY`.                     | No*       | unset       |
| `CORTEX_PROVIDER_FALLBACK_KEY`   | API key for the fallback provider (NVIDIA NIM).              | No*       | unset       |
| `NVIDIA_NIM_API_KEY`             | Alias for `CORTEX_PROVIDER_FALLBACK_KEY`.                    | No*       | unset       |
| `CORTEX_MINIMAX_BASE_URL`        | Override the MiniMax chat-completions base URL.               | No        | `https://api.minimax.io/v1` |
| `CORTEX_MINIMAX_MODEL`           | MiniMax model id used by the prototype runner.               | No        | `MiniMax-M3` |
| `CORTEX_NIM_BASE_URL`            | Override the NVIDIA NIM chat-completions base URL.           | No        | `https://integrate.api.nvidia.com/v1` |
| `CORTEX_NIM_MODELS`              | Comma-separated NIM model candidates for the prototype.      | No        | `openai/gpt-oss-120b,meta/llama-3.3-70b-instruct` |
| `CORTEX_PROTOTYPE_TIMEOUT_MS`    | Per-request timeout for the prototype HTTP client (ms).      | No        | `30000` |
| `CORTEX_PROTOTYPE_MAX_TOKENS`    | Per-request max output tokens for prototype HTTP calls.      | No        | `1024` |
| `CORTEX_NIM_FALLBACK_MODEL`      | NIM model id used as the production fallback by the provider adapter. | No        | `openai/gpt-oss-120b` |
| `CORTEX_ADAPTER_TIMEOUT_MS`      | Per-request timeout for the provider adapter HTTP client (ms). | No       | `30000` |
| `CORTEX_ADAPTER_MAX_TOKENS`      | Per-request max output tokens for the provider adapter.      | No        | `1024` |
| `GROQ_API_KEY`                   | API key for the Groq prototype candidate. Read only by the prototype runner, not the production adapter. | No        | unset |
| `CORTEX_GROQ_BASE_URL`           | Override the Groq chat-completions base URL (prototype runner only). | No        | `https://api.groq.com/openai/v1` |
| `CORTEX_GROQ_MODEL`              | Groq model id used by the prototype runner.                  | No        | `openai/gpt-oss-120b` |
| `CORTEX_GROQ_REASONING_EFFORT`   | Reasoning effort hint forwarded to Groq (e.g. `low`, `medium`, `high`). | No        | `high` |

*No key is required to run the Phase 1 skeleton. The provider
implementations detect missing configuration and return a stub
result with a `note` field rather than throwing.

## Example: running with no keys (skeleton mode)

```sh
npm run build
node dist/index.js
```

In this mode, `remember` returns a "not yet implemented" message and
`recall` returns `No relevant memory found.`. The provider registry
returns stub results explaining that no API key is configured. This
is the intended Phase 1 behavior.

## Example: running with a primary key

```sh
export CORTEX_PROVIDER_PRIMARY_KEY="<your-key-here>"
export CORTEX_LOG_LEVEL=debug
node dist/index.js
```

The skeleton does not yet make real HTTP calls; setting a key only
flips the `isConfigured()` flag on the provider. When real call
plumbing is added in a later phase, the same env vars will be used.

## Security notes

- Do not commit `.env` files. The repo's `.gitignore` already
  excludes `.env`, `.env.*`, `.env.local`, and `.env.*.local`. Only
  `.env.example` is committed, and it contains placeholders only.
- Do not paste real keys into issues, logs, or chat transcripts.
  The stderr logger is the only log surface; check that no client
  is forwarding stderr to a public sink.
- The safety fixtures corpus (`src/safety/fixtures.ts`) contains
  example key strings (e.g. AWS's published example key) on
  purpose, as test inputs. The CI test that scans for hardcoded
  keys explicitly excludes that file.
- The provider prototype runner (`src/prototype/runner.ts`) is a
  CLI, not the MCP stdio server. It writes a sanitized JSON report
  to `.cortex/prototype/`. Reports contain presence flags for keys,
  never the values; raw prompt/response bodies are truncated to a
  short redacted snippet; `Authorization: Bearer ...` strings are
  scrubbed from any error messages before they are persisted.

## Adding a new provider

1. Add a new class implementing `Provider` in `src/providers/`.
2. Wire it into `buildDefaultRegistry()` (or expose a different
   registry builder).
3. Read its key from a documented env var. Do not hardcode.
4. Add a `Provider` interface test that exercises the
   unconfigured path.

## Provider adapter defaults

The provider adapter (`src/providers/memory-analysis.ts`) is the
production path that wraps the HTTP client and prototype parser
behind a primary→fallback policy with a same-provider repair step.
It reads configuration directly from `process.env` (no `.env`
discovery in the stdio runtime). The fixed defaults are:

| Role     | Provider     | Model id                     | Base URL                                |
|----------|--------------|------------------------------|-----------------------------------------|
| Primary  | MiniMax      | `MiniMax-M3`                 | `https://api.minimax.io/v1`             |
| Fallback | NVIDIA NIM   | `openai/gpt-oss-120b`        | `https://integrate.api.nvidia.com/v1`   |

The third NIM candidate `meta/llama-3.3-70b-instruct` is
**not** the default fallback. It is exposed as
`CORTEX_NIM_FALLBACK_MODEL` for comparison runs only. The
adapter never silently switches fallbacks: an override of
`CORTEX_NIM_FALLBACK_MODEL` is the only way to point the
fallback at the comparison model.

The adapter never logs request bodies, response bodies, or
API key values. The HTTP client already enforces this; the
adapter additionally ensures the input `text` is never echoed
back in any returned field.
