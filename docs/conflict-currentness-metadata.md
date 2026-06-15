# Spec / Audit — Conservative Conflict & Currentness Metadata

Status: **Phase A, Phase B, Phase C, Phase D, Phase E, Phase G (validation-only), Phase H (detector helper), Phase I (internal metadata compatibility), and Phase J (public-note prefix flip) implemented. Public-message memory-id cleanup implemented on `experiment/public-message-hide-memory-ids` (no API/storage/state/behavior change beyond text cleanup). Phase F spec-only.**
Branches:
  - Spec:    `experiment/conservative-conflict-currentness-spec`
  - Phase A: `experiment/relationship-derivation-phase-a` (commit `c30e29e`) — pure helper, zero wiring.
  - Phase B: `experiment/relationship-metadata-write-phase-b` — controller-side append plumbing.
  - Phase C: `experiment/recall-ambiguity-internal-phase-c` — recall-side internal `internalAmbiguity` plumbing. **No public-message change.** The detector runs on the `answered` outcome; the public MCP `text` content block is byte-equal to pre-Phase-C in every status branch.
  - Phase D: `experiment/recall-ambiguity-public-phase-d` — public-message flag (spec §5.4). The tool layer's `formatAmbiguityNote` helper prefixes the public `message` of an `answered` outcome with a short, bounded, conservative note when the internal detector returns `kind: "ambiguous"`. When the detector returns `kind: "none"`, the public `message` is byte-equal to pre-Phase-D (the synthesized answer text only). The `no_memory` / `rejected` / `provider_error` outcomes are unchanged in every case. The `answer` field on the `answered` outcome is never modified. The note is **prose only** — no `#N` memory-id references, no `Sources: #...` segment, no "and N more" truncation. The detector's internal `memoryIds` array is preserved on the `AmbiguitySignal` for tests and any future structured-content transport, but is **not** serialized into the public MCP `text` content block. The `remember` saved message (`Saved memory (kind, confidence X.XX): summary`) and the controller's saved message (`saved (kind, confidence X.XX)`) likewise carry no id reference; the saved memory id is preserved on the structured `memoryId` / `record.id` field for tests and any future structured-content transport. See `experiment/public-message-hide-memory-ids` for the no-id cleanup. The note never echoes raw stored summaries, raw user query, or diagnostic substrings.
  - Phase E: `experiment/ambiguity-behavior-validation-phase-e` — **validation-only curated behavior tests + compact validation report.** No production code change. Twelve hand-curated scenarios in `tests/ambiguity-behavior-validation.test.ts` (backed by the test-local helper `tests/_helpers/ambiguity-behavior-scenarios.ts`) drive the existing Phase D code path and assert the expected vs actual public behavior, plus API drift and provider-call pins per status. A compact summary report is printed by the suite on success. One scenario (S6, clarified supersession / history-shaped case) is documented as a capability gap — Phase D does not infer resolved / current-truth semantics — and the suite records it as a `gap` verdict rather than a pass/fail.
  - Phase F: `experiment/resolved-history-semantics-phase-f` — **spec-only design proposal for resolved supersession / history semantics.** No code change. No schema change. No public API change. No `state` transition. The spec defines a new internal `kind: "resolved-history"` `AmbiguitySignal` variant and a history-shaped public note that fires only on explicit resolution markers (`replaced` / `previous` / `old` / `current` / `no longer` / `superseded`); recency is explicitly **not** sufficient. Older resolved memories stay `state = "active"` and remain retrievable. The Phase E S6 gap is **not** closed in Phase F; the spec defines what *would* close it behind the optional, separable follow-on phases G–J (validation cases first, then a pure helper/detector, then write/read metadata changes, then the public-note prefix flip). Documented in `docs/resolved-history-semantics-phase-f.md`.
  - Phase G: `experiment/resolved-history-validation-phase-g` — **validation-only curated scenario matrix for the Phase F spec's resolved-history contract.** No production code change. No schema change. No public API change. No `state` transition. No benchmark re-run. No provider-prompt change. The suite is `tests/resolved-history-validation.test.ts` backed by the test-local helper `tests/_helpers/resolved-history-validation-scenarios.ts`. It exercises the current controller through 10 curated scenarios (SG1–SG10) covering the explicit Render → Fly.io pair, the single-asymmetric-marker negative rule, the recency-only negative rule, the three-step Render → Fly.io → Railway timeline, the plain-history non-conflict path, the explicit-unresolved-conflict that Phase D must keep warning on, the `superseded` / `no longer` wording, the older-memories-stay-active retrievability invariant, the four-status union on the resolved-history path, and the public API / result key shape. The suite uses a **two-axis verdict model** (current-actual vs future-desired): every scenario is asserted against the current controller and the future-desired behaviour is recorded as a documented capability gap, not a failure. After Phase J landed, the report's `documentedCapabilityGaps` count is `0` and the `futureResolvedHistoryAchievedCount` is `4` (SG1, SG4, SG7, SG8 — all four scenarios that were future-resolved-history gaps or invariant-pins with future-resolved-history side-effects now resolve to the new `kind: "resolved-history"` verdict on the current implementation).
  - Phase H: `experiment/resolved-history-detector-phase-h` (commit `2c4151b`) — **pure resolved-history detector helper (zero wiring).** Adds the offline `detectResolvedHistory` pure helper in `src/retrieval/resolved-history.ts` plus the `SafeMemorySummaryRelationshipForwardCompatible` extension and `ResolvedHistorySignal` discriminated union. The detector runs as a pure module, accepts the forward-compatible relationship block (which the Phase I read-side projection now always supplies, with safe defaults for the new fields), and returns either `{ kind: "none" }` or `{ kind: "resolved-history", reason: "explicit-resolution", memoryIds, confidence, asOf }`. The detector does NOT call the provider, does NOT re-rank, does NOT transition `state`, and does NOT read raw text. It is NOT wired into the recall controller in this phase. The public `message` is **byte-equal to pre-Phase-H** in every status branch.
  - Phase I: `experiment/resolved-history-metadata-phase-i` — **internal metadata compatibility step (pass-through only).** Bumps the relationship-block schema version from `"ccm-draft-1"` to `"ccm-draft-2"`. Extends the `RelationshipMetadataFields` / `PersistedRelationshipBlock` shapes with three optional forward-looking keys (`supersedes`, `supersededBy`, `resolvedAt`) proposed in Phase F §6.2. The writer in `buildPersistedMetadata` copies the new keys verbatim when the caller supplies them; the conservative detector does NOT derive them. The read-side projection in `listActiveMemoryRelationshipBlocks` always projects safe defaults for the new fields (`[]` for the id lists, `0` for the timestamp). Legacy `"ccm-draft-1"` rows project cleanly through the Phase I reader with no migration. **No public behavior change, no public API change, no recall controller integration with the resolved-history detector, no public resolved-history note, no new AmbiguitySignal variant, no state transition, no storage schema migration (the new keys live inside the existing `metadata` JSON blob), no raw text, no remember/recall API signature change.** The detector remains pure and unwired. The Phase I test suite is `tests/resolved-history-metadata.test.ts` (24 tests pinning all of the above).
  - Phase J: `experiment/resolved-history-public-note-phase-j` — **public-note prefix flip (spec §8.4).** Wires the Phase H `detectResolvedHistory` detector into the recall controller's answered path as a **parallel** internal field (`internalResolvedHistory: ResolvedHistorySignal`, alongside the existing Phase D `internalAmbiguity: AmbiguitySignal` — the Architect recommended a parallel field rather than merging the new variant into `AmbiguitySignal` to keep the two detectors decoupled and independently replaceable). Adds the public-message note formatter `formatResolvedHistoryNote` to `src/retrieval/resolved-history.ts` and wires it into the tool layer's `formatOutcome` projection alongside the existing `formatAmbiguityNote`. The composition rule (spec §4.2 / §4.3) is: if the Phase D ambiguity detector fired, the ambiguity note is prefixed (the resolved-history note is NOT prefixed on the same outcome — a stored conflict pointer wins); else, if the Phase J resolved-history detector fired, the resolved-history note is prefixed; else, no note is prefixed and the public `message` is byte-equal to the synthesized answer. The new note's wording is the **exact approved prose string** `Note: I found earlier related information, but newer entries appear to supersede it.` (no `#N` memory-id reference, no `Sources: #...`, no "and N more"). The Phase J invariant (added by `experiment/public-message-hide-memory-ids`): the public `message` must not reintroduce `#N` memory-id references into the public text; the `formatResolvedHistoryNote` helper applies the same no-id-in-public-text contract `formatAmbiguityNote` applies; the detector's internal `memoryIds` array remains on `ResolvedHistorySignal`; the structured `sourceIds` field on `RecallResult` remains intact. **No schema change, no public API change, no `state` transition, no retrieval / ranking change, no new dependencies, no new tools, no raw text storage change, no remember/recall API signature change.** The Phase J wiring change is the *only* production code change in this commit beyond the formatter helper. The Phase G validation suite (10 scenarios) is updated to assert the new behavior: SG1, SG4, SG7 flip from `current-gap` to `pass` (the three future-resolved-history scenarios now resolve on the current implementation), and SG8 flips from `invariant-pin` with `expectedCurrent.warning === false` to `invariant-pin` with `expectedCurrent.warning === true` (the seeded rows trigger the resolved-history detector on the new implementation, which is correct behavior — the state-activation invariant is still the primary contract under test). The report's `documentedCapabilityGaps` count drops to `0` and the `futureResolvedHistoryAchievedCount` rises to `4`.
  Owner: Worker (implementation drafted by Worker; Phase C, Phase D, Phase E, Phase I, and Phase J approved by user; Phase H approved by user).

This document is a design proposal only. It must be approved before any
implementation work begins. The companion follow-on commit (Exp10,
`e33fdec`, branch `experiment/supersedes-promote-guard`) is a benchmark
probe; the design here is the conservative first step toward closing
the gap it identified, but it is **not** an implementation plan and
**not** a behaviour change.

---

## 1. Purpose & context (Exp10)

The Exp10 probe (`experiment/supersedes-promote-guard`,
commit `e33fdec`) was a benchmark-only diagnostic for the "injected
candidate supersedes-promote" risk. It produced two findings that
matter here:

- The **structural guard** (refuse to mark any candidate `superseded`
  when the superseder is itself an injected candidate) eliminates
  the regression it was designed to catch. This is a useful
  negative result and is now part of the discussion of any
  future state-transition design.
- Compared to Exp9 (`d222b1f`, candidate-generation probe), the
  Exp9 hit rate of **20/26 on `currentTruthAt1`** drops to
  **18/26** under the guard. The drop is concentrated on cases
  where Exp9's promoted "current" candidate was, on inspection,
  *not* a clean current-truth but a paraphrase-equal or
  semantically older variant of the real current fact.

The structural guard preserves correctness for unambiguous cases
but does not recover the Exp9-style wins, because the guard is
purely structural — it does not look at *content* or *time*. The
remaining gap is: when the system has more than one stored memory
that could answer a query, and they disagree, the production
recall path has **no internal signal** that they disagree, no
metadata describing that disagreement, and no policy for how the
public answer/message should reflect it.

This spec proposes the smallest possible first step that would let
the next diagnostic distinguish "the system is confidently correct"
from "the system picked one of several plausible answers without
knowing they conflict". It is **not** a re-ranker and **not** a
state-transition design.

---

## 2. Locked constraints (user decisions, do not change)

These are the decisions the user has already taken. The spec must
honour all of them and must not silently relax any of them.

1. **`recall` must flag ambiguity; it must not silently choose a
   current truth.** The current-truth decision must remain
   evidence-grounded or absent. If the system cannot ground a
   single answer with high confidence, the public answer / message
   must make that visible to the caller.
2. **Older / superseded memories must remain retrievable.** The
   MVP storage layer's `state` column already supports
   `active | superseded | invalidated`, and the public recall MVP
   reads from `WHERE state = 'active'`. In the first version
   proposed here, the system **does not introduce a state
   transition** (see §7). All memories stay `active` and
   retrievable. A memory being "older" is metadata, not a
   visibility decision.
3. **Conflict detection must be conservative.** If the detector
   cannot reach a high-confidence verdict, it must return
   "no judgement" rather than flag. The bar for emitting any
   downstream-visible signal is intentionally high; the
   default is silent.
4. **No raw text storage.** The schema has no raw-text column and
   must keep that property. The new metadata is derived from
   controller-normalized safe summaries, not from raw input.
5. **No public API change.** The two public tools (`remember`,
   `recall`) keep their single `text` parameter; the public
   message format is unchanged. Internal ambiguity signals may
   exist on test-only / internal-only result types, but must not
   leak into the public MCP `text` content block.
6. **No production behaviour change in this commit.** This spec
   does not authorise any code, schema migration, or storage
   migration. The first commit on the implementation branch must
   add a pure function plus tests, with no observable production
   effect on `remember` / `recall` output until a later
   approval-gated commit flips a behaviour gate.

---

## 3. Repo seams verified by audit

The audit confirms the following production seams are real and
match the user's framing. All file paths are relative to the repo
root.

### 3.1 `metadata` JSON on `memories`

- `src/storage/storage.ts` lines ~108 and ~116 already create the
  `metadata TEXT` column on the `memories` table (idempotent
  column-add in `ensureColumn`). It is the JSON-blob column the
  controller already writes to today.
- The write seam is in
  `src/controller/remember-controller.ts` line ~306. The current
  shape is:

  ```ts
  metadata: {
    tags,
    entities,
    classification: classification ?? null,
    providerFallbackUsed: result.fallbackUsed,
    llmRepairAttempts: result.llmRepairAttempts,
    ...(result.parseStrategy ? { parseStrategy: result.parseStrategy } : {}),
  }
  ```

  This is the natural place to **append** derived relationship
  fields. The spec does not propose moving or renaming existing
  keys.

- The read seam is in
  `src/storage/storage.ts` ~lines 388–404 (the metadata parse in
  `listActiveMemorySummaries`). It currently projects `tags` and
  `classification`. New fields can be projected alongside those
  without changing the SELECT column list, since `metadata` is
  already selected.

### 3.2 `state` column

- `src/storage/storage.ts` line 191 declares
  `MemoryState = "active" | "superseded" | "invalidated"`.
- Line ~111 adds the column with a default of `'active'`.
- Line 300 in the controller writes `state: "active"` for every
  record. There is no production path that writes
  `"superseded"` or `"invalidated"` today. The spec explicitly
  **does not** introduce a state-transition policy in the first
  version (§7).

### 3.3 `findRelatedMemories` placeholder seam

- `src/retrieval/seam.ts` exports `findRelatedMemories` with a
  stable interface: `(StorageHandle, RelatedMemoryQuery) =>
  { memories: RelatedMemory[]; reason: string }`. The MVP body
  returns `{ memories: [], reason: "no related memories in MVP
  slice" }`.
- The controller already calls it at
  `src/controller/remember-controller.ts` line ~227, *before* the
  provider call, and feeds the (currently empty) list into
  `analyzeMemoryWithFallback` as `relatedForProvider`. The seam
  is the natural home for the future **write-side** derivation
  step, because the candidate set the controller already needs
  for the provider prompt is exactly the candidate set that
  should be inspected for relationship metadata.

### 3.4 Recall path: internal-only ambiguity signal

- The recall controller
  (`src/controller/recall-controller.ts`) ends by returning a
  discriminated `RecallOutcome` union (lines ~67–76):

  ```ts
  type RecallOutcome =
    | { status: "answered"; answer: string; sourceIds: number[] }
    | { status: "no_memory" }
    | { status: "rejected"; reason; safetyClass }
    | { status: "provider_error"; reason };
  ```

- The tool layer (`src/tools/recall.ts`) formats this into a
  `RecallResult` (lines ~72–82) that is the only thing the public
  MCP `text` content block carries. The tool layer currently
  strips everything except the message / answer / sourceIds.
  Adding an internal `ambiguity?: AmbiguitySignal` to
  `RecallOutcome` is observable only to tests and any future
  structured-content transport; the public message is unchanged
  (per §2.5).

- Per-user-decision §2.1, the **public message** is the place the
  conservative flag eventually lands. The spec describes the
  intended message behaviour in §5.4 but does not authorise any
  change in this commit.

### 3.5 Docs / architecture contract is stable

- `docs/architecture.md` is the frozen v0.1 contract document
  (the "v0.1 contracts (frozen)" section lists the locked
  contracts, including "no raw original text persisted",
  "no knobs in the public API", "no public memory-id
  references", and the fixed `structuredContent` shape).
  This spec is consistent with those contracts; it does not
  require changing them. A small link to this spec is the only
  suggested doc edit (see §10).

---

## 4. Proposed write-side contract

### 4.1 New pure function: `deriveRelationshipMetadata`

- **Location:** `src/retrieval/relationship.ts` (new file). Pure
  module, no I/O, no provider, no storage handle.
- **Signature (draft):**

  ```ts
  export interface RelationshipDerivationInput {
    /** The candidate the controller is about to persist. */
    candidate: SafeMemorySummary;
    /** Other active summaries, in any order. */
    others: readonly SafeMemorySummary[];
    /** Optional deterministic timestamp; default = candidate.createdAt. */
    asOf?: number;
  }

  export interface RelationshipMetadataFields {
    /** IDs of memories that may conflict with this candidate. */
    conflictsWith: number[];
    /** IDs of memories that look like older / paraphrased duplicates. */
    olderVariantsOf: number[];
    /** Highest detector confidence in [0,1] emitted this call. */
    detectionConfidence: number;
    /** Schema version of the derived block. */
    derivedSchemaVersion: "ccm-draft-1";
  }

  export function deriveRelationshipMetadata(
    input: RelationshipDerivationInput,
  ): RelationshipMetadataFields;
  ```

- **Property:** deterministic for fixed inputs. No clock reads
  inside the function; the caller passes `asOf` so tests are
  reproducible.

### 4.2 What it does

- Inspects `candidate` against `others` and emits derived
  relationship fields. The draft rules are intentionally
  conservative:

  | Field            | First-version rule                                                                                                  |
  | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
  | `conflictsWith`  | Emitted only if two or more summaries share a *high-overlap, opposing-claim* signature AND detector confidence ≥ τ. The detector's τ is a constant, not a learned threshold, and starts at 0.85. Below τ, the field is empty. |
  | `olderVariantsOf`| Emitted only if a summary is a near-paraphrase of an *earlier-id* summary AND detector confidence ≥ τ'. The detector's τ' starts at 0.90 and only fires for explicit paraphrase-equal pairs, not for topic-similar ones. Below τ', the field is empty. |
  | `detectionConfidence` | The max of the per-rule confidences used. `0` when no rule fired.                                              |
  | `derivedSchemaVersion` | Literal `"ccm-draft-1"`. Bump on any field-shape change.                                                       |

- All numeric τ values are constants in
  `relationship.ts`, exported for tests. They are **not**
  configurable through the public API and **not** wired into
  any controller behaviour in this commit.

### 4.3 What it does **not** do (first version)

- Does not read or write storage.
- Does not call the provider.
- Does not transition `state`. All memories remain `active`.
- Does not hide, filter, or deprioritise older memories.
- Does not look at raw text. Inputs are `SafeMemorySummary`
  only; the function never sees the raw input.
- Does not block or replace an existing write. The candidate
  is written with the derived block appended; the
  write-path `state` is unchanged.

### 4.4 Append-only integration

- The write-side call site is a new helper, e.g.
  `buildPersistedMetadata(existing, derived)` in the same
  module, that **appends** the derived fields to the existing
  `metadata` JSON without overwriting any existing key. The
  controller's existing metadata-write line in
  `remember-controller.ts` (line ~306) is updated to call this
  helper. The change is local; no other metadata writer exists
  in the repo.

- If the existing metadata is malformed JSON, the helper
  treats it as `{}` and writes only the derived block. This
  matches the existing read-side fallback in
  `listActiveMemorySummaries` (line ~402).

---

## 5. Proposed recall-side contract

### 5.1 New pure function: `detectAmbiguity`

- **Location:** `src/retrieval/ambiguity.ts` (new file). Pure
  module, no I/O.
- **Signature (draft):**

  ```ts
  export interface AmbiguityInput {
    /** Ranked candidates the recall path actually used. */
    topCandidates: readonly SafeMemorySummary[];
    /** Synthesized answer text the provider returned. */
    answer: string;
    /** Optional deterministic timestamp. */
    asOf?: number;
  }

  export type AmbiguitySignal =
    | { kind: "none" }
    | { kind: "ambiguous"; reason: "conflicting-candidates"; memoryIds: number[]; confidence: number }
    | { kind: "ambiguous"; reason: "older-variant-suspected"; memoryIds: number[]; confidence: number };

  export function detectAmbiguity(input: AmbiguityInput): AmbiguitySignal;
  ```

- The function is conservative. It returns `{ kind: "none" }`
  whenever the detector is below its internal confidence
  threshold. The default is silent.

### 5.2 What the function inspects

- The **ranked top-K summaries** that the recall controller
  already passes to the synthesis provider, plus the
  **synthesized answer** the provider returned. It does not
  re-rank and does not re-call the provider.
- It looks only at controller-normalized safe summaries and at
  the validated answer text. It does not see the raw query.
- It uses the metadata block written by §4 (read-side
  projection) to inform its verdict: if two `topCandidates`
  carry `conflictsWith` pointing at each other in their stored
  metadata, and the synthesized answer matches one of them but
  not both, that is a high-confidence `conflicting-candidates`
  signal.

### 5.3 Internal-only plumbing

- `RecallOutcome` gains a non-public field, e.g.
  `internalAmbiguity?: AmbiguitySignal`. The `?` and the
  underscore-style naming are deliberate: the field is
  observable to tests, never to the public tool layer.
- `src/tools/recall.ts` is updated to drop the field from
  `RecallResult`. The public `message` and `answer` are
  unchanged in this commit.
- The MCP `text` content block remains exactly what it is
  today. The MVP test
  `tests/recall-mvp.test.ts` already pins this
  ("public message must not include diagnostic-style
  metadata", at the `out.answer` regex assertion, ~line 574);
  the new test below extends that pinning.

### 5.4 Public message / answer behaviour (Phase D, implemented)

The public `message` and `answer` reflect an ambiguity signal
as follows. Phase D is implemented on branch
`experiment/recall-ambiguity-public-phase-d`.

- `status: "answered"` with `internalAmbiguity.kind === "none"`.
  The public `message` and `answer` are byte-equal to
  pre-Phase-D: both are the synthesized answer text only.
  No note, no prefix, no extra characters.
- `status: "answered"` with `internalAmbiguity.kind === "ambiguous"`.
  The `answer` field is unchanged — it is still the
  synthesized answer text exactly as the provider returned
  it. The public `message` is the formatted note followed by
  a blank line and the synthesized answer, e.g.

  > "Note: stored memories on this topic disagree.
  >
  > The project uses Postgres 16 for the primary store."

  The note never claims a current truth and does not pick a
  winner between disagreeing candidates (per §2.1, "flag
  ambiguity rather than silently choose"). The
  `older-variant-suspected` reason uses a deliberately softer
  wording ("may include older variants") because the detector
  can only *suspect* a paraphrase relationship from the
  stored relationship block; it has not re-derived the
  paraphrase.

  The note is generated by the small, separately testable
  helper `formatAmbiguityNote` in
  `src/retrieval/ambiguity.ts`. It is bounded to
  `AMBIGUITY_NOTE_MAX_LENGTH` (240) characters. The public
  note is prose only — the internal `memoryIds` array is
  preserved on the `AmbiguitySignal` for tests and any
  future structured-content transport, but it is **not**
  serialized into the MCP `text` content block. The previous
  `Sources: #12, #17.` and `and N more` shapes were retired
  on the `experiment/public-message-hide-memory-ids` branch
  (see the §10 changelog).

- `status: "no_memory"`, `status: "rejected"`, and
  `status: "provider_error"` are unchanged in every case.
  The note is never prefixed in these branches.

- The `sourceIds` list is unchanged in every case. The
  system does **not** silently demote one of the disagreeing
  candidates — both IDs remain listed (decision §2.2). The
  ids are preserved on the structured `sourceIds` field of
  the tool-layer `RecallResult` for tests and any future
  structured-content transport; the public `message` itself
  does **not** carry the ids (see the §10 changelog).

- The public note never echoes raw stored summaries, raw
  user query, raw answer text, or diagnostic substrings
  (`detectionConfidence`, `derivedAt`,
  `derivedSchemaVersion`, `ccm-draft-1`, `conflictsWith`,
  `olderVariantsOf`, `internalAmbiguity`). The note is
  human prose only — it does **not** carry `#N`
  memory-id references, `Sources: #...`, or "and N more"
  truncation. The `answer` field on the same object is
  the synthesized answer text in full.

This message behaviour is what makes the conflict *visible*
to the caller, per user decision §2.1.

### 5.5 What the function does **not** do (first version)

- Does not re-rank.
- Does not call the provider.
- Does not write to storage.
- Does not transition `state`.
- Does not drop or filter any source id.
- Does not edit the `answer` text. The note is a *prefix on
  the public message* only.

---

## 6. Proposed metadata shape (draft)

Stored in the existing `metadata` JSON blob on `memories`.
Appended by the §4 helper. Existing keys (`tags`, `entities`,
`classification`, `providerFallbackUsed`, `llmRepairAttempts`,
`parseStrategy`) are preserved.

```jsonc
{
  // ... existing keys preserved verbatim ...

  "relationship": {
    "derivedSchemaVersion": "ccm-draft-1",
    "derivedAt": 1718000000000,        // ms epoch, controller-supplied
    "conflictsWith": [12, 17],          // memory ids; [] when none
    "olderVariantsOf": [8],             // memory ids; [] when none
    "detectionConfidence": 0.91         // max of per-rule confidences; 0 when none
  }
}
```

Field-by-field:

- `derivedSchemaVersion` — literal, bumped on shape change.
  Tests pin the literal `"ccm-draft-1"`.
- `derivedAt` — controller-supplied `Date.now()` at the moment
  of derivation. Not used for any decision in the first
  version; included so future revisions (state-transition,
  re-derivation policy) have a stable timestamp.
- `conflictsWith` — array of memory ids, max length 16.
  Empty when the detector did not fire.
- `olderVariantsOf` — array of memory ids, max length 16.
  Empty when the detector did not fire.
- `detectionConfidence` — number in `[0, 1]`. `0` when no rule
  fired. The public message uses the *raw* confidence number
  only for the internal `internalAmbiguity` field; the
  formatted note never exposes the number to the caller.

### 6.1 Out of scope (explicit)

- A new column for relationship data. The existing `metadata`
  blob is the storage; no schema change.
- A new state value. `state` stays `active` for every record
  written by this version.
- A "current_truth" flag. The system must not invent a current
  truth; it may only flag that it cannot pick one.
- Re-derivation policy. The first version writes the block
  once at insert time. A future revision may re-derive on
  read or on a periodic sweep, but that is a later design.
- Provider-driven relationship extraction. The detector is
  pure and offline; it does not call the provider. A future
  revision may add a provider-driven confirmation step, but
  that is a later design and must not be assumed here.
- Visibility of `detectionConfidence`, `derivedAt`, or any
  derived key in the public message. The note is human-
  readable prose only.

---

## 7. State / lifecycle policy (first version)

- All memories remain `state = "active"`.
- The controller continues to write `state: "active"` for
  every new record, exactly as it does today
  (`remember-controller.ts` line ~300).
- The `findRelatedMemories` seam, when the future real
  variant is wired in, must continue to return *all* active
  memories in its candidate set, including any that carry a
  `conflictsWith` or `olderVariantsOf` block. The seam does
  **not** filter on the new metadata in the first version.
- The `listActiveMemorySummaries` read function continues to
  return every active row, including rows that carry derived
  relationship fields. The derived fields are projected into
  the new `SafeMemorySummary` extension (see §8) for tests
  and internal callers; the public recall pipeline does not
  read them yet.
- A future revision may introduce a `state = "superseded"`
  transition **only** after the conservative detector is
  validated end-to-end and only behind an approval-gated
  commit. That is **not** part of this spec.

### 7.1 Lifecycle intent (pinned in Phase B)

- The relationship metadata is **additive**. It must remain
  compatible with later unresolved/resolved/supersession/
  history handling. The first version does not encode
  "conflict forever": a future `state = "superseded"` (or
  similar) transition is not coupled to the detector's
  output, and a "unresolved conflict" state must not block
  reads or rewrites of older memories. Older memories must
  remain retrievable regardless of whether they carry
  `conflictsWith` or `olderVariantsOf` blocks.
- The `derivedAt` timestamp is included specifically so
  future revisions (state-transition policy, re-derivation
  policy, supersession/history tracking) have a stable
  reference timestamp on each block. The first version never
  reads it for any decision.
- The `derivedSchemaVersion` literal is the only version
  pin. Any future field added to the `relationship` shape
  must bump the literal and update both the writer and the
  read-side projection, so older rows do not silently lose
  the new fields.

---

## 8. Test plan

All tests below are added on the implementation branch, after
this spec is approved. They are unit / contract tests only;
no integration with the live provider, no benchmark run, no
DB migration test.

### 8.1 Write-side

- `tests/relationship-derivation.test.ts`:
  - Empty candidate set → all derived fields empty /
    `detectionConfidence: 0`.
  - Two paraphrased older + one current → the older row's
    `olderVariantsOf` includes the newer row's id; the
    newer row's `olderVariantsOf` is empty.
  - Two summaries with opposing-claim signature → both rows'
    `conflictsWith` includes the other row's id.
  - Below-confidence inputs → all derived fields empty.
  - Determinism: same input + same `asOf` → byte-equal
    output. Run twice in the same test, assert deep-equal.
  - No raw input. Pass an object with a `rawInput` key;
    assert the output never references it.
  - `derivedSchemaVersion` is exactly `"ccm-draft-1"`.

### 8.2 Read-side projection

- Extend `tests/contracts.test.ts` (or add a sibling) to
  pin: `listActiveMemorySummaries` projects the new
  `relationship` block onto a typed extension of
  `SafeMemorySummary` when the column is present, and
  falls back to empty arrays / `0` confidence when the
  column is missing (forward-compat with old rows).
- Pin: a malformed `metadata` JSON in an existing row
  yields a row with empty `relationship` fields, not a
  throw.

### 8.3 Recall-side

- `tests/ambiguity-detection.test.ts`:
  - Single candidate → `{ kind: "none" }`.
  - Two candidates with mutual `conflictsWith` in stored
    metadata + answer matches only one → `{
    kind: "ambiguous", reason: "conflicting-candidates",
    memoryIds: [...], confidence: ... }`.
  - Below-confidence input → `{ kind: "none" }`.
  - Determinism: same input + same `asOf` → byte-equal
    output.

- Extend `tests/recall-mvp.test.ts` for the message-shape
  pins (the public `RecallResult.message` / `answer`
  contract lives there today, alongside the existing
  "public message must not include diagnostic-style
  metadata" assertion at ~line 574):
  - Pin: the public `RecallResult.message` / `answer` does
    not contain `derivedSchemaVersion`, `detectionConfidence`,
    or `derivedAt` substrings, in any status branch.
  - Pin: `sourceIds` is unchanged regardless of the
    detector's verdict.
  - Pin: `status` enum is unchanged (still
    `"answered" | "no_memory" | "rejected" |
    "provider_error"`).
  - Pin: when `status === "answered"` and the detector
    returns `kind: "none"`, the message is byte-equal to
    the current message for the same input (regression
    guard).
- `tests/contracts.test.ts` is reserved for the
  tool-surface / schema pins (the two public tools, the
  single `text` parameter, stderr-only logger, `.cortex/`
  resolution), not for the message-shape pins above.

### 8.4 Format helper

- `tests/format-ambiguity-note.test.ts`:
  - Bounded length (≤ 240 chars).
  - Contains both memory ids when present.
  - Never contains `detectionConfidence`, `derivedAt`, or
    `derivedSchemaVersion` substrings.
  - Empty / `kind: "none"` input returns the empty string.

### 8.5 Negative tests (must not regress)

- Existing `tests/recall-mvp.test.ts`,
  `tests/remember-mvp.test.ts`, and
  `tests/contracts.test.ts` must continue to pass without
  modification of their public-API assertions.
- Existing benchmark tests
  (`tests/supersedes-promote-guard.test.ts`, etc.) must
  continue to pass; this spec does not change the
  benchmark runner's contract.

---

## 9. Risks, unknowns, and approval gates

### 9.1 Risks

- **False confidence in the detector.** A high τ reduces
  false positives at the cost of false negatives. The
  conservative bar is the right default for a first version,
  but the Exp9 → Exp10 gap (20/26 → 18/26) shows that there
  is a recall cost to being silent. The spec accepts that
  cost explicitly; the first version is biased toward
  silence.
- **Schema drift.** `derivedSchemaVersion` is the only
  version pin. A future bump must update both the
  relationship module and the read-side projection, or
  older rows will silently lose the new fields. The pin is
  cheap; the discipline is human.
- **Storage growth.** The `metadata` blob grows by a
  bounded amount (max 16 ids in each array, one number,
  one literal, one timestamp). Negligible for the MVP
  scale; flagged here so a future migration is not a
  surprise.
- **Future state-transition coupling.** A later revision
  may want to use the `olderVariantsOf` block to drive
  `state = "superseded"`. The spec explicitly excludes
  that, but the field name leaves the door open. A future
  commit must not silently couple the two.

### 9.2 Unknowns

- The exact paraphrase detector for the first version is
  intentionally a placeholder (a small, deterministic
  lexical overlap with a conservative threshold, plus a
  shared-tag / opposing-claim check). The detector is
  replaceable; its interface is the contract. The
  detector's quality is a future work item, not a
  blocker for this spec.
- The threshold constants τ and τ' are starting
  suggestions, not measurements. They are exported for
  tests and may be tuned in a later revision behind the
  same approval gate as a public behaviour change.

### 9.3 Approval gates before implementation

Implementation may not begin until all of the following are
explicitly approved by the user:

1. The metadata shape in §6 (field names, types, and
   `derivedSchemaVersion` literal).
2. The detector confidence thresholds (τ, τ') as exported
   constants.
3. The "append, do not replace" rule for the write-side
   helper (§4.4).
4. The decision to *not* introduce a state transition in
   this version (§7).
5. The public-message behaviour described in §5.4, **or**
   an explicit decision to defer it to a separate approval
   gate.
6. The test plan in §8 (specifically the negative-test
   pins on the public API and the regression guard for
   `status: "answered"` with `kind: "none"`).

---

## 10. Recommended next implementation phase

After this spec is approved, the recommended commit sequence
on a new branch off the current `main` (or off
`experiment/supersedes-promote-guard` if the user prefers
keeping the diagnostic alongside the spec) is:

1. **Phase A — pure functions, zero wiring.**
   - Add `src/retrieval/relationship.ts` with
     `deriveRelationshipMetadata` and
     `buildPersistedMetadata`.
   - Add `src/retrieval/ambiguity.ts` with
     `detectAmbiguity` and `formatAmbiguityNote`.
   - Add the unit tests in §8.1, §8.3, §8.4.
   - Add the read-side projection in §8.2.
   - **No** controller call site, **no** schema change,
     **no** public-message change. Verify by running the
     existing `tests/recall-mvp.test.ts` and
     `tests/remember-mvp.test.ts` suites unchanged.

2. **Phase B — write-side wiring.**
   - Update the metadata-write call site in
     `remember-controller.ts` to call
     `buildPersistedMetadata(existing, derived)`.
   - Add the contract-test pin in §8.5.
   - Verify: the public `message` and `answer` are
     byte-equal to the pre-Phase-B output for the
     representative fixtures.

3. **Phase C — recall-side plumbing.**
   - Extend `RecallOutcome` with the internal
     `internalAmbiguity` field.
   - Wire `detectAmbiguity` into the recall controller
     **without** changing the public message.
   - Verify: §8.3 and §8.5 contract tests pass.

4. **Phase D — public-message flag (separate approval
   gate).** **Implemented on branch
   `experiment/recall-ambiguity-public-phase-d`.**
   - Implement §5.4 behaviour behind an explicit
     approval-gated commit.
   - Add the bounded-length / no-raw-confidence contract
     tests.
   - This is the only phase that changes the public
     message; it is the only phase that may regress the
     byte-equal-to-today property in §8.5. The Phase D
     implementation regresses the byte-equal-to-pre-Phase-D
     invariant *only* on the `answered` outcome when the
     internal detector returns `kind: "ambiguous"`. In
     every other case (`kind: "none"`, `no_memory`,
     `rejected`, `provider_error`) the public message is
     byte-equal to pre-Phase-D.

5. **Phase E — validation-only curated behavior tests
   (no production change).** **Implemented on branch
   `experiment/ambiguity-behavior-validation-phase-e`.**
   - Add a curated, hand-built scenario matrix covering
     the twelve behavior cases the spec calls out
     (stored mutual conflict, lexical asymmetric-negation
     safety-net, mutual older variants, one-way older
     variants, no ambiguity / byte-equal pre-Phase-D,
     clarified supersession / history-shaped case as a
     documented capability gap, older variants still
     plausible, and the four public statuses). Drive the
     existing Phase D code path. Assert expected vs
     actual public behavior. Pin the public
     `RecallResult` key set (API drift) and the
     provider-call count per status. Print a compact
     validation summary report.
   - This is a validation-only step. No production code
     is changed. The capability gap surfaced by the
     history-shaped scenario is recorded as a `gap`
     verdict, not a regression.
   - The originally-proposed benchmark re-run
     (research-only Exp10 follow-on) is *not* part of
     Phase E as implemented. It remains a separate,
     optional, approval-gated step; the spec retains the
     §10 entry only as historical reference.

A future, separate spec will cover any state-transition
design. It must not be co-authored with this one.

### 10.1 Suggested doc edits (separate, optional, this commit)

- In `docs/architecture.md`, add a one-line link under the
  v0.1 contracts section (now titled "v0.1 contracts (frozen)";
  previously "Phase 1 contracts (frozen)") pointing to this
  spec, e.g.
  `[conflict/currentness metadata design](conflict-currentness-metadata.md)`.
  No other doc edits in this commit.

### 10.2 Public-message memory-id cleanup (text-only revision)

**Branch:** `experiment/public-message-hide-memory-ids` (this
commit, off the `experiment/resolved-history-metadata-phase-i`
tip).

**Scope:** remove memory ids from the public/agent-facing
text messages emitted by `remember` and `recall`. Internal
ids and structured/internal fields remain intact:

- `remember` tool saved message: `Saved memory (kind,
  confidence X.XX): summary` — no `#N` id reference. The
  saved id is preserved on the `memoryId` structured field
  for tests and any future structured-content transport.
- `remember` controller saved message: `saved (kind,
  confidence X.XX)` — no `#N` id reference. The saved id
  is preserved on `record.id`.
- `recall` answered-ambiguous public `message`: the
  `formatAmbiguityNote` output is prose only — no
  `Sources: #...`, no `#N` tokens, no "and N more". The
  detector's internal `memoryIds` array is preserved on
  the `AmbiguitySignal`; the structured `sourceIds` field
  is preserved on `RecallResult`.
- `recall` no_memory / rejected / provider_error public
  messages: unchanged. They never carried id references.

**Not in scope:** no new tools, no knobs, no admin APIs.
No storage schema change. No state change. No
retrieval / ranking / provider behavior change. No raw
text storage change. The change is **text-only**.

**Regression pins:**
`tests/public-message-no-ids.test.ts` (10 cases pinning
the no-id public-text contract across all four
`remember` / `recall` statuses and the no-id / older-
variant ambiguous paths), plus updated pins in
`tests/format-ambiguity-note.test.ts`,
`tests/relationship-metadata-write.test.ts`,
`tests/recall-ambiguity-internal.test.ts`, and
`tests/resolved-history-validation.test.ts`.

**Phase J invariant:** Phase J is the only remaining
phase that may flip the public-note prefix. Phase J
**must not** reintroduce `#N` memory-id references into
the public `message`; the no-id form is the new
contract and is regression-pinned.

---

## 11. Open questions for the user

These are explicit deferrals. The spec is internally consistent
without them, but the answers will sharpen the next
implementation commit.

1. Should the first version's detector use a
   *lexical-overlap + shared-tag* heuristic, or should it
   require a provider-side confirmation step? The spec
   assumes the former (offline, deterministic, low cost).
2. Is the public-message behaviour in §5.4 approved as
   written, or should the first version emit the
   `internalAmbiguity` field for tests only and defer the
   message change to Phase D? The spec supports either.
3. Should `derivedAt` be removed (it has no consumer in
   v1) or kept for future-proofing? The spec keeps it.
4. Is there appetite for an opt-in env flag
   (`CORTEX_RELATIONSHIP_METADATA=off`) to disable the
   detector entirely? The spec does not propose one, but
   it would be cheap to add at Phase B.
