# Privacy & storage

## Project-local memory

Curion runs in your project directory and remembers what your AI agent
learns across sessions — design decisions, architecture choices, team
conventions, and anything else you store via `remember(text)`. When you
ask via `recall(text)`, it retrieves relevant memories from your local
project store.

Curion is **not** a shared team memory. Each project has its own private
store. Memories are never sent to a shared backend — everything stays
local.

## Storage layout

```
<projectRoot>/.curion/
  curion.sqlite            # Memory store (gitignored)
  trace.sqlite             # Local trace DB (gitignored)
  transformers-cache/      # Embedder cache when semantic retrieval is on
  config.json              # Project config (e.g. { isPrivate: true })
```

The `.curion/` directory is created with mode `0700` on first use so
that other users on a shared host cannot read stored memory. The
`config.json` file is written with mode `0600`.

The memory database schema is additive and idempotent. **Raw input
text is never persisted** — only controller-normalized summaries and
metadata (kind, confidence, safety flags, timestamps).

## Cross-project semantic search

When semantic retrieval is enabled (`CURION_SEMANTIC_ENABLED=1`, see
[Configuration](configuration.md)), Curion may semantically search
external **non-private** projects alongside the local project.
**Private projects are never surfaced.**

To mark a project private, create `.curion/config.json` in the project
root:

```json
{ "version": 1, "isPrivate": true }
```

A private project is invisible to the cross-project recall system: no
memories, no labels, no hints. Missing file, malformed JSON, or missing
field all default to **non-private** (this is intentional: we do not
want to accidentally hide a project due to a corrupt config file).

When local recall returns `no_memory` and a non-private cross-project
match is strong enough to promote the outcome to `answered`, the
public `text` content block for that recall is prefixed with the
literal line `Based on cross-project memory:` and is followed by a
`---` separator and a `From other projects:` section listing the
contributing project summaries. Local-memory `answered` responses
do **not** carry that prefix, so the prefix is the only current
signal — visible in the displayed text, not on the wire — that a
cross-project promotion has occurred. The
`structuredContent.source` discriminator (`"local" | "cross_project"`)
is declared in `RECALL_STRUCTURED_CONTENT_SCHEMA` but is **not yet
populated** by `buildRecallStructuredContent`; clients must treat
it as a reserved field and must not switch on it. See
[API reference → Known limitations](reference.md#known-limitations).

## Semantic cache

When semantic retrieval is enabled, Curion uses an on-device embedder
(`Xenova/bge-small-en-v1.5` by default — 384-dim, quantized, ~25 MB).
The model is downloaded once from the Hugging Face CDN and cached at
`<projectRoot>/.curion/transformers-cache/` (override with
`CURION_SEMANTIC_CACHE_DIR`).

Set `CURION_SEMANTIC_ALLOW_REMOTE=0` to disable the CDN download — the
embedder will only load if the model is already in the local cache;
otherwise semantic retrieval gracefully falls back to lexical-only.

The embedder runs entirely on-device (CPU, no GPU). The cache directory
is created with mode `0700`.

## Local trace

Curion keeps a separate, local trace database (`.curion/trace.sqlite`)
that records a `run` + `input/output` event pair per public tool
invocation, plus internal retrieval diagnostics (lexical rankings,
selected candidates, superseded demotions).

**The trace is ON by default.** Set `CURION_TRACE_ENABLED=0` to disable
it; when disabled, the trace DB is never opened.

### Redaction

Trace payloads are redacted before write:

- **Raw input text** is never written to the trace. Only event metadata
  (kind, payload-shape fields) is recorded.
- **Sensitive keys** (`apiKey`, `token`, `authorization`, `password`,
  `secret`, etc.) are stripped from any structured payload before
  persistence. Reasoning blocks are redacted; `Note:` and `message:`
  wrappers are stripped.
- The redaction pattern set lives in
  `src/trace/trace-redaction.ts`; it is intentionally conservative
  (broad-stripping for ambiguous key names) and is enforced at the
  writer boundary, not by callers.

The trace is **internal** to Curion:

- It is **not** part of the public MCP surface.
- It is **not** surfaced to agents — agents never see trace rows.
- It lives entirely inside `.curion/`, is gitignored, and is never
  sent over the wire to anyone other than the local parent process.

The writer is best-effort / non-throwing — a trace write failure
never fails the public tool call.

## Security model

Curion's threat model is small and the trust boundary is the parent
process boundary.

- **MCP stdio transport only.** Curion does **not** open any network
  sockets. It does not accept inbound HTTP, WebSocket, or any other
  network connection. The MCP host (the parent process that spawned
  Curion) is responsible for all network communication, all
  authentication, and all authorization. A malicious MCP host can send
  Curion any JSON-RPC payload it likes — Curion treats its inputs as
  untrusted: the strict input schema rejects unknown top-level keys
  at the SDK boundary, the safety pre-check filters harmful or
  off-policy input, and the controller validates everything before it
  touches storage.
- **No secrets in code.** All real API keys come from the operator's
  environment. The shipped package contains only placeholder test
  values; `tests/shared-test-provider.ts` exposes obviously-fake
  constants so test code can never accidentally embed a real key.
  A repo-wide guard test (`tests/contracts.test.ts`) refuses any
  key-shaped string in source or tests.
- **SQL injection safety.** All SQLite queries go through
  `better-sqlite3`'s prepared statement API with `?` placeholders.
  User input never reaches the SQL string. This is enforced by code
  review and by the storage contract tests.
- **Path safety.** The `.curion/` directory is created at
  `process.cwd()` (or `CURION_PROJECT_ROOT` if set). User input
  (the `text` parameter on `remember` / `recall`) is treated as a
  pure string — it never becomes part of a file path. The cross-project
  registry is keyed on the absolute path of the project root, which is
  set by the operator (or by `process.cwd()`). Operators on a shared
  host should set `CURION_PROJECT_ROOT` explicitly.
- **`.env` files are not loaded by the server runtime.** Configuration
  must come from the parent process's environment. This removes a
  class of misconfiguration where a stray `.env` in the working
  directory silently overrides the operator's settings and can leak
  secrets through the file system. The `.env` loader is wired only
  into the prototype runner and benchmark harness.
- **Structured output projection.** The public `text` and
  `structuredContent` outputs for the two tools are projected by
  `src/tools/recall-projection.ts` and
  `src/tools/remember-projection.ts`. The projection strips raw input,
  memory ids, model / provider metadata, internal `Note:` prefixes,
  and `message:` wrappers. Trace and provider internals cannot leak
  into the wire surface.

For the recent dependency-graph security work (the `protobufjs` CVE
cluster and the `esbuild` dev-only advisory), see
[SECURITY.md](../SECURITY.md).

## Secrets and `.env` files

Curion does **not** load `.env` files at runtime. All configuration —
including API keys — is read from the environment of the parent process
(your MCP client, shell, or process manager). See
[Configuration](configuration.md) for the full list of environment
variables and [MCP client setup](mcp-clients.md) for client-specific
examples of how to pass them.

A repo-local `.env.example` template is shipped at the project root as
a reference; the actual `.env` file is gitignored and is **not** used
by the server runtime.

## What an operator should know

- **Do not commit `.curion/`.** It is gitignored by default. The
  memory store is project-local state, not source code.
- **Do not commit `.mcp.json` with `env` blocks containing real keys.**
  Commit only the structural entry (`command` / `args` / `type`); keep
  secrets in your shell environment, a secrets manager, or your
  client's per-server environment mechanism.
- **Do not redirect `curion` stdout.** Anything written to stdout
  corrupts the MCP protocol. If you wrap `curion`, redirect stderr
  only. See [Configuration → Logging](configuration.md#logging).
- **Treat `.curion/trace.sqlite` as project-local debug data.** It is
  redacted, internal, and gitignored; do not copy it across hosts
  without understanding what it contains. Turn it off with
  `CURION_TRACE_ENABLED=0` if you would rather have nothing local.
- **Mark sensitive projects private.** Add
  `.curion/config.json` with `{ "version": 1, "isPrivate": true }` to
  projects that must never appear in cross-project recall.