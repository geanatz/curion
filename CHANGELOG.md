# Changelog

All notable changes to Curion will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-28

The first release of Curion as a stand-alone public project. This release
consolidates the v0.1.x "cortex" line under the new name, ships the
semantic-retrieval and multi-project-awareness features as opt-in, and
hardens the public MCP API surface. The public `text` and
`structuredContent` shapes for the two tools (`remember`, `recall`) are
frozen at this version.

### Added

- **Semantic retrieval foundation (opt-in).** FTS5-based candidate
  retrieval combined with a local dense-vector reranker. The default
  embedder is `Xenova/bge-small-en-v1.5` (384-dim, quantized, ~25 MB,
  CPU-only, Apache-2.0). First launch downloads the ONNX model from the
  Hugging Face CDN and caches it locally; subsequent runs are
  fully offline. Optional enrichment hooks are exposed for the
  benchmark harness. Enable with `CURION_SEMANTIC_ENABLED=1`.
- **Multi-project memory awareness.** A central registry at
  `~/.curion/registry.json` tracks every Curion project the operator
  touches. Cross-project semantic recall (when semantic retrieval is
  enabled) can surface non-private projects alongside the local one.
  Private projects are never surfaced. Mark a project private via
  `.curion/config.json` (`{ "version": 1, "isPrivate": true }`).
- **Anthropic provider adapter.** Provider-agnostic support for the
  Anthropic Messages API alongside the existing OpenAI-compatible
  path. Select with `CURION_PRIMARY_API_FORMAT=anthropic`. The
  `@anthropic-ai/sdk` package is now a direct runtime dependency.
- **Structured `clarification_needed` field in tool outputs.** When the
  controller is uncertain about user intent (on `rejected`,
  `no_memory`, and `weak_match` statuses), the `structuredContent`
  payload now carries a `clarification_needed: { question, suggestions? }`
  object. Agents must ask the user the `question` verbatim.
  `provider_error` never carries `clarification_needed`.
- **Cross-project semantic recall with private-project visibility.** A
  dedicated registry layer enforces that private projects are filtered
  out before any cross-project semantic query runs.
- **Diagnostic signals in the test suite.**
  - `c8` coverage reporting (`npm run test:coverage`) with text,
    text-summary, HTML, and lcov reporters; 95.57% statement coverage
    baseline recorded for v0.2.0.
  - Performance timing helpers in `tests/_helpers/timing.ts` using
    `node:perf_hooks` (monotonic `performance.now()`, median-bound
    assertions) and 7 critical-path timing tests under
    `tests/diagnostics/timing.test.ts`.
  - 9 property-based tests under `tests/diagnostics/properties.test.ts`
    using `fast-check`, covering controller / storage / projection
    invariants that hand-written unit tests miss.
- **Biome linter and formatter.** `biome.json` at the repo root with
  formatter and linter rules enabled. Scripts: `npm run lint`,
  `npm run lint:fix`, `npm run format`, `npm run format:check`.
  100-char line width, double quotes, semicolons, 2-space indent.
- **Dependabot configuration.** `.github/dependabot.yml` opens weekly
  grouped PRs for production and development dependencies.
- **CODEOWNERS file.** `.github/CODEOWNERS` assigns review
  responsibility for the whole repository (and the `src/` and `tests/`
  trees in particular) to the maintainer.
- **CI coverage job with artifact upload.** A new `coverage` job in
  `.github/workflows/ci.yml` runs after `build-and-test` and uploads
  the `coverage/` report as a build artifact (14-day retention).
- **Concurrency control on CI.** The CI workflow cancels in-progress
  runs when a new commit lands on the same PR, saving CI minutes.
- **Concurrency group for CI runs.** Runs are grouped by workflow and
  ref so that superseded commits do not consume build resources.

### Changed

- **Three-layer architecture enforced.** The codebase is organised
  into a strict controller / tool / projection split. The controller
  layer owns the domain logic; the tool layer owns the MCP wiring and
  user-input contract; the projection layer owns the public
  `text` / `structuredContent` shapes. Cross-layer imports are
  restricted by convention and reviewed in PR.
- **Strict TypeScript.** The following compiler flags are now enabled
  in addition to the base `strict: true`:
  - `noFallthroughCasesInSwitch`
  - `noImplicitOverride`
  - `noImplicitReturns`
  - `noUncheckedIndexedAccess`
  - `exactOptionalPropertyTypes`
- **Logger moved to stderr-only.** All log output is written to
  `process.stderr`. `process.stdout` is reserved exclusively for the
  JSON-RPC stream that the MCP host consumes. The `text` content
  block for the public tool outputs is the calm-prose form; logs are
  never interleaved with the MCP wire surface.
- **Memory record storage hardened.** SQLite is opened in WAL mode
  with foreign-key enforcement enabled. The `.curion/` directory is
  created with file permissions `0700` so that other users on a
  shared host cannot read stored memory.
- **Build target: ES2022 / NodeNext.** TypeScript compiles to
  `target: ES2022` with `module: NodeNext` and `moduleResolution:
  NodeNext`. The shipped package is `"type": "module"`.
- **Minimum Node.js: 22 (was 20).** The engines field requires Node
  22 LTS or newer. CI runs on the `ubuntu-latest` image with Node 22.
- **Environment variable names.** Legacy `CORTEX_*` environment
  variables are no longer read or accepted. Only `CURION_*` names are
  supported. Migration is a straight rename.
- **Public MCP API is stable and frozen.** The two tools, their
  single-`text`-parameter input schemas, and the public `text` /
  `structuredContent` surfaces for each status are now declared
  stable for the v0.2.x line. Backward-incompatible changes will
  require a major version bump.
- **Project renamed from `cortex` to `curion`.** The package name,
  the binary name, the config directory (`.cortex/` → `.curion/`),
  the environment-variable prefix (`CORTEX_` → `CURION_`), and the
  central registry (`~/.cortex/` → `~/.curion/`) all moved to
  `curion`.

### Deprecated

- Nothing in this release.

### Removed

- **Dead code removed.** ~3,500 lines of unused or unreachable code
  across the main engine and the test suite. Highlights:
  - Two provider skeletons with no importers
    (`src/providers/minimax.ts`, `src/providers/nvidia-nim.ts`).
  - Duplicate prefix-stripping logic in both `recall-projection.ts`
    and `remember-projection.ts`; consolidated into
    `src/tools/message-prefix.ts`.
  - Duplicate env-reading logic in
    `src/providers/memory-analysis.ts` and
    `src/providers/recall-synthesis.ts`; consolidated into
    `src/providers/env-helpers.ts` and a unified
    `loadRoleConfig` function.
  - Unused `_otherText` parameter on
    `scanForSupersessionPhrasing`.
  - Unreachable defensive check in `src/retrieval/ambiguity.ts`.
  - Unused `projectRoot` field on the `CurionEnv` interface and
    corresponding lines in `.env.example`.
- **Vestigial ESLint disable comments.** All `eslint-disable`,
  `eslint-disable-next-line`, and `eslint-enable` comments that
  predated the Biome migration were removed.

### Fixed

- **Hardened clarification-field and trace output.** The wire-surface
  trace layer was sanitised so the `text` content block can never
  leak memory ids, raw model output, or internal `Note:` prefixes.
- **Hardened public tool output shape.** The structured-content
  projection was simplified: no `message` field, no memory ids, no
  `Note:` prefix, no model / provider metadata, no raw input. Discriminate
  on `status`.
- **Strict tool input schemas.** The tool `inputSchema` is now a Zod v3
  object schema with `.strict()` so the MCP SDK's input validation
  rejects any unknown top-level key at the SDK / schema boundary
  (instead of silently stripping unknown keys).

### Security

- **protobufjs CVE cluster (11 GHSA advisories).** The transitive
  dependency chain `@xenova/transformers → onnxruntime-web →
  onnx-proto → protobufjs` was vulnerable to arbitrary code execution
  in `protobufjs`. The cluster includes GHSA-xq3m-2v4x-88gg plus 10
  related advisories (GHSA-66ff-xgx4-vchm, GHSA-2pr8-phx7-x9h3,
  GHSA-fx83-v9x8-x52w, GHSA-75px-5xx7-5xc7, GHSA-jvwf-75h9-cwgg,
  GHSA-685m-2w69-288q, GHSA-q6x5-8v7m-xcrf, GHSA-jggg-4jg4-v7c6,
  GHSA-f38q-mgvj-vph7, GHSA-wcpc-wj8m-hjx6). Resolved by pinning
  `@xenova/transformers` to a version whose transitive tree no longer
  pulls in the vulnerable `protobufjs` versions. See `SECURITY.md` for
  the full list and remediation notes.
- **esbuild devDep advisory (GHSA-g7r4-m6w7-qqqr).** A
  Windows-only dev-server arbitrary file read in `esbuild`
  0.27.3–0.28.0. Resolved by a transitive bump to `esbuild` 0.28.1.
  This advisory only affects the dev environment on Windows and does
  not affect production behaviour.
- **CI least-privilege.** The CI workflow now declares
  `permissions: contents: read` so the default `GITHUB_TOKEN` is
  scoped to the minimum necessary. No write scopes are requested.
- **Removed legacy `CORTEX_*` env vars.** See "Changed" above.
  Eliminating the legacy prefix removes a class of misconfiguration
  where an operator's shell accidentally points Curion at the wrong
  storage root.

### Test consolidation

- **Tier A — shared helpers.** A six-action, low-risk pass that
  extracted four shared helpers into `tests/_helpers/` and adopted
  one existing shared module across the test suite:
  - `tests/_helpers/test-storage.ts` — `mkStorage` / `rmStorage` for
    isolated storage handles (Action 3).
  - `tests/_helpers/env.ts` — `withCleanEnv` for test-scoped
    environment isolation (Action 5).
  - `tests/_helpers/provider-stub.ts` — `scriptFetch` /
    `okChatResponse` / `safeAnalysis` for fake provider adapters
    (Action 4).
  - `tests/_helpers/fs-walk.ts` — `walkTs` for recursive `.ts`
    discovery (Action 6).
  - `tests/shared-test-provider.ts` — standardised
    `TEST_PRIMARY_KEY` / `TEST_FALLBACK_KEY` / `TEST_PRIMARY_BASE_URL`
    / `TEST_PRIMARY_MODEL` / `TEST_FALLBACK_BASE_URL` /
    `TEST_FALLBACK_MODEL` constants; adopted by 18 test files
    (Actions 1 + 2).
  - All 1,672 tests pass, 12 skipped, 0 failing. Zero test behaviour
    changes.
- **Diagnostic signals.**
  - 7 critical-path timing tests asserting median-bound performance
    envelopes for the most important remember / recall operations.
  - 9 property-based tests using `fast-check` covering controller,
    storage, and projection invariants.
  - 95.57% statement coverage baseline recorded for the v0.2.0
    release; `npm run test:coverage` produces text, HTML, and lcov
    reports under `coverage/`.

## [0.1.0] - 2025-10-15

The initial release of the project (under the working name `cortex`).
Per-project SQLite memory store, lexical retrieval only (no semantic
retrieval, no dense embedder), two tools (`remember`, `recall`),
no semantic enrichment, no multi-project awareness. Lexical-only
match scoring on the controller. Provider adapter for a single
OpenAI-compatible endpoint.

[Unreleased]: https://github.com/geanatz/curion/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/geanatz/curion/releases/tag/v0.2.0
[0.1.0]: https://github.com/geanatz/curion/releases/tag/v0.1.0
