# Privacy & storage

## Project-local memory

Curion runs in your project directory and remembers what your AI agent
learns across sessions — design decisions, architecture choices, team
conventions, and anything else you store via `remember(text)`. When you
ask via `recall(text)`, it retrieves relevant memories from your local
project store.

Curion is **not** a shared team-memory service: each project stores memory
in its local SQLite database. However, when an external AI provider is
configured, Curion sends the content needed for analysis or synthesis to that
provider. "Stored locally" does **not** mean "never transmitted to a provider".
Optional semantic-model downloads also contact the model host. Only projects
explicitly marked `isPrivate: true` are hidden from cross-project recall.

## Storage layout

```
<projectRoot>/.curion/
  curion.sqlite            # Memory store (gitignored)
  trace.sqlite             # Local trace DB (gitignored)
  transformers-cache/      # Embedder cache when semantic retrieval is on
  config.json              # Project config (e.g. { isPrivate: true })
```

On Linux/macOS, new .curion/ directories are created with POSIX mode 0700
and sensitive files with mode 0600. On Windows, each **new** project or
home-registry .curion/ directory is staged, assigned a protected NTFS ACL
for the current user, SYSTEM and Administrators, then moved into place
before any Curion files are written. If ACL setup fails, Curion refuses
to create a new memory store or write config/registry data there.

**Existing Windows directories are not modified automatically.** Older
Curion stores may have inherited broad read access from their parent
folders; verify native NTFS ACLs before assuming they are private.
Existing data requires an explicit, reviewed, opt-in ACL migration. Windows
SYSTEM and Administrators retain access to newly created stores. Native Windows
CI verified the new-directory behavior with synthetic data, including a shared
parent directory; it did **not** verify or migrate older user stores. See
[the accepted Windows security decision](decisions/2026-11-13-release.md)
and [Issue #8](https://github.com/geanatz/curion/issues/8) for the
remaining legacy-folder follow-up.

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
do **not** carry that prefix, so the prefix is the human-visible
signal that a cross-project promotion has occurred.

For the stable machine-readable discriminator, the
`structuredContent.source` field is populated on
`recall.answered`: `"local"` when the answer was synthesized from
the current project's own memory (the default for an `answered`
outcome); `"cross_project"` when the outcome was promoted from
`no_memory` based on a strong non-private cross-project recall.
The field is omitted when the internal result does not set it and
is never set on `weak_match`, `no_memory`, `rejected`, or
`provider_error` (the field is only meaningful on `answered`).
Clients may safely switch on `structuredContent.source` to
distinguish a local-memory answer from a cross-project promotion
on `recall.answered`. See
[API reference → `structuredContent` — `recall`](reference.md#structuredcontent--recall).

## Semantic cache

When semantic retrieval is enabled, Curion uses an on-device embedder
(`Xenova/bge-small-en-v1.5` by default — 384-dim, quantized, ~25 MB).
The model is downloaded once from the Hugging Face CDN and cached at
`<projectRoot>/.curion/transformers-cache/` (override with
`CURION_SEMANTIC_CACHE_DIR`).

Set `CURION_SEMANTIC_ALLOW_REMOTE=0` to disable the CDN download — the
embedder will only load if the model is already in the local cache;
otherwise semantic retrieval gracefully falls back to lexical-only.

The embedder runs on-device (CPU, no GPU). The default cache lives under
the protected project-local `.curion/` directory. Operators must secure any
external directory selected with `CURION_SEMANTIC_CACHE_DIR`.

## Local trace

Curion can keep a separate local diagnostics database at
`.curion/trace.sqlite`. The trace is **disabled by default** and activates
only when `CURION_TRACE_ENABLED` is explicitly set to `1`, `true`, `yes`,
or `on`.

Enabled trace records use a closed metadata-only schema. They may contain
allowlisted run names, event kinds and statuses, timestamps, duration,
approved numeric counts, bounded enums, and schema version. They never
contain remember input, recall queries, memory or summary text, public
tool output, provider prompts or responses, synthesized answers,
arbitrary error prose, credentials, or unknown caller-supplied fields.
The writer independently projects allowlisted metadata before SQLite
serialization; privacy does not depend on redacting arbitrary payloads.
Existing trace tables remain for compatibility; new writes use the restricted
metadata schema.

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

- **MCP stdio transport only.** Curion does not expose an inbound HTTP
  or WebSocket server; external AI-provider requests and optional model
  downloads are **outbound** network operations. The MCP host controls
  who can invoke Curion and which environment settings it inherits;
  Curion authenticates its outbound AI-provider calls using those configured
  credentials. A malicious MCP host can send Curion arbitrary JSON-RPC
  payloads — Curion treats its inputs as
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

For security-reporting guidance and the supported version policy, see
[SECURITY.md](../SECURITY.md). Dependency risk changes by version; the
release audit is evidence for its run date, not a permanent guarantee.

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
  without understanding what it contains. Tracing is off by default;
  enable it only when needed with `CURION_TRACE_ENABLED=1`.
- **Mark sensitive projects private.** Add
  `.curion/config.json` with `{ "version": 1, "isPrivate": true }` to
  projects that must never appear in cross-project recall.
