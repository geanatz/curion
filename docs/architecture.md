# Architecture (v0.1 candidate)

## Overview

Cortex MCP v2 is a project-local memory layer for AI agents. It
exposes a tiny MCP surface — two tools, one `text` parameter each
— and keeps all state inside a project-local `.cortex/`
directory. This document describes the v0.1 candidate
architecture, which is the state of the code on the current
branch (`experiment/fix-no-answer-report-flake`) and the
proposed merge to `main`. The project is still consolidating
experiments (provider adapter, retrieval benchmark, conflict /
currentness metadata, resolved-history lifecycle, public-text
id cleanup) ahead of a first tagged release. The public
surface is stable; the headline "what the system does" is
stable; the supporting modules (benchmark, prototype runner,
held-out validation, dense-embedder experiments) are
explicitly **benchmark-only** and are not wired into the
production `remember` / `recall` controllers.

```
┌────────────┐  stdio (JSON-RPC)  ┌────────────────────┐
│ MCP client │ ◀────────────────▶ │ cortex-mcp-v2      │
└────────────┘                    │  (McpServer)       │
                                   └────────┬───────────┘
                                            │
                            ┌───────────────┼─────────────────┐
                            ▼               ▼                 ▼
                   ┌──────────────┐ ┌──────────────┐  ┌──────────────────┐
                   │  logger.ts   │ │  storage.ts  │  │  providers/      │
                   │  (stderr)    │ │  (.cortex/,   │  │  memory-analysis │
                   │              │ │   sqlite)    │  │  (real adapter,  │
                   │              │ │              │  │   consumed by    │
                   │              │ │              │  │   remember       │
                   │              │ │              │  │   controller +   │
                   │              │ │              │  │   recall-        │
                   │              │ │              │  │   synthesis +    │
                   │              │ │              │  │   prototype      │
                   │              │ │              │  │   runner)        │
                   │              │ │              │  │  + http-client   │
                   │              │ │              │  │  + recall-       │
                   │              │ │              │  │    synthesis     │
                   │              │ │              │  │  + embedding     │
                   │              │ │              │  │    skeletons     │
                   └──────────────┘ └──────────────┘  └──────────────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │ controller/      │
                                   │  remember-       │
                                   │  controller.ts   │
                                   │  recall-         │
                                   │  controller.ts   │
                                   │  + safety        │
                                   │    precheck      │
                                   │  + retrieval/    │
                                   │    lexical       │
                                   │    (production)  │
                                   │  + retrieval/    │
                                   │    ambiguity     │
                                   │    (Phase C–E)   │
                                   │  + retrieval/    │
                                   │    resolved-     │
                                   │    history       │
                                   │    (Phase H–J)   │
                                   │  + retrieval/    │
                                   │    relationship  │
                                   │    (Phase A–B)   │
                                   └──────────────────┘
```

## Module boundaries

- `src/server.ts` — pure factory. Builds the McpServer,
  registers the two public tools (`remember`, `recall`) with
  their `inputSchema` (strict Zod v3 object) and
  `outputSchema` (clean discriminated shape), returns. No
  transport attached. The wire response carries both a `text`
  content block (calm prose) and a `structuredContent` payload
  (the discriminator-keyed shape).
- `src/index.ts` — stdio entrypoint. Wires the server to
  `StdioServerTransport`, initializes storage, handles
  SIGINT/SIGTERM. All log output goes to stderr.
- `src/tools/{remember,recall}.ts` — tool handlers. Each
  validates the public input (defense in depth on top of the
  SDK's `validateToolInput` path), invokes the controller, and
  projects the controller outcome through `formatOutcome` into
  the on-the-wire `text` block plus the `structuredContent`
  payload.
- `src/tools/{remember,recall}-projection.ts` and
  `src/tools/{remember,recall}-structured-content.ts` — the
  single-source-of-truth wire-format helpers. The Zod schemas
  exported from the structured-content modules are the
  `outputSchema` registered on each tool.
- `src/controller/remember-controller.ts` — the `remember`
  pipeline: safety pre-check, related-memory lookup seam
  (placeholder; empty for MVP), real provider adapter call
  (`analyzeMemoryWithFallback`), controller validation +
  normalization (length cap, secret redaction, raw-dump
  shape check, provider-kind mapping), confidence gate, and
  two-statement persistence (INSERT then narrow
  `relationship`-metadata patch via
  `updateMemoryMetadata`).
- `src/controller/recall-controller.ts` — the `recall`
  pipeline: safety pre-check, read safe stored summaries,
  read stored `relationship` blocks (Phase C),
  `rankLexical` over the safe summaries, short-circuit to
  `no_memory` when no candidate clears the relevance
  threshold, real provider synthesis call
  (`synthesizeRecallWithFallback`), answer validation
  (non-empty, bounded, secret-redacted, no raw-dump shape),
  Phase C ambiguity detection (internal field), Phase H
  resolved-history detection (internal field). The
  public-note composition lives in the tool layer's
  `formatOutcome` (`formatAmbiguityNote` and
  `formatResolvedHistoryNote`); the ambiguity note wins when
  both detectors fire.
- `src/logging/logger.ts` — the single logging path. Writes to
  stderr; levels gated by `CORTEX_LOG_LEVEL`.
- `src/storage/storage.ts` — `.cortex/` + SQLite. The
  `memories` table has no raw-text column. Schema migrations
  are additive and idempotent.
- `src/providers/memory-analysis.ts` — **real** provider
  adapter for structured memory-analysis calls. Owns the
  primary→fallback policy, a same-provider LLM repair attempt
  on parse failure, typed `AdapterSuccess` / `AdapterFailure`
  results, and env-driven config. The successful result
  exposes `llmRepairAttempts` and `parseStrategy`; the two
  are independent and are documented on the interface.
  **Consumed by the production MCP stdio server** via the
  `remember` controller (`runRememberController` calls
  `analyzeMemoryWithFallback` directly) and via the
  `recall` controller for synthesis
  (`synthesizeRecallWithFallback` in
  `src/providers/recall-synthesis.ts`). A separate
  **prototype runner** in `src/prototype/runner.ts` exercises
  the same adapter against MiniMax, NVIDIA NIM, and Groq
  (prototype-only comparison candidate) over a small set of
  P1..P6 memory-analysis fixtures.
- `src/providers/http-client.ts` — small OpenAI-compatible
  chat-completions HTTP client used by the adapter. Owns the
  `Authorization: Bearer ...` assembly, the per-request
  timeout (AbortController), and error classification. Returns
  sanitized `ProviderError` messages: the request's API key
  and common secret patterns (`Bearer <token>`, `sk-...`,
  `nvapi-...`, named JSON secret fields) are scrubbed from
  any server-derived or network-error message before it
  leaves the client.
- `src/providers/{types,minimax,nvidia-nim,provider-registry}.ts` —
  embedding-only `Provider` interface, two embedding
  skeletons (still placeholders), and a primary→fallback
  selector. The memory-analysis path does not go through
  these.
- `src/retrieval/lexical.ts` — the production lexical ranker
  (token overlap with a small exact-phrase boost).
  Production default: threshold 0.2, top-K 5. This is the
  baseline the retrieval benchmark measures and the ranker
  the `recall` controller drives.
- `src/retrieval/relationship.ts` — the pure
  relationship-metadata derivation helper (Phase A) and
  `buildPersistedMetadata` (Phase B) that the `remember`
  controller uses to append a typed `relationship` block
  (with `conflictsWith` / `olderVariantsOf` /
  `derivedSchemaVersion` / `derivedAt` /
  `detectionConfidence`) onto the persisted row's metadata.
  The conservative detector never populates the
  forward-compatible `supersedes` / `supersededBy` /
  `resolvedAt` keys (Phase I); the writer copies them through
  when supplied, the read-side projection always supplies
  safe defaults.
- `src/retrieval/ambiguity.ts` — the conservative offline
  ambiguity detector (Phase C) and `formatAmbiguityNote`
  public-note formatter (Phase D). The detector returns
  `{ kind: "none" }` or
  `{ kind: "ambiguous", reason, memoryIds, confidence }`.
  The note is short, bounded prose ("stored memories on this
  topic disagree." / "stored memories on this topic may
  include older variants.") with no `#N` memory-id
  reference, no `Sources: #...`, no "and N more" truncation.
- `src/retrieval/resolved-history.ts` — the conservative
  offline resolved-history detector (Phase H) and
  `formatResolvedHistoryNote` public-note formatter (Phase
  J). The detector fires only on an **explicit** resolution
  marker pair (`replaced` / `previous` / `old` / `current`
  / `no longer` / `superseded`); recency is explicitly **not**
  sufficient. The note's exact wording is
  `Note: I found earlier related information, but newer
  entries appear to supersede it.` and is stripped of its
  `Note:` prefix at the wire-projection boundary so the
  on-the-wire `text` block carries prose only.
- `src/retrieval/variants.ts` — five variant placeholders + a
  `runAllVariants` harness. **Benchmark-only** — never wired
  into the production `recall` controller or the public MCP
  API.
- `src/benchmark/` — retrieval benchmark harness: a
  hand-curated fixture corpus + query set, pure metric
  functions (rank1, current-truth@1, hit@1/3/5, no-answer
  TNR, per-family breakdown), and a CLI runner that exercises
  the production `rankLexical` function in-memory. No DB, no
  provider, no network. The harness is the reference point
  for future variants. The `src/benchmark/variants/`
  directory hosts the benchmark-only comparison points:
  `fts5.ts` (in-memory SQLite FTS5 with BM25), `vector.ts`
  (cosine similarity over a deterministic local
  hashed-bag-of-words embedding), `hybrid.ts` (Reciprocal
  Rank Fusion over lexical / FTS5 / vector),
  `dense-embedder.ts` (the pluggable real local
  dense-embedding backend: the
  `StubDeterministicDenseEmbedder` CI-friendly default, the
  `TransformersJsEmbedder` real local MiniLM / Xenova ONNX,
  the `Qwen3Embedder` real local Qwen3-Embedding-0.6B via
  `@huggingface/transformers` 3.x, the
  `EmbeddingGemmaEmbedder` real local EmbeddingGemma-300M
  via `@huggingface/transformers` 3.x, and the
  `BgeM3Embedder` real local BGE-M3 via
  `@huggingface/transformers` 3.x), `dense-vector.ts` (the
  async cosine-similarity ranker over a real local dense
  embedder), `qwen3-embedder.ts` (the Qwen3-specific
  embedder; sibling of the EmbeddingGemma and BGE-M3
  embedders), `embeddinggemma-embedder.ts` (the
  EmbeddingGemma-specific embedder; sibling of the Qwen3
  and BGE-M3 embedders), and `bge-m3-embedder.ts` (the
  BGE-M3-specific embedder; sibling of the Qwen3 and
  EmbeddingGemma embedders). All real backends are
  **benchmark-only**: they are not wired into the production
  `recall(text)` controller and the public MCP API is
  unchanged. Source-tree guards in the corresponding
  `tests/retrieval-*.test.ts` files enforce the
  "benchmark-only" contract. The Qwen3, EmbeddingGemma, and
  BGE-M3 embedders use the same library and structurally
  similar boilerplate, but are intentionally NOT refactored
  to share a base class in their current commits (the
  evidence-first comparison philosophy keeps the candidates
  independent); a future refactor can extract a shared base
  when the duplication is the right size to pay the
  abstraction cost.
- `src/benchmark/calibration.ts` — opt-in abstention /
  calibration experiment. Sweeps `threshold` / `margin` /
  `ratio` gates per variant, reports per-query score
  distributions and regression counts, and picks a "best"
  row per variant. Benchmark-only: never wired into the
  production `recall(text)` controller or the public MCP
  API.
- `src/benchmark/held-out-queries.ts`,
  `src/benchmark/held-out-validation.ts`,
  `src/benchmark/held-out-runner.ts` — opt-in held-out
  validation experiment. A NEWLY authored 28-query slice
  (`held-out-queries.ts`) is evaluated against the FROZEN
  multi-signal abstention policies (`BUILTIN_POLICIES` in
  `abstention-policy.ts`) and the same 132-record corpus the
  dev set targets. The held-out report
  (`retrieval-held-out-validation-*.json`) carries per-policy
  transfer deltas against the frozen dev-set baseline, the
  per-family positive abstention breakdown, and the
  per-query FP / FN lists. Benchmark-only: never wired into
  the production `recall(text)` controller or the public MCP
  API. The held-out set is a query-level prospective probe,
  not a corpus-level generalisation probe; the brief is
  explicit that the held-out policies are NOT re-tuned on
  the held-out results.
- `src/safety/fixtures.ts` — seven input classes the system
  must classify and gate: `secret`, `mixed-safe-sensitive`,
  `raw-dump`, `vague-junk`, `prompt-injection`,
  `unsafe-preference`, and `self-conflict`. The class
  taxonomy matches the `SafetyClass` union in
  `src/safety/precheck.ts` exactly.
- `src/config/env.ts` — env reading. No secrets in repo.

## v0.1 contracts (frozen)

- **Two public tools only:** `remember`, `recall`.
- **One public parameter per tool:** `text` (string, non-empty,
  required).
- **No knobs in the public API:** no kinds, states, filters,
  providers, debug, or storage arguments are accepted. Unknown
  top-level keys are rejected at the SDK boundary by the
  strict Zod v3 `inputSchema` (additionalProperties: false /
  equivalent strict-Union projection), and the handler-level
  defensive checks in `src/tools/{remember,recall}.ts`
  remain as defense in depth.
- **Stderr-only logging in stdio runtime.**
- **Project-local storage at `.cortex/`, gitignored.**
- **No raw original text persisted.** The `memories` table
  has no text column.
- **Provider keys come from env vars only.**
- **Wire response shape is fixed:** each tool returns both
  a `text` content block (calm human-readable prose) and a
  `structuredContent` payload (the user-approved clean
  discriminated shape, keyed by `status`). The
  `structuredContent` payload has **no `message` field**, **no
  memory id field** (`memoryId`, `sourceIds`, `memoryIds`),
  **no note `type` / `severity`**, and **no raw input** anywhere
  in the structured payload. The on-the-wire `text` block
  for `recall.answered` is the optional notes (without the
  `Note:` prefix) joined to the synthesized answer with a
  blank line; the notes are plain strings with no
  `Note:` prefix, no `type` / `severity`, and no `#N`
  memory-id reference.
- **Public text carries no memory-id references.** The
  on-the-wire `text` block for both tools and the
  `structuredContent.notes` array are prose only — no
  `#N` token, no `Sources: #...` segment, no "and N more"
  truncation, no `Note:` prefix on the wire. The internal id
  fields (`memoryId` on `RememberResult`, `sourceIds` on
  `RecallResult`, the detector's internal `memoryIds` arrays)
  remain intact for tests and any future structured-content
  transport; they are never serialized into the public
  message.

A conservative conflict/currentness metadata design
(spec-only, draft, no code change) is tracked at
[`conflict-currentness-metadata.md`](conflict-currentness-metadata.md).
The pure helper (Phase A), the write-side append plumbing
(Phase B), the recall-side internal `internalAmbiguity`
plumbing (Phase C), the public-message flag (Phase D), the
Phase E validation-only curated behavior tests, the Phase F
spec-only resolved-history design, the Phase G
validation-only resolved-history matrix, the Phase H pure
resolved-history detector helper, the Phase I internal
metadata compatibility step, and the **Phase J public-note
prefix flip** are all implemented on the current branch and
the accepted stack underneath it. The public-message flag is
wired in `src/tools/recall.ts` via the `formatAmbiguityNote`
helper in `src/retrieval/ambiguity.ts`: when the internal
detector returns `kind: "ambiguous"` on the `answered`
outcome, the public `message` is prefixed with a short,
bounded, conservative note. When the detector returns
`kind: "none"`, the public `message` is byte-equal to
pre-Phase-D. The `no_memory` / `rejected` /
`provider_error` outcomes are unchanged in every case. The
`answer` field is never modified in any branch. The public
note is **prose only** — no `#N` memory-id references, no
`Sources: #...`, no "and N more" truncation. The `remember`
saved message
(`Saved memory (kind, confidence X.XX): summary`) and the
controller's saved message
(`saved (kind, confidence X.XX)`) likewise carry no id
reference; the saved id is preserved on the structured
`memoryId` / `record.id` field for tests and any future
structured-content transport. The internal `memoryIds` array
on the `AmbiguitySignal` and the structured `sourceIds`
field on `RecallResult` remain intact.

Phase E adds a curated behavior-validation suite
(`tests/ambiguity-behavior-validation.test.ts` and
the test-local helper
`tests/_helpers/ambiguity-behavior-scenarios.ts`)
covering twelve scenarios: stored mutual conflicts,
lexical asymmetric-negation safety-net, mutual older
variants, one-way older variants, no ambiguity (byte-equal
pre-Phase-D), a clarified supersession / history-shaped
case (documented capability gap — Phase D does not infer
resolved / current-truth semantics), older variants still
plausible, and the four public statuses (`answered`,
`no_memory`, `rejected`, `provider_error`). The suite also
pins the public `RecallResult` key set and the provider
call count per status. A compact `formatReport`-style
summary is printed by the suite on success. Phase E is
validation-only; no production code was changed.

Phase F was a **spec-only** design proposal for the
resolved supersession / history gap that Phase E surfaced
as the S6 `gap` verdict. Phase F is documented at
[`resolved-history-semantics-phase-f.md`](resolved-history-semantics-phase-f.md).
Phase F added no code, no schema change, no public API
change, and no `state` transition. The spec defined a new
internal `kind: "resolved-history"` `AmbiguitySignal`
variant and a history-shaped public note that fires only
when an **explicit** resolution marker (`replaced` /
`previous` / `old` / `current` / `no longer` / `superseded`)
is present in the candidate set; recency is explicitly
**not** sufficient. Older resolved memories stay
`state = "active"` and remain retrievable. Phase F preserved
the Phase D public-message behaviour, the locked v0.1
contracts above, and the conservative spec in
[`conflict-currentness-metadata.md`](conflict-currentness-metadata.md)
verbatim.

Phase G was the first of the follow-on phases defined in
the Phase F spec §8.1: a **validation-only** curated
scenario matrix that pins the **contract** for the future
detector and verifies the **current invariants** the
detector must not regress. The suite lives in
`tests/resolved-history-validation.test.ts` backed by the
test-local helper
`tests/_helpers/resolved-history-validation-scenarios.ts`.
The matrix covers the explicit Render → Fly.io pair from
the user brief (SG1), the single-asymmetric-marker
negative rule (SG2), the recency-only negative rule
(SG3), the three-step Render → Fly.io → Railway timeline
(SG4), the plain-history non-conflict path (SG5), the
explicit-unresolved-conflict that Phase D must keep warning
on (SG6), the `superseded` / `no longer` wording (SG7),
the older-memories-stay-active retrievability invariant
(SG8), the four-status union on the resolved-history path
(SG9), and the public API / result key shape (SG10). The
suite uses a **two-axis verdict model** (current-actual vs
future-desired): every scenario is asserted against the
current controller and the future-desired behaviour is
recorded as a documented capability gap, not a failure.
The matrix counts
`future-resolved-history expected` (4 after Phase J: SG1,
SG4, SG7, SG8) and
`documented capability gaps` (0 after Phase J). Phase G
added no production code, no schema change, no public API
change, no `state` transition, no benchmark re-run, and no
provider-prompt change.

Phase H added a pure resolved-history detector helper
(`detectResolvedHistory` in
`src/retrieval/resolved-history.ts`) that runs offline on
the validated answer text and the relationship block the
read-side projection returns. The detector is unwired in
Phase H on its own: the recall controller did not import
it. The `ResolvedHistorySignal` discriminated union lives
only on test fixtures and the internal
`SafeMemorySummaryRelationshipForwardCompatible` shape.
Phase H accepts the optional Phase I forward-looking keys
(`supersedes`, `supersededBy`, `resolvedAt`) as read-only
Pattern B evidence but does not require them to be present.

Phase I was an **internal metadata compatibility step**.
It bumped the relationship-block schema version from
`"ccm-draft-1"` to `"ccm-draft-2"` and extended the block
shape with three optional forward-looking keys
(`supersedes`, `supersededBy`, `resolvedAt`) proposed in
Phase F §6.2. The writer in `buildPersistedMetadata` copies
the new keys verbatim when the caller supplies them; the
conservative detector does NOT derive them. The read-side
projection in `listActiveMemoryRelationshipBlocks` always
projects safe defaults for the new fields (`[]` arrays,
`0` timestamp), so legacy `"ccm-draft-1"` rows project
cleanly without migration. **No public behavior change, no
public API change, no recall controller integration with
the resolved-history detector, no public resolved-history
note, no new `AmbiguitySignal` variant, no state
transition, no storage schema migration** (the new keys
live inside the existing `metadata` JSON blob), **no raw
text, no remember/recall API signature change.** The
fields are pass-through / compatibility only — the
detector does not populate them.

**Phase J is implemented** on the current branch. It wires
the Phase H `detectResolvedHistory` detector into the
recall controller's answered path as a **parallel** internal
field (`internalResolvedHistory: ResolvedHistorySignal`,
alongside the existing Phase D
`internalAmbiguity: AmbiguitySignal` — the two detectors
are kept decoupled and independently replaceable). It adds
the public-message note formatter `formatResolvedHistoryNote`
to `src/retrieval/resolved-history.ts` and wires it into the
tool layer's `formatOutcome` projection alongside the
existing `formatAmbiguityNote`. The composition rule (spec
§4.2 / §4.3) is: if the Phase D ambiguity detector fired,
the ambiguity note is prefixed (the resolved-history note
is NOT prefixed on the same outcome — a stored conflict
pointer wins); else, if the Phase J resolved-history
detector fired, the resolved-history note is prefixed;
else, no note is prefixed and the public `message` is
byte-equal to the synthesized answer. The new note's
wording is the **exact approved prose string**
`Note: I found earlier related information, but newer
entries appear to supersede it.` (no `#N` memory-id
reference, no `Sources: #...`, no "and N more"). The
`Note:` prefix is stripped at the wire-projection
boundary, so the on-the-wire `text` block carries prose
only and the `structuredContent.notes` entry is the bare
sentence.

**Phase J invariant (added by
`experiment/public-message-hide-memory-ids`):** the public
`message` must not reintroduce `#N` memory-id references
into the public text. The `formatResolvedHistoryNote`
helper applies the same no-id-in-public-text contract
`formatAmbiguityNote` applies. The detector's internal
`memoryIds` array remains on the `ResolvedHistorySignal`;
the structured `sourceIds` field on `RecallResult` remains
intact. The `structuredContent` payload has no `message`
field, no memory-id field, and no note `type` / `severity`
— the public note surfaces as a plain string in
`structuredContent.notes` (without the `Note:` prefix) and
in the on-the-wire `text` block (also without the
`Note:` prefix). See spec §8.4 and
`docs/conflict-currentness-metadata.md` §10.2.

Phase clean-structured-tool-responses wired
`structuredContent` on both tool responses. Each tool
returns a per-status discriminated object keyed by
`status`. The `structuredContent` shape is locked by Zod
schemas exported from
`src/tools/{remember,recall}-structured-content.ts` and
registered as the tool's `outputSchema`. The shape:

- `recall.answered` — `{ status: "answered", answer, notes? }`
- `recall.no_memory` — `{ status: "no_memory" }`
- `recall.rejected` — `{ status: "rejected", reason }`
- `recall.provider_error` — `{ status: "provider_error", reason }`
- `remember.saved` — `{ status: "saved", summary, kind, confidence? }`
- `remember.rejected` — `{ status: "rejected", reason }`
- `remember.clarification_needed` — `{ status: "clarification_needed", question }`
- `remember.provider_error` — `{ status: "provider_error", reason }`

The `confidence` field is preserved on `saved` (it is the
only numeric field the provider-normalized save surface
exposes, and the public `text` block already names it).
The saved memory id is an internal storage handle and is
**not** part of the public `structuredContent` (it remains
on the controller's internal record for tests and any
future internal transport).

Phase strict-tool-input-schemas closed a gap in the SDK
input validation: the `inputSchema` is a strict Zod v3
object (`.strict()`) so any unknown top-level key is
rejected at the SDK boundary. The public `tools/list`
JSON schema advertises `additionalProperties: false` (or
the equivalent strict-Union projection) and the SDK's
`validateToolInput` returns a `CallToolResult` with
`isError: true` when the `arguments` payload includes
extra top-level keys, never invoking the handler.
Handler-level defensive checks in
`src/tools/{remember,recall}.ts` remain as defense in
depth.

## v0.1 status (do not overclaim)

The v0.1 candidate merges a real, locally usable MCP memory
server with a stable public surface (two tools, one `text`
parameter each, fixed `structuredContent` shapes, no
public memory-id references, no `Note:` prefix on the
wire, no public knobs) and a comprehensive test suite
pinning the contracts. The headline is conservative: the
public surface is stable and the end-to-end pipeline runs
locally, but the project is **not broadly
production-proven**. The supporting modules (benchmark
corpus / query set, dense-embedder comparison candidates,
held-out validation, abstention-audit / calibration /
paraphrase-recovery / temporal-ranking / supersession-edge
probes, prototype runner) are explicit benchmark-only
infrastructure and are not wired into the production
controllers or the public MCP API. The first tagged
release is the goal of the v0.1 candidate; broad
production readiness is not claimed.

## What is *not* in v0.1

- Migration from v1.
- MCP resources or prompts (only tools are exposed).
- Re-ranking beyond lexical (the dense-embedder and FTS5
  variants are benchmark-only).
- A state transition for resolved-history. Older resolved
  memories stay `state = "active"` and remain retrievable;
  the resolved-history detector surfaces a public note
  only.
- A public memory-id field. The structured id lists on
  `sourceIds` / `memoryId` / detector `memoryIds` remain
  internal; the public `text` and `structuredContent`
  payloads are prose only (no `#N`, no `Sources: #...`, no
  "and N more", no `Note:` prefix on the wire).
- A real public embedder integration. The embedding-only
  `Provider` interface in
  `src/providers/{minimax,nvidia-nim}.ts` is still
  stubbed; the memory-analysis path does not go through
  it.
- A new dependency on the public surface (no new
  third-party libraries).

These are intentionally deferred to a post-v0.1 follow-up.
