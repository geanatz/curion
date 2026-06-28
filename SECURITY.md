# Security Policy

## Supported Versions

Only the latest minor release receives security updates. Older
minors are best-effort and depend on whether the fix can be
backported without breaking the frozen public API.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :x:                |

## Reporting a Vulnerability

Please **do not** file a public GitHub issue for security
vulnerabilities. Public disclosure before a fix is available makes it
easier for attackers to exploit the issue and harder for downstream
users to defend themselves.

Instead, email **geanatz@users.noreply.github.com** with:

- A clear description of the vulnerability and the impact you
  observed or anticipate.
- Reproduction steps: the smallest possible `remember` / `recall`
  invocation, the provider configuration (without real secrets —
  placeholder values are fine), and the Node.js version.
- An impact assessment: what can an attacker do, and under what
  conditions?
- Your name and how you would like to be credited in the
  advisory, if you want credit. Anonymous reports are also
  accepted.

**Expected response time: 7 days.** You will receive an
acknowledgement within seven days of your report and a status
update every seven days thereafter until the issue is closed.

If your report is accepted, a fix will be prepared for the
currently supported version and a CVE will be requested through the
appropriate channel. If your report is declined, we will explain
why.

## Known Security Considerations

These are properties of the project that affect the threat model.
They are not vulnerabilities; they are design choices that
operators should be aware of.

### MCP stdio transport

Curion only exposes the stdio transport. It does **not** open any
network sockets. The MCP host (the parent process that spawned
Curion) is responsible for all network communication, all
authentication, and all authorization. The trust boundary is the
parent process boundary.

- A malicious MCP host could send Curion any JSON-RPC payload it
  likes. Curion treats its inputs as untrusted: the input schema
  is strict (unknown top-level keys are rejected at the SDK
  boundary), the safety pre-check filters out harmful or
  off-policy input, and the controller validates everything
  before it touches storage.
- Curion never opens a TCP / UDP / Unix-domain server socket.
  There is no remote-network code path.
- The `.curion/` directory is the on-disk surface area; see
  "Path safety" below.

### No secrets in code

All real API keys come from the operator's environment
(`CURION_PRIMARY_API_KEY`, `CURION_FALLBACK_API_KEY`,
`CURION_PRIMARY_BASE_URL`, `CURION_PRIMARY_MODEL`,
`CURION_FALLBACK_BASE_URL`, `CURION_FALLBACK_MODEL`, etc.). The
shipped package contains only placeholder test values, and the
`tests/shared-test-provider.ts` module exposes obviously-fake
constants (`sk-test-primary-not-real-12345`,
`sk-test-fallback-not-real-12345`) so test code can never
accidentally embed a real key.

A repo-wide guard test (`tests/contracts.test.ts`) refuses any
key-shaped string in source or tests. CI runs that test on every
push.

### SQL injection safety

All SQLite queries go through `better-sqlite3`'s prepared
statement API with `?` placeholders. User input never reaches
the SQL string. This is enforced by code review (the only place
SQL is constructed is in `src/storage/storage.ts`) and by
the storage contract tests under `tests/`.

### Path safety

The `.curion/` directory is created in `process.cwd()` (or
`CURION_PROJECT_ROOT` if set). User input never reaches
`path.join` directly without operator-side configuration:

- The `text` parameter on `remember` / `recall` is treated as a
  pure string. It never becomes part of a file path.
- The cross-project registry is keyed on the absolute path of
  the project root, which is set by the operator (or by
  `process.cwd()` if the operator did not set one). Operators on
  a shared host should set `CURION_PROJECT_ROOT` explicitly.
- The `.curion/` directory is created with file mode `0700` so
  that other users on a shared host cannot read stored memory.
- Semantic-retrieval model files are written to
  `CURION_SEMANTIC_CACHE_DIR` (default: `<projectRoot>/.curion/transformers-cache/`)
  with the same `0700` permission.

### `.env` files are not loaded

Curion does **not** load `.env` files. All configuration must come
from the parent process's environment. This is intentional: it
removes a class of misconfiguration where a stray `.env` in the
working directory silently overrides the operator's settings and
can leak secrets through the file system.

### Structured output projection

The public `text` and `structuredContent` outputs for the two
tools are projected by `src/tools/recall-projection.ts` and
`src/tools/remember-projection.ts`. The projection strips:

- Raw input text.
- Memory ids.
- Model / provider metadata.
- Internal `Note:` prefixes and `message:` wrappers.

This keeps trace and provider internals from leaking into the
wire surface that the agent consumes.

## Recent Security Fixes

### 2026-06-28 — protobufjs CVE cluster (11 advisories)

The transitive dependency chain
`@xenova/transformers → onnxruntime-web → onnx-proto → protobufjs`
was vulnerable to arbitrary code execution in `protobufjs`. The
cluster includes:

- [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg)
  — arbitrary code execution in `protobufjs` (the umbrella
  advisory).
- [GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm)
  — code injection through `bytes` field defaults in generated
  `toObject` code.
- [GHSA-2pr8-phx7-x9h3](https://github.com/advisories/GHSA-2pr8-phx7-x9h3)
  — denial of service from crafted field names in generated
  code.
- [GHSA-fx83-v9x8-x52w](https://github.com/advisories/GHSA-fx83-v9x8-x52w)
  — prototype injection in generated message constructors.
- [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7)
  — code generation gadget after prototype pollution.
- [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg)
  — process-wide denial of service through unsafe option paths.
- [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q)
  — denial of service through unbounded protobuf recursion.
- [GHSA-q6x5-8v7m-xcrf](https://github.com/advisories/GHSA-q6x5-8v7m-xcrf)
  — overlong UTF-8 decoding in `protobufjs`.
- [GHSA-jggg-4jg4-v7c6](https://github.com/advisories/GHSA-jggg-4jg4-v7c6)
  — denial of service via unbounded recursive JSON descriptor
  expansion.
- [GHSA-f38q-mgvj-vph7](https://github.com/advisories/GHSA-f38q-mgvj-vph7)
  — schema-derived names can shadow runtime-significant
  properties.
- [GHSA-wcpc-wj8m-hjx6](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6)
  — denial of service through unbounded Any expansion during
  JSON conversion.

**Resolution.** Pinned `@xenova/transformers` to a version whose
transitive tree does not pull in the vulnerable `protobufjs`
versions. The 11 advisories are no longer reachable in the v0.2.0
dependency graph.

### 2026-06-28 — esbuild devDep advisory

[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) —
a Windows-only dev-server arbitrary file read in `esbuild`
0.27.3–0.28.0. This advisory only affects the dev environment on
Windows; it does not affect the production behaviour of Curion.

**Resolution.** Transitive bump to `esbuild` 0.28.1.
