/**
 * Conservative relationship-derivation helper.
 *
 * Phase A of the conflict / currentness metadata design.
 * This module is
 * intentionally a pure, deterministic, offline helper:
 *
 *   - No I/O. No storage reads or writes.
 *   - No provider calls.
 *   - No state transitions. Memories stay `active`.
 *   - No raw input. The function only ever inspects
 *     `SafeMemorySummary` fields (`id`, `summary`, `tags`,
 *     `classification`, `kind`, `state`, `confidence`).
 *   - No clock reads. The caller injects `asOf` so the
 *     `derivedAt` field is reproducible in tests.
 *   - No mutation of inputs. The candidate and `others` are
 *     treated as read-only.
 *
 * The function emits a small, bounded metadata block
 * (`conflictsWith`, `olderVariantsOf`, `detectionConfidence`,
 * `derivedSchemaVersion`, `derivedAt`) that downstream writers
 * (Phase B) may append to the existing `metadata` JSON blob on a
 * `memories` row. Phase A does not wire that append. The block is
 * also intended to be projected read-side (Phase B) into an
 * extension of `SafeMemorySummary` for tests and future
 * internal-only consumers.
 *
 * **Phase I additive extension.** The persisted block shape is
 * extended with three optional forward-looking keys
 * (`supersedes`, `supersededBy`, `resolvedAt`). The
 * `deriveRelationshipMetadata` pure helper does NOT populate
 * these — they are pass-through: a future caller can pass them
 * in on the `RelationshipMetadataFields` and the writer in
 * `buildPersistedMetadata` will copy them verbatim. The
 * conservative detector in this module continues to emit only
 * `conflictsWith` / `olderVariantsOf` /
 * `detectionConfidence` / `derivedSchemaVersion` / `derivedAt`,
 * and the schema version literal is bumped from `"ccm-draft-1"`
 * to `"ccm-draft-2"`. The old literal is preserved as
 * `LEGACY_DERIVED_SCHEMA_VERSION` for compatibility tests and
 * the read-side fallback in `listActiveMemoryRelationshipBlocks`.
 * No migration is required: old rows continue to project
 * cleanly with empty id arrays and `resolvedAt: 0`.
 *
 * Conservative thresholds from the spec (exported for tests):
 *
 *   - `CONFLICT_CONFIDENCE_THRESHOLD`  (τ  = 0.85)
 *     A opposing-claim + high-overlap signal must clear this to
 *     emit `conflictsWith`. Below it, the field stays empty.
 *
 *   - `OLDER_VARIANT_CONFIDENCE_THRESHOLD`  (τ' = 0.90)
 *     A near-paraphrase of an earlier-id summary must clear this
 *     to emit `olderVariantsOf`. Below it, the field stays empty.
 *
 *   - `MAX_RELATED_IDS`  (16)
 *     Hard cap on each emitted id array (per spec §6).
 *
 * The detector is intentionally a placeholder lexical heuristic
 * (spec §9.2 — "small, deterministic lexical overlap with a
 * conservative threshold, plus a shared-tag / opposing-claim
 * check"). The interface is the contract; the internals are
 * replaceable. The bar for emitting any downstream-visible
 * signal is intentionally high: default is silent.
 */

import type { SafeMemorySummary } from "../storage/storage.js";
import { tokenize } from "./lexical.js";

// ---------------------------------------------------------------------------
// Thresholds and bounds (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Conservative confidence threshold for emitting `conflictsWith`.
 * Exported so tests can pin the exact value. Not configurable
 * through any public API; future tuning must be a separate,
 * approved revision (spec §9.2).
 */
export const CONFLICT_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Conservative confidence threshold for emitting `olderVariantsOf`.
 * Higher than `CONFLICT_CONFIDENCE_THRESHOLD` on purpose: an
 * "older variant" claim needs near-paraphrase evidence, not just
 * topic similarity.
 */
export const OLDER_VARIANT_CONFIDENCE_THRESHOLD = 0.90;

/**
 * Maximum number of ids emitted in either `conflictsWith` or
 * `olderVariantsOf`. Per spec §6, both arrays are bounded to 16.
 */
export const MAX_RELATED_IDS = 16;

/**
 * Schema version literal for the derived relationship block.
 * Bumped on any shape change. The literal is part of the
 * contract; tests pin it.
 *
 * **Phase I bump.** The first version (`"ccm-draft-1"`) carried
 * the conservative detector output (Phase A). Phase I adds
 * three optional forward-looking keys (`supersedes`,
 * `supersededBy`, `resolvedAt`) to the block shape and bumps
 * the version to `"ccm-draft-2"`. The old literal is preserved
 * here as `LEGACY_DERIVED_SCHEMA_VERSION` for compatibility
 * tests and read-side fallbacks. Old rows written under
 * `"ccm-draft-1"` project cleanly through the Phase I reader:
 * empty arrays for the new id-list fields, `0` for
 * `resolvedAt`, the same safe defaults Phase B already uses
 * for missing fields. No migration is required.
 */
export const DERIVED_SCHEMA_VERSION = "ccm-draft-2" as const;

/**
 * Legacy schema version literal (Phase A → Phase H). New
 * writes use `DERIVED_SCHEMA_VERSION` (`"ccm-draft-2"`); old
 * rows written under this literal continue to project
 * cleanly. Exported for compatibility tests and the read-side
 * fallback in `listActiveMemoryRelationshipBlocks`.
 */
export const LEGACY_DERIVED_SCHEMA_VERSION = "ccm-draft-1" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to the derivation function. */
export interface RelationshipDerivationInput {
  /**
   * The candidate the controller is about to persist. The
   * function never mutates this object. Only safe fields are
   * inspected: `id`, `summary`, `tags`, `classification`,
   * `kind`, `state`, `confidence`.
   */
  candidate: SafeMemorySummary;
  /**
   * Other active summaries to compare against, in any order. The
   * function never mutates this array or its elements.
   */
  others: readonly SafeMemorySummary[];
  /**
   * Optional deterministic timestamp in ms epoch. When omitted
   * the function uses `0` so test output is byte-stable. In
   * production the controller is expected to pass
   * `Date.now()` here; the function itself never reads the
   * clock.
   */
  asOf?: number;
}

/** Bounded, append-only metadata block produced by derivation. */
export interface RelationshipMetadataFields {
  /** Ids of memories that may conflict with the candidate. */
  conflictsWith: number[];
  /** Ids of memories that look like older / paraphrased duplicates. */
  olderVariantsOf: number[];
  /**
   * Highest per-rule detector confidence used this call, in
   * `[0, 1]`. `0` when no rule fired.
   */
  detectionConfidence: number;
  /** Schema version of the derived block. */
  derivedSchemaVersion: typeof DERIVED_SCHEMA_VERSION;
  /**
   * Controller-supplied `asOf` (ms epoch). The function does not
   * read the wall clock itself; whatever the caller passed in
   * (or `0` if omitted) is echoed here verbatim. This is the
   * value that Phase B will write as `derivedAt` in the
   * persisted JSON blob (spec §6).
   */
  derivedAt: number;
  /**
   * Optional forward-looking key (spec §6.2, Phase I). When
   * present, the ids of memories this memory supersedes.
   * Phase I does not populate this field from a heuristic; it
   * is a pass-through: the value is whatever the caller
   * supplied (e.g. a future provider-side extraction or an
   * explicit controller command), and the writer copies it
   * onto the persisted block as-is. Absent in the first
   * version of the detector.
   */
  supersedes?: number[];
  /**
   * Optional forward-looking key (spec §6.2, Phase I). When
   * present, the ids of memories that supersede this memory.
   * Pass-through only; the detector does not derive it.
   */
  supersededBy?: number[];
  /**
   * Optional forward-looking key (spec §6.2, Phase I). When
   * present, the controller-supplied resolution timestamp
   * (ms epoch). Pass-through only; the detector does not
   * read or write it.
   */
  resolvedAt?: number;
}

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

/**
 * Derive a conservative relationship-metadata block for the
 * candidate against a list of other summaries.
 *
 * Properties:
 *   - **Pure.** No side effects, no I/O, no clock reads, no
 *     provider calls, no storage access.
 *   - **Deterministic.** For the same `(candidate, others,
 *     asOf)`, the output is byte-stable across calls. The
 *     `others` order does not affect the result, but the
 *     `id`-ordering inside emitted arrays is deterministic
 *     (ascending `id`).
 *   - **Non-mutating.** The candidate and `others` are never
 *     modified. Object.freeze is intentionally NOT called —
 *     the contract is "treat as read-only", not "freeze
 *     in place".
 *   - **Conservative.** Below-threshold signals are dropped
 *     silently. The default is no judgement.
 *   - **No raw text.** The function never references any
 *     "raw" / "input" / "text" field; only safe summary fields
 *     are read.
 *
 * Bounded output:
 *   - `conflictsWith`   : at most `MAX_RELATED_IDS` ids, ascending.
 *   - `olderVariantsOf` : at most `MAX_RELATED_IDS` ids, ascending.
 *   - `detectionConfidence` : in `[0, 1]`.
 *   - `derivedSchemaVersion` : literal `DERIVED_SCHEMA_VERSION`
 *     (`"ccm-draft-2"`, bumped in Phase I from `"ccm-draft-1"`).
 *   - `derivedAt` : the `asOf` value passed in, or `0`.
 *   - `supersedes` / `supersededBy` / `resolvedAt` are NOT
 *     populated by this function; they are pass-through fields
 *     on the input and are intended to be supplied by the
 *     caller (a future controller-side command or
 *     provider-driven extraction). The detector does not
 *     derive them.
 */
export function deriveRelationshipMetadata(
  input: RelationshipDerivationInput,
): RelationshipMetadataFields {
  const { candidate, others } = input;
  const asOf = typeof input.asOf === "number" && Number.isFinite(input.asOf)
    ? Math.trunc(input.asOf)
    : 0;

  // Defensive: a non-array `others` becomes an empty list. This
  // keeps the function total even if a future caller miswires
  // it; the type is `readonly` so a structural type bug would
  // be caught at the call site, but this also defends against
  // `null` / `undefined` slipping through `unknown`-typed
  // boundaries.
  const list = Array.isArray(others) ? others : [];

  const conflictsWith: number[] = [];
  const olderVariantsOf: number[] = [];
  let maxConfidence = 0;

  const candidateTokens = tokenize(candidate.summary);
  const candidateTags = normalizeTags(candidate.tags);

  for (const other of list) {
    if (!isSafeMemorySummary(other)) continue;
    if (other.id === candidate.id) continue;
    if (other.state !== "active") continue;

    // ---- conflictsWith: high-overlap AND opposing-claim signature ----
    const conflictSignal = scoreConflictSignal(
      candidate,
      candidateTokens,
      candidateTags,
      other,
    );
    if (
      conflictSignal !== null &&
      conflictSignal.confidence >= CONFLICT_CONFIDENCE_THRESHOLD
    ) {
      conflictsWith.push(other.id);
      if (conflictSignal.confidence > maxConfidence) {
        maxConfidence = conflictSignal.confidence;
      }
      if (conflictsWith.length >= MAX_RELATED_IDS) break;
    }
  }

  for (const other of list) {
    if (!isSafeMemorySummary(other)) continue;
    if (other.id === candidate.id) continue;
    if (other.state !== "active") continue;

    // ---- olderVariantsOf: near-paraphrase of an *earlier-id* summary ----
    // "Earlier" is defined as strictly lower `id`. Memories
    // with the same id are skipped (same record); memories
    // with a higher id are newer than the candidate and so
    // cannot be "older variants of" it.
    if (other.id >= candidate.id) continue;

    const olderSignal = scoreOlderVariantSignal(candidate, other);
    if (
      olderSignal !== null &&
      olderSignal.confidence >= OLDER_VARIANT_CONFIDENCE_THRESHOLD
    ) {
      olderVariantsOf.push(other.id);
      if (olderSignal.confidence > maxConfidence) {
        maxConfidence = olderSignal.confidence;
      }
      if (olderVariantsOf.length >= MAX_RELATED_IDS) break;
    }
  }

  // Deterministic ordering: ascending id. The loops above
  // walk `others` in the caller's order, so we sort here.
  conflictsWith.sort((a, b) => a - b);
  olderVariantsOf.sort((a, b) => a - b);

  return {
    conflictsWith,
    olderVariantsOf,
    detectionConfidence: clamp01(maxConfidence),
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: asOf,
  };
}

// ---------------------------------------------------------------------------
// Pure write-side helper
// ---------------------------------------------------------------------------

/**
 * The shape of a single `relationship` sub-object stored inside
 * the existing `metadata` JSON blob on a `memories` row. This is
 * the value spec §6 promises to append.
 *
 * Future-compatible: a future phase that needs a "resolved",
 * "supersession" or "history" lifecycle may add fields to this
 * shape and bump `derivedSchemaVersion`. The Phase I version
 * (`ccm-draft-2`) extends the Phase A shape (`ccm-draft-1`)
 * with three **optional** forward-looking keys: `supersedes`,
 * `supersededBy`, and `resolvedAt`. The writer in Phase I is a
 * **pass-through**: these fields are copied verbatim when the
 * caller supplies them and are absent (not set to `null` /
 * `[]` / `0`) otherwise. The detector does not populate them.
 * Legacy `"ccm-draft-1"` rows continue to project cleanly
 * through the read-side helper in
 * `listActiveMemoryRelationshipBlocks`; no migration is
 * required.
 */
export interface PersistedRelationshipBlock {
  /** Mirrors `RelationshipMetadataFields.derivedSchemaVersion`. */
  derivedSchemaVersion: typeof DERIVED_SCHEMA_VERSION;
  /** Controller-supplied `asOf` (ms epoch). */
  derivedAt: number;
  /** Ids that may conflict with this memory. */
  conflictsWith: number[];
  /** Ids of memories that look like older / paraphrased duplicates. */
  olderVariantsOf: number[];
  /** Max of per-rule confidences used; `0` when no rule fired. */
  detectionConfidence: number;
  /**
   * Optional forward-looking key (Phase I, pass-through). The
   * ids of memories this memory supersedes. Copied verbatim
   * from the caller-supplied `RelationshipMetadataFields` when
   * present; absent otherwise.
   */
  supersedes?: number[];
  /**
   * Optional forward-looking key (Phase I, pass-through). The
   * ids of memories that supersede this memory. Copied
   * verbatim when the caller supplies it; absent otherwise.
   */
  supersededBy?: number[];
  /**
   * Optional forward-looking key (Phase I, pass-through). The
   * controller-supplied resolution timestamp (ms epoch).
   * Copied verbatim when supplied; absent otherwise.
   */
  resolvedAt?: number;
}

/**
 * True when a derived block carries at least one meaningful
 * (non-empty) field. Used by the controller / helper to avoid
 * writing a noisy empty block onto every row (spec §5.1
 * "append only if there is actual relationship data").
 *
 * The forward-looking Phase I fields (`supersedes`,
 * `supersededBy`, `resolvedAt`) are **excluded** from this
 * check. They are pass-through: a row that the detector
 * considers "no relationship data" (empty `conflictsWith` and
 * `olderVariantsOf`) may still carry a Phase I block when the
 * caller supplies the new fields, and that is a valid write.
 * The detector-derived fields remain the gate for the
 * conservative "noisy empty block" rule; the Phase I fields
 * are appended only when explicitly supplied.
 */
export function hasMeaningfulRelationshipData(
  fields: RelationshipMetadataFields,
): boolean {
  return (
    fields.conflictsWith.length > 0 ||
    fields.olderVariantsOf.length > 0
  );
}

/**
 * Append the derived relationship block to an existing metadata
 * object. Pure, deterministic, non-mutating.
 *
 * Rules (spec §4.4 "Append-only integration"):
 *   - Existing keys are preserved verbatim. We never overwrite a
 *     `tags` / `entities` / `classification` / `providerFallbackUsed`
 *     / `llmRepairAttempts` / `parseStrategy` key.
 *   - If the derived block is empty (no `conflictsWith` and no
 *     `olderVariantsOf`), the existing metadata is returned
 *     unchanged — no noisy empty block is appended.
 *   - If the existing metadata already carries a `relationship`
 *     key, the helper does NOT silently merge or overwrite it.
 *     The pre-existing block is left in place; the new block is
 *     not written. This is the safe default for the first
 *     version and is future-compatible: a later phase that wants
 *     to re-derive on read can opt in explicitly.
 *   - If the existing metadata is not a plain object (e.g. a
 *     malformed JSON blob decoded to `null` / array / string),
 *     it is treated as `{}` and the derived block is written
 *     alongside `{}`'s other (empty) shape. This matches the
 *     read-side fallback in `listActiveMemorySummaries`.
 *
 * **Phase I pass-through rule.** The new optional fields
 * (`supersedes`, `supersededBy`, `resolvedAt`) are copied
 * verbatim onto the persisted block when the caller supplies
 * them. They are NOT derived by the detector, and they do NOT
 * affect the "append only if there is actual relationship
 * data" gate. A caller that wants a Phase I block must pass a
 * derived `RelationshipMetadataFields` with at least one of
 * the conservative detector fields (`conflictsWith` /
 * `olderVariantsOf`) non-empty; the Phase I fields are
 * appended alongside the conservative fields as-is. The
 * detector-derived fields remain the gate.
 *
 * The function never reads the wall clock; whatever
 * `derived.derivedAt` was passed in (typically `Date.now()` from
 * the controller seam) is what lands in the JSON.
 */
export function buildPersistedMetadata(
  existing: Readonly<Record<string, unknown>> | null | undefined,
  derived: RelationshipMetadataFields,
): Record<string, unknown> {
  // Defensive: treat any non-object existing metadata as `{}`.
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  // No-op on empty derived block: spec §5.1 calls for "append
  // only if there is actual relationship data". Avoid writing
  // `relationship: { conflictsWith: [], olderVariantsOf: [], ... }`
  // onto every row, which would be a noisy schema-level change
  // with no information value. The Phase I pass-through fields
  // are intentionally excluded from this check (see
  // `hasMeaningfulRelationshipData`).
  if (!hasMeaningfulRelationshipData(derived)) {
    return base;
  }

  // If a previous relationship block exists, leave it alone.
  // The first version is additive-only; a re-derivation policy
  // is explicit future work (spec §6.1).
  if (base.relationship !== undefined) {
    return base;
  }

  const block: PersistedRelationshipBlock = {
    derivedSchemaVersion: derived.derivedSchemaVersion,
    derivedAt: derived.derivedAt,
    conflictsWith: derived.conflictsWith.slice(),
    olderVariantsOf: derived.olderVariantsOf.slice(),
    detectionConfidence: derived.detectionConfidence,
  };

  // Phase I pass-through: copy the new optional fields
  // verbatim when the caller supplies them with at least
  // one valid entry. The detector does not derive these;
  // they are caller-supplied. Each field is written only
  // when the caller's `derived` carries a non-empty
  // filtered list of finite positive integers (for the id
  // lists) or a non-negative finite number (for the
  // timestamp). Non-finite / non-positive / non-integer
  // values are silently dropped. A field with zero valid
  // entries after filtering is treated as "caller did not
  // supply this field" and is not written onto the block
  // (the key stays absent). This matches the "absent in
  // the first version" semantics the optional type
  // documents, and it keeps the persisted JSON clean: a
  // row that the caller wrote with `supersedes: []` (or
  // `supersedes: [-1, 0]`) projects no `supersedes` key
  // at all, exactly as a row that the caller never
  // supplied the field.
  if (Array.isArray(derived.supersedes)) {
    const filtered = derived.supersedes
      .filter((x): x is number =>
        typeof x === "number" &&
        Number.isFinite(x) &&
        Number.isInteger(x) &&
        x > 0,
      )
      .slice(0, 16);
    if (filtered.length > 0) {
      block.supersedes = filtered;
    }
  }
  if (Array.isArray(derived.supersededBy)) {
    const filtered = derived.supersededBy
      .filter((x): x is number =>
        typeof x === "number" &&
        Number.isFinite(x) &&
        Number.isInteger(x) &&
        x > 0,
      )
      .slice(0, 16);
    if (filtered.length > 0) {
      block.supersededBy = filtered;
    }
  }
  if (
    typeof derived.resolvedAt === "number" &&
    Number.isFinite(derived.resolvedAt) &&
    derived.resolvedAt >= 0
  ) {
    block.resolvedAt = Math.trunc(derived.resolvedAt);
  }

  // Use a fresh object so the caller never sees in-place
  // mutation of the existing record.
  return { ...base, relationship: block };
}

// ---------------------------------------------------------------------------
// Internal signal scoring
// ---------------------------------------------------------------------------

interface ConflictSignal {
  confidence: number;
}

interface OlderVariantSignal {
  confidence: number;
}

const NEGATION_MARKERS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "isnt",
  "isn't",
  "wasnt",
  "wasn't",
  "werent",
  "weren't",
  "arent",
  "aren't",
  "dont",
  "don't",
  "doesnt",
  "doesn't",
  "didnt",
  "didn't",
  "cant",
  "can't",
  "cannot",
  "wont",
  "won't",
  "shouldnt",
  "shouldn't",
  "wouldnt",
  "wouldn't",
  "couldnt",
  "couldn't",
  "hadnt",
  "hadn't",
  "hasnt",
  "hasn't",
  "havent",
  "haven't",
  "none",
  "nor",
  "without",
]);

/**
 * Score a "conflict" signal between the candidate and a single
 * other summary.
 *
 * Returns `null` when the inputs are too weak to claim
 * opposition (e.g. low overlap, no opposing-claim signature,
 * candidate identical to other, or both share the exact same
 * set of negation markers — that last case is treated as
 * "agreeing on the negation", not opposing).
 *
 * The returned confidence is a heuristic in `[0, 1]`. The
 * caller gates on `CONFLICT_CONFIDENCE_THRESHOLD` (0.85), so
 * only a strong signal survives.
 *
 * Definition of the first-version rule (spec §4.2):
 *   - High lexical overlap between summaries (Jaccard >= 0.6).
 *   - The two summaries do NOT tokenize to identical multisets.
 *   - At least one contains a negation marker and the other
 *     does not (asymmetric negation), OR they share a non-empty
 *     tag set and disagree on a "polarity" tag (e.g. one has
 *     `deprecated`, the other has `current`).
 *   - No id or summary field leaks out; the function reads
 *     only safe summary fields.
 */
function scoreConflictSignal(
  candidate: SafeMemorySummary,
  candidateTokens: readonly string[],
  candidateTags: ReadonlySet<string>,
  other: SafeMemorySummary,
): ConflictSignal | null {
  const otherTokens = tokenize(other.summary);
  if (candidateTokens.length === 0 || otherTokens.length === 0) {
    return null;
  }

  // Polarity-tag disagreement can fire even on byte-identical
  // summaries: the same text tagged both "current" and
  // "deprecated" is an explicit conflict signal that must not
  // be silently dropped. Detect it first as a high-confidence
  // structural shortcut; this avoids the paraphrase-equal
  // short-circuit below swallowing it.
  const otherTags = normalizeTags(other.tags);
  const sharedTags = intersect(candidateTags, otherTags);
  const candPolarity = pickPolarityTag(candidateTags);
  const otherPolarity = pickPolarityTag(otherTags);
  const polarityDisagrees =
    candPolarity !== null &&
    otherPolarity !== null &&
    candPolarity !== otherPolarity &&
    sharedTags.size > 0;
  if (polarityDisagrees && candidate.summary === other.summary) {
    // Strong, structural signal that survives the
    // byte-identical short-circuit below. Emit at a high
    // confidence so it clears τ (0.85) cleanly.
    return { confidence: 0.95 };
  }

  // Identical-summaries case without polarity disagreement:
  // this is a paraphrase-equal, not a conflict. The
  // `olderVariantsOf` rule (with its tighter τ') is the right
  // place for that.
  if (candidate.summary === other.summary) return null;

  const overlap = jaccard(candidateTokens, otherTokens);
  if (overlap < 0.6) return null;

  const candHasNeg = hasNegationMarker(candidate.summary);
  const otherHasNeg = hasNegationMarker(other.summary);
  // Asymmetric negation: exactly one side negates.
  const asymmetricNegation =
    candHasNeg !== otherHasNeg && (candHasNeg || otherHasNeg);

  if (!asymmetricNegation && !polarityDisagrees) return null;

  // Combine: overlap contributes the base, the opposing-claim
  // signature contributes a small but fixed bump. The bump is
  // intentionally small enough that bare high overlap without
  // a real opposing-claim signature stays under τ.
  const base = overlap; // in [0.6, 1.0]
  const claimBump = asymmetricNegation ? 0.30 : 0.25;
  const confidence = Math.min(1, base + claimBump);
  return { confidence };
}

const POLARITY_TAGS: ReadonlyMap<string, "positive" | "negative"> = new Map([
  ["deprecated", "negative"],
  ["superseded", "negative"],
  ["invalidated", "negative"],
  ["obsolete", "negative"],
  ["outdated", "negative"],
  ["current", "positive"],
  ["active", "positive"],
  ["latest", "positive"],
]);

function pickPolarityTag(tags: ReadonlySet<string>): "positive" | "negative" | null {
  for (const t of tags) {
    const p = POLARITY_TAGS.get(t);
    if (p) return p;
  }
  return null;
}

/**
 * Score an "older variant" signal between the candidate and a
 * single other summary.
 *
 * Returns `null` when the inputs are too weak to claim an
 * older-variant relationship. The caller already enforces
 * `other.id < candidate.id`; this function does not re-check.
 *
 * Definition of the first-version rule (spec §4.2):
 *   - High Jaccard overlap (>= 0.85) between the two
 *     tokenised summaries, OR a "shared non-trivial content
 *     word set" with at least `OLD_PARAPHRASE_MIN_SHARED`
 *     shared content tokens AND identical sentence-level
 *     "shape" (token-length multiset is close).
 *   - Not byte-identical summaries (the controller layer is
 *     the right place to dedupe byte-identical inserts; this
 *     function is about *paraphrase* detection, not dedup).
 *   - Confidence combines overlap with a small paraphrase
 *     bonus, gated by `OLDER_VARIANT_CONFIDENCE_THRESHOLD`
 *     (0.90).
 */
function scoreOlderVariantSignal(
  candidate: SafeMemorySummary,
  other: SafeMemorySummary,
): OlderVariantSignal | null {
  const candidateTokens = tokenize(candidate.summary);
  const otherTokens = tokenize(other.summary);
  if (candidateTokens.length === 0 || otherTokens.length === 0) {
    return null;
  }
  if (candidate.summary === other.summary) return null;

  const overlap = jaccard(candidateTokens, otherTokens);
  // τ' is 0.90. The first-version rule requires high
  // paraphrase overlap. We use Jaccard for stability and let
  // the gate at the call site enforce the threshold.
  if (overlap < OLDER_VARIANT_CONFIDENCE_THRESHOLD) return null;

  // Paraphrase bonus: a longer shared span lifts confidence a
  // little, bounded at 0.99. This stays well below 1.0 so the
  // gate is meaningful.
  const sharedCount = intersectCount(candidateTokens, otherTokens);
  const bonus = Math.min(0.09, sharedCount * 0.01);
  return { confidence: Math.min(0.99, overlap + bonus) };
}

const OLD_PARAPHRASE_MIN_SHARED = 5;

// ---------------------------------------------------------------------------
// Small lexical helpers
// ---------------------------------------------------------------------------

/**
 * Jaccard overlap of two token lists, computed on token
 * *multisets* (so repeated words count). Returns a value in
 * `[0, 1]`.
 */
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, { a: number; b: number }>();
  for (const t of a) {
    const e = counts.get(t) ?? { a: 0, b: 0 };
    e.a += 1;
    counts.set(t, e);
  }
  for (const t of b) {
    const e = counts.get(t) ?? { a: 0, b: 0 };
    e.b += 1;
    counts.set(t, e);
  }
  let inter = 0;
  let union = 0;
  for (const { a: ca, b: cb } of counts.values()) {
    inter += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  if (union === 0) return 0;
  return inter / union;
}

function intersectCount(a: readonly string[], b: readonly string[]): number {
  const setB = new Set(b);
  let n = 0;
  const seen = new Set<string>();
  for (const t of a) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (setB.has(t)) n += 1;
  }
  return n;
}

function intersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>();
  for (const t of a) if (b.has(t)) out.add(t);
  return out;
}

function normalizeTags(tags: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const norm = t.toLowerCase();
    if (norm.length > 0) out.add(norm);
  }
  return out;
}

function hasNegationMarker(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  // Tokenize with a permissive split: include short tokens and
  // digits, since negation markers like "no" / "not" are 2-3
  // chars. We then filter the candidate tokens against the
  // marker set.
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (raw.length === 0) continue;
    if (NEGATION_MARKERS.has(raw)) return true;
  }
  return false;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Minimal structural check on an `unknown` value to confirm
 * it is a `SafeMemorySummary`-shaped object. Used as a
 * defensive boundary: this module is `pure`, but a future
 * caller might pass `others` typed as `readonly unknown[]` and
 * we want a quiet, deterministic skip on bad rows rather than
 * a thrown error.
 */
function isSafeMemorySummary(v: unknown): v is SafeMemorySummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isFinite(o.id)) return false;
  if (typeof o.summary !== "string") return false;
  if (typeof o.state !== "string") return false;
  if (!Array.isArray(o.tags)) return false;
  return true;
}
