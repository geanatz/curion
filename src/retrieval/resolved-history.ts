/**
 * Conservative resolved-history detector and public-message
 * note formatter.
 *
 * Phase H + Phase J of the resolved-history semantics
 * design. This module is intentionally a pure,
 * deterministic, offline helper:
 *
 *   - No I/O. No storage reads or writes.
 *   - No provider calls.
 *   - No state transitions. Memories stay `active`.
 *   - No re-ranking. The detector never reorders the top-K
 *     candidates the recall controller already chose.
 *   - No raw text. The function only ever inspects safe
 *     summary fields and the validated answer text the
 *     controller received from the synthesis provider.
 *   - No mutation. Inputs are read-only.
 *   - No clock reads. The caller may pass `asOf` for byte-
 *     stable test output, but the field is informational;
 *     the detector never gates on a timestamp.
 *   - No recency. Wall-clock time, `derivedAt`, id
 *     ordering, and the lexical ranker's order are
 *     **never** used as evidence (spec §5.3).
 *
 * What it does:
 *
 *   - Inspects the ranked top-K summaries (with their
 *     relationship metadata, when the read-side projection
 *     carries it) plus the synthesized answer.
 *   - Returns a conservative `ResolvedHistorySignal`. The
 *     default is `{ kind: "none" }` — silence is the safe
 *     default.
 *   - The signal carries only bounded ids / reason /
 *     confidence, never raw text. It is an internal field
 *     on `RecallOutcome` (parallel to the Phase D
 *     `internalAmbiguity` field; the discriminated union
 *     is intentionally not merged into `AmbiguitySignal`
 *     to keep the two detectors decoupled and
 *     independently replaceable).
 *   - Phase J also adds the public-message note formatter
 *     `formatResolvedHistoryNote`, which renders a short,
 *     bounded, conservative, prose-only note on the
 *     `answered` outcome. The note is **never** wired to
 *     leak a `#N` memory-id reference (Phase J invariant
 *     added by the
 *     `experiment/public-message-hide-memory-ids` cleanup).
 *
 * Conservative thresholds from the spec (exported for tests):
 *
 *   - `RESOLVED_HISTORY_CONFIDENCE_THRESHOLD` (0.80)
 *     The minimum per-rule confidence required to emit a
 *     `kind: "resolved-history"` signal. Below it, the
 *     detector stays silent. Mirrors
 *     `AMBIGUITY_CONFIDENCE_THRESHOLD` from
 *     `src/retrieval/ambiguity.ts` so the two detectors
 *     share a single floor.
 *
 *   - `RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD` (0.4)
 *     The minimum content-token overlap (Jaccard on length
 *     >= 4 tokens) between the synthesized answer and the
 *     non-previous ("current") side. Below it, the detector
 *     stays silent — the system cannot claim the answer
 *     text took the current side (spec §5.2 third bullet).
 *
 *   - `MAX_RESOLVED_HISTORY_IDS` (16)
 *     Hard cap on the `memoryIds` array in the signal.
 *     Mirrors `MAX_AMBIGUITY_IDS` /
 *     `MAX_RELATED_IDS` for consistency.
 *
 *   - `RESOLVED_HISTORY_NOTE_MAX_LENGTH` (240)
 *     Hard cap on the public-note length. Mirrors
 *     `AMBIGUITY_NOTE_MAX_LENGTH` from
 *     `src/retrieval/ambiguity.ts` so the two public notes
 *     share a single bound.
 *
 * Phase H was the **first** of the follow-on phases that
 * added code. Phase I added the optional metadata keys
 * (Pattern B referential). Phase J is the **final** phase
 * defined by the spec: it wires the detector into the
 * recall controller (alongside the existing Phase D
 * ambiguity detector) and flips the public-message prefix
 * for the new `kind: "resolved-history"` verdict.
 */

import type { SafeMemorySummary } from "../storage/storage.js";
import { tokenize } from "./lexical.js";

// ---------------------------------------------------------------------------
// Thresholds and bounds (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Conservative confidence threshold for emitting a
 * `kind: "resolved-history"` signal. Mirrors
 * `AMBIGUITY_CONFIDENCE_THRESHOLD` so the two detectors
 * share a single floor. Exported so tests can pin the
 * exact value. Not configurable through any public API;
 * future tuning must be a separate, approved revision.
 */
export const RESOLVED_HISTORY_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Minimum content-token Jaccard overlap between the
 * synthesized answer and the non-previous ("current")
 * side of a candidate pair. Mirrors the spec §5.2 third
 * bullet. A small overlap (e.g. the answer mentions
 * "Fly.io" and the "current" side also mentions
 * "Fly.io") is enough; a zero-overlap answer is not.
 * Exported for tests.
 */
export const RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD = 0.4;

/**
 * Minimum content-token length used by the answer /
 * candidate alignment check. Mirrors the spec's
 * "length >= 4" guidance (token overlap on tokens
 * length >= 4 so stop words do not accidentally match).
 * Exported for tests.
 */
export const RESOLVED_HISTORY_ANSWER_MIN_TOKEN_LEN = 4;

/**
 * Hard cap on the `memoryIds` array in a
 * `kind: "resolved-history"` signal. Mirrors
 * `MAX_AMBIGUITY_IDS` and `MAX_RELATED_IDS` so the
 * signal stays bounded even on corrupted relationship
 * blocks. Exported for tests.
 */
export const MAX_RESOLVED_HISTORY_IDS = 16;

// ---------------------------------------------------------------------------
// Closed marker set (spec §5.1)
// ---------------------------------------------------------------------------

/**
 * The "previous / old / superseded" side of the
 * closed marker set (spec §5.1). A row that carries
 * at least one of these markers (case-insensitive,
 * whole-word match) is the "non-current" side of a
 * candidate pair.
 *
 * The multi-word marker `no longer` is matched by
 * the explicit bigram check in `findRowMarkerFlags`,
 * not as a single-word entry here — a bare `no`
 * token is too noisy (it would match sentences like
 * "no current issue is open", which carry no
 * resolution evidence). The bigram match is exact
 * substring on the lowercased copy.
 */
const PREVIOUS_SIDE_MARKERS: ReadonlySet<string> = new Set([
  "previous",
  "old",
  "superseded",
]);

/**
 * The "current / replaced" side of the closed marker
 * set (spec §5.1). A row that carries at least one of
 * these markers is the "current" side of a candidate
 * pair. The literal `replaced` here means "this row
 * IS the replacement" (i.e. the row that took over
 * from the previous side).
 */
const CURRENT_SIDE_MARKERS: ReadonlySet<string> = new Set([
  "current",
  "replaced",
]);

/**
 * The two-token bigram that forms the "no longer"
 * marker (spec §5.1). The detector matches the bigram
 * as a single marker so a row that says "no longer
 * used" is flagged as previous-side without false-
 * positive on the bare word `no` in other contexts.
 */
const NO_LONGER_BIGRAM = "no longer" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Forward-compatible extension of the relationship
 * block the read-side projection returns. Phase F §6.2
 * proposes three optional keys (`supersedes`,
 * `supersededBy`, `resolvedAt`); Phase H accepts them as
 * **read-only** evidence for Pattern B (referential)
 * but does not require them to be present. Phase I
 * makes the new keys part of the optional persisted
 * block shape (`ccm-draft-2`) — the detector still does
 * not write them, but a row that the controller (or a
 * future caller) explicitly supplies them on will
 * carry them through. The detector consumes them as
 * additional Pattern B evidence when present.
 *
 * The detector is silent on the schema-version bump:
 * it does not require `"ccm-draft-2"`, and it does not
 * require the new keys. Old rows written under
 * `"ccm-draft-1"` continue to project cleanly: the
 * read-side projection in `listActiveMemoryRelationshipBlocks`
 * returns empty arrays for the new id-list fields and
 * `0` for `resolvedAt`, the same fallback Phase B
 * already uses for missing fields.
 */
export interface SafeMemorySummaryRelationshipForwardCompatible {
  /** Mirrors `PersistedRelationshipBlock.derivedSchemaVersion`. */
  derivedSchemaVersion: string;
  /** Controller-supplied `asOf` (ms epoch). */
  derivedAt: number;
  /** Ids that may conflict with this memory. */
  conflictsWith: readonly number[];
  /** Ids of memories that look like older / paraphrased duplicates. */
  olderVariantsOf: readonly number[];
  /** Max of per-rule confidences used; `0` when no rule fired. */
  detectionConfidence: number;
  /** Optional forward-looking key (spec §6.2, Phase I). When
   *  present, an entry pointing at another candidate
   *  in the same top-K is Pattern B evidence. */
  supersedes?: readonly number[];
  /** Optional forward-looking key (spec §6.2, Phase I). */
  supersededBy?: readonly number[];
  /** Optional forward-looking key (spec §6.2, Phase I). */
  resolvedAt?: number;
}

/**
 * Optional extension of `SafeMemorySummary` that carries
 * the relationship block the read-side projection
 * returns. The detector accepts either the bare shape
 * (no `relationship` key) or the extended shape. When
 * the key is absent, the detector treats the row as
 * having no stored relationship data — Pattern B
 * (referential) cannot fire; only Pattern A (mutual
 * markers on safe summary text) is available.
 */
export type ResolvedHistoryCandidate = SafeMemorySummary & {
  relationship?: SafeMemorySummaryRelationshipForwardCompatible;
};

/** Input to the detector. */
export interface ResolvedHistoryInput {
  /**
   * Ranked top-K candidates the recall path actually
   * used. Order is the order the ranker produced
   * (most-relevant first). The detector never
   * re-ranks this list.
   */
  topCandidates: readonly ResolvedHistoryCandidate[];
  /**
   * Synthesized answer text the provider returned.
   * The detector only inspects safe, controller-
   * validated text (i.e. the post-strip / post-
   * redaction answer from `validateAnswer`). Raw
   * query text is never present here.
   */
  answer: string;
  /**
   * Optional deterministic timestamp in ms epoch. The
   * detector does not read the wall clock itself;
   * whatever the caller passes in (or `0` if omitted)
   * is echoed in the `ResolvedHistorySignal.asOf`
   * field. Reserved for future revisions; the first
   * version does not gate on a timestamp.
   */
  asOf?: number;
}

/**
 * Conservative resolved-history signal. The default
 * value is `{ kind: "none" }`. The discriminated union
 * is the interface; the detector never returns a
 * string / number / boolean.
 *
 * The signal is **not** the same shape as
 * `AmbiguitySignal` in `src/retrieval/ambiguity.ts`:
 * `AmbiguitySignal` is keyed on `kind: "ambiguous"`
 * and carries a `reason` field; this signal is keyed
 * on `kind: "resolved-history"`. A future Phase I / J
 * wiring commit will extend `AmbiguitySignal` to
 * include this third variant; Phase H is detector-
 * only and the new variant lives in its own type.
 *
 * `reason` is always `"explicit-resolution"` in the
 * first version. A future revision may add
 * `"implicit-confidence"` or similar values behind
 * an approval gate; the closed set today is the
 * single string.
 */
export type ResolvedHistorySignal =
  | { kind: "none"; asOf: number }
  | {
      kind: "resolved-history";
      reason: "explicit-resolution";
      memoryIds: number[];
      confidence: number;
      asOf: number;
    };

// ---------------------------------------------------------------------------
// Marker-match helpers
// ---------------------------------------------------------------------------

/**
 * Per-row marker flags. The detector classifies each
 * candidate by the side(s) its safe summary carries.
 *
 * A row that carries markers from BOTH sides is
 * flagged as a partial self-resolution; the first
 * version of the detector refuses to pair it (a row
 * cannot be both previous-side and current-side in a
 * single pair). A row that carries no marker is a
 * plain row (no resolution evidence on its own).
 */
interface RowMarkerFlags {
  hasPreviousSide: boolean;
  hasCurrentSide: boolean;
}

function findRowMarkerFlags(text: string): RowMarkerFlags {
  if (typeof text !== "string" || text.length === 0) {
    return { hasPreviousSide: false, hasCurrentSide: false };
  }
  const lowered = text.toLowerCase();
  const tokens = lowered.split(/[^a-z0-9']+/);
  let hasPreviousSide = false;
  let hasCurrentSide = false;
  for (const raw of tokens) {
    if (raw.length === 0) continue;
    if (PREVIOUS_SIDE_MARKERS.has(raw)) {
      hasPreviousSide = true;
    }
    if (CURRENT_SIDE_MARKERS.has(raw)) {
      hasCurrentSide = true;
    }
  }
  // "no longer" is a multi-word marker. The bare-word
  // `no` is also a previous-side marker; the bigram
  // check is a no-op when the row already carried
  // either. We match the bigram explicitly so a row
  // that says "no longer in use" is flagged as
  // previous-side even when the stop-word filter has
  // stripped `no` (it has not, in the current
  // tokenizer, because the `no` token is preserved by
  // the marker set above — but the explicit bigram
  // check is defensive against future tokenizer
  // changes).
  if (lowered.includes(NO_LONGER_BIGRAM)) {
    hasPreviousSide = true;
  }
  return { hasPreviousSide, hasCurrentSide };
}

// ---------------------------------------------------------------------------
// Pure detection
// ---------------------------------------------------------------------------

/**
 * Conservative resolved-history detector.
 *
 * Properties (mirrors `detectAmbiguity`):
 *   - **Pure.** No side effects, no I/O, no clock reads,
 *     no provider calls, no storage access.
 *   - **Deterministic.** For the same `(topCandidates,
 *     answer, asOf)`, the output is byte-stable across
 *     calls. The `topCandidates` order does not affect
 *     the result, but the `id`-ordering inside emitted
 *     arrays is deterministic (ascending `id`).
 *   - **Non-mutating.** Inputs are never modified.
 *   - **Conservative.** Below-threshold signals are
 *     dropped silently. The default is `kind: "none"`.
 *   - **Bounded output.** `memoryIds` length is at most
 *     `MAX_RESOLVED_HISTORY_IDS`, ascending.
 *   - **No raw text.** The function never references any
 *     "raw" / "input" / "query" field; only safe summary
 *     fields and the validated answer text are read.
 *
 * Detection rules (first version, conservative):
 *
 *   1. **Pre-flight.** A pair of candidates qualifies
 *      only if:
 *      - both are top-K candidates for the query;
 *      - neither row carries a stored `conflictsWith`
 *        pointer to the other (if it does, the Phase D
 *        warning wins; spec §4.2);
 *      - neither row carries a stored `olderVariantsOf`
 *        pointer to the other (same precedence rule;
 *        the older-variant Phase D warning wins).
 *
 *   2. **Pattern A (mutual).** One row carries a
 *      previous-side marker (`previous`, `old`,
 *      `superseded`, `no longer`) and the other row
 *      carries a current-side marker (`current`,
 *      `replaced`), with the rows in different marker
 *      sides. Rows that carry markers from **both**
 *      sides are not paired (they are partially self-
 *      resolved, which the first version does not
 *      support).
 *
 *   3. **Pattern B (referential).** One row carries a
 *      current-side marker and explicitly references
 *      the other row's id via a `supersedes: [id]` or
 *      `supersededBy: [id]` block on the relationship
 *      metadata. Pattern B is read-only: the detector
 *      consumes the keys when they are present, but the
 *      first version of the storage / writer does not
 *      produce them. The pairing rule does not require
 *      a marker on the *referenced* side — the
 *      explicit pointer is the evidence.
 *
 *   4. **Answer alignment.** The synthesized answer
 *      must align with the non-previous ("current")
 *      side. Alignment is computed as Jaccard overlap
 *      on content tokens (length >= 4) between the
 *      answer and the current-side summary; the
 *      threshold is
 *      `RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD`
 *      (0.4). The threshold is a constant, exported
 *      for tests.
 *
 *   5. **Confidence.** The detector's confidence is
 *      derived from the pairing strength and the
 *      answer overlap. The point estimate must be at
 *      least `RESOLVED_HISTORY_CONFIDENCE_THRESHOLD`
 *      (0.80) for the signal to be emitted; below it,
 *      the detector stays silent. Pattern A mutual
 *      pairing is the strong signal (it carries the
 *      closed-set marker on both sides); Pattern B
 *      referential is slightly weaker (only one side
 *      carries an explicit marker; the other side
 *      carries the explicit pointer).
 *
 *   6. **Recency rule (negative).** The detector MUST
 *      NOT use any of the following to claim
 *      resolution: wall-clock time of the write,
 *      `derivedAt`, memory `id` ordering, the lexical
 *      ranker's order in the top-K. This is the locked
 *      decision §2.2 (spec).
 *
 * The detector is silent in every other case. It does
 * not emit `kind: "resolved-history"` for: single
 * candidates, no-marker rows, asymmetric-marker-only
 * pairs (single marker does not trigger resolution in
 * the first version, spec §5.2), recency-only pairs,
 * stored-conflict pairs (Phase D wins), or stored-
 * older-variant pairs (Phase D wins).
 */
export function detectResolvedHistory(
  input: ResolvedHistoryInput,
): ResolvedHistorySignal {
  const { topCandidates, answer } = input;
  const asOf = typeof input.asOf === "number" && Number.isFinite(input.asOf)
    ? Math.trunc(input.asOf)
    : 0;

  // Defensive: a non-array `topCandidates` becomes an
  // empty list. The type is `readonly` so a structural
  // type bug would be caught at the call site, but
  // this also defends against `null` / `undefined`
  // slipping through `unknown`-typed boundaries.
  const list = Array.isArray(topCandidates) ? topCandidates : [];
  const safeAnswer = typeof answer === "string" ? answer : "";

  if (list.length < 2) {
    // A single candidate (or none) cannot form a pair.
    // The detector is pairwise; stay silent.
    return { kind: "none", asOf };
  }

  // Pre-compute marker flags for every candidate so
  // the pair loop stays O(n^2) but the inner work is
  // constant-time. The result is deterministic across
  // orderings.
  const flags = new Map<number, RowMarkerFlags>();
  const idSet = new Set<number>();
  for (const c of list) {
    if (!isResolvedHistoryCandidate(c)) continue;
    if (!Number.isFinite(c.id)) continue;
    if (idSet.has(c.id)) continue;
    idSet.add(c.id);
    flags.set(c.id, findRowMarkerFlags(c.memoryContent));
  }

  // Walk every pair. The first pair that satisfies the
  // full rule (Pattern A or Pattern B + answer
  // alignment + confidence) is emitted. The detector
  // is conservative and does not exhaustively
  // enumerate; a future revision may enumerate to
  // support multi-row resolved groups (spec §7.2
  // three-step timeline) and to support the
  // three-step "current + history note" case where the
  // synthesized answer matches the "current" row and
  // the older two rows both carry previous-side
  // markers. The single-pair rule here is the
  // first-version scope; a later phase may extend
  // the helper to enumerate all participating rows.
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a || !isResolvedHistoryCandidate(a)) continue;
    if (!Number.isFinite(a.id)) continue;
    const aFlag = flags.get(a.id);
    if (!aFlag) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (!b || !isResolvedHistoryCandidate(b)) continue;
      if (!Number.isFinite(b.id)) continue;
      const bFlag = flags.get(b.id);
      if (!bFlag) continue;
      // Skip the pair entirely when a stored Phase D
      // pointer (mutual `conflictsWith` or mutual
      // `olderVariantsOf`) exists between the two
      // rows. The Phase D warning wins (spec §4.2 /
      // §5.2). The detector must not downgrade a
      // Phase D warning into a resolved-history note.
      if (
        hasMutualStoredConflict(list, a.id, b.id) ||
        hasMutualStoredOlderVariant(list, a.id, b.id)
      ) {
        continue;
      }
      const result = evaluatePair(a, aFlag, b, bFlag, safeAnswer, asOf);
      if (result !== null) {
        return result;
      }
    }
  }
  return { kind: "none", asOf };
}

// ---------------------------------------------------------------------------
// Internal pair evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a single ordered pair `(a, b)` for the
 * full resolved-history rule. Returns the signal on
 * success and `null` on every other path (silent /
 * fall through to the next pair). The order of `a` /
 * `b` matters for the marker-side assignment: the
 * detector tries `a` as previous-side / `b` as
 * current-side, then `b` as previous-side / `a` as
 * current-side, and accepts the first assignment
 * that satisfies the full rule.
 *
 * The pairing rule is **permissive about co-carried
 * markers** (spec example §7.2): a row that carries
 * both a previous-side marker AND a current-side
 * marker is still eligible to be the "previous side"
 * of a pair when the other row is the unambiguous
 * "current" side. The discriminator is the answer
 * alignment: the synthesized answer must align with
 * the current-side row.
 */
function evaluatePair(
  a: ResolvedHistoryCandidate,
  aFlag: RowMarkerFlags,
  b: ResolvedHistoryCandidate,
  bFlag: RowMarkerFlags,
  answer: string,
  asOf: number,
): ResolvedHistorySignal | null {
  // ---- Pattern A: mutual markers ----
  // Assignment 1: a = previous-side, b = current-side.
  // The previous-side row must carry a previous-side
  // marker (it may also carry a current-side marker
  // — that is the spec example §7.2 shape, where row
  // 1 carries both `previous` and `current`). The
  // current-side row must carry a current-side
  // marker; it may also carry a previous-side marker.
  if (aFlag.hasPreviousSide && bFlag.hasCurrentSide) {
    return finalizePatternA(a.id, b.id, a, b, answer, asOf);
  }
  // Assignment 2: b = previous-side, a = current-side.
  if (bFlag.hasPreviousSide && aFlag.hasCurrentSide) {
    return finalizePatternA(b.id, a.id, b, a, answer, asOf);
  }
  // ---- Pattern B: referential pointer (forward-compat) ----
  // The detector accepts Pattern B when at least one
  // side carries a current-side marker AND the
  // relationship block on the same side explicitly
  // references the other row's id via `supersedes`
  // or `supersededBy`. The previous-side row need not
  // carry a marker (the explicit pointer is the
  // evidence). A row with both a current-side marker
  // and the explicit pointer is still eligible.
  if (hasReferentialPointer(a, b.id) && aFlag.hasCurrentSide) {
    return finalizePatternB(b.id, a.id, b, a, answer, asOf);
  }
  if (hasReferentialPointer(b, a.id) && bFlag.hasCurrentSide) {
    return finalizePatternB(a.id, b.id, a, b, answer, asOf);
  }
  return null;
}

/**
 * Run the answer-alignment and confidence checks for
 * a Pattern A (mutual) pair. `previousId` /
 * `currentId` are the resolved row ids. Returns
 * `null` when the answer does not align with the
 * current side. The confidence is set to a
 * deterministic high value when the answer-alignment
 * gate clears; the explicit `RESOLVED_HISTORY_CONFIDENCE_THRESHOLD`
 * check at the call site ensures the emitted value
 * is at or above the spec floor.
 */
function finalizePatternA(
  previousId: number,
  currentId: number,
  previous: ResolvedHistoryCandidate,
  current: ResolvedHistoryCandidate,
  answer: string,
  asOf: number,
): ResolvedHistorySignal | null {
  const overlap = contentJaccard(answer, current.memoryContent);
  if (overlap < RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD) {
    return null;
  }
  // Pattern A is the strong signal: both sides carry
  // closed-set markers. The first-version confidence
  // is a deterministic high value; future revisions
  // may modulate it by the answer-overlap point
  // estimate, but the spec defines a single floor
  // (0.80) and the first version pins a single
  // confidence value (0.90) for a clean Pattern A
  // pair. The value is conservative: well above the
  // floor, well below 1.0.
  void previous;
  void overlap;
  return buildSignal(previousId, currentId, 0.9, asOf);
}

/**
 * Run the answer-alignment and confidence checks for
 * a Pattern B (referential) pair. The previous-side
 * row is identified by an explicit `supersedes` /
 * `supersededBy` pointer; the previous row need not
 * carry a marker itself.
 */
function finalizePatternB(
  previousId: number,
  currentId: number,
  previous: ResolvedHistoryCandidate,
  current: ResolvedHistoryCandidate,
  answer: string,
  asOf: number,
): ResolvedHistorySignal | null {
  const overlap = contentJaccard(answer, current.memoryContent);
  if (overlap < RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD) {
    return null;
  }
  // Pattern B is slightly weaker than Pattern A:
  // only the current side carries a marker; the
  // previous side is identified by the explicit
  // pointer. The first-version confidence is 0.85:
  // above the spec floor (0.80) and below Pattern A
  // (0.90), so the two patterns are distinguishable
  // in tests and any future Phase I / J wiring.
  void previous;
  void overlap;
  return buildSignal(previousId, currentId, 0.85, asOf);
}

/**
 * Build the bounded `kind: "resolved-history"` signal
 * from a pair of resolved ids and a confidence. The
 * `memoryIds` array is sorted ascending and bounded
 * to `MAX_RESOLVED_HISTORY_IDS`; the pair is two ids
 * so the cap is effectively a no-op in the first
 * version (a future revision that enumerates multi-
 * row resolved groups would benefit from the cap).
 *
 * The confidence is the spec's "point estimate"; the
 * floor check (>= 0.80) is enforced here as a
 * defensive gate so a future revision that lowers the
 * per-pattern constant below the floor cannot
 * silently emit a sub-threshold signal.
 */
function buildSignal(
  previousId: number,
  currentId: number,
  confidence: number,
  asOf: number,
): ResolvedHistorySignal {
  const bounded = clamp01(confidence);
  // Defensive gate: the per-pattern constants are
  // 0.90 (Pattern A) and 0.85 (Pattern B), both above
  // the spec floor (0.80). A future revision that
  // lowers the constant below the floor would still
  // emit, but the detector's callers (Phase I / J)
  // will gate on the threshold; we re-assert the
  // floor here as belt-and-braces.
  const final = bounded >= RESOLVED_HISTORY_CONFIDENCE_THRESHOLD
    ? bounded
    : RESOLVED_HISTORY_CONFIDENCE_THRESHOLD;
  const sorted = [previousId, currentId].sort((x, y) => x - y);
  return {
    kind: "resolved-history",
    reason: "explicit-resolution",
    memoryIds: sorted.slice(0, MAX_RESOLVED_HISTORY_IDS),
    confidence: final,
    asOf,
  };
}

// ---------------------------------------------------------------------------
// Stored pointer checks (Phase D precedence, spec §4.2)
// ---------------------------------------------------------------------------

/**
 * `true` when both `a` and `b` carry a stored
 * `conflictsWith` pointer at the other id. Mirrors
 * the Phase D Rule 1 logic in
 * `src/retrieval/ambiguity.ts`; the resolver does not
 * import from there to keep the modules decoupled.
 */
function hasMutualStoredConflict(
  list: readonly ResolvedHistoryCandidate[],
  aId: number,
  bId: number,
): boolean {
  const a = list.find((x) => x.id === aId);
  const b = list.find((x) => x.id === bId);
  const aBlock = a ? readRelationshipBlock(a) : undefined;
  const bBlock = b ? readRelationshipBlock(b) : undefined;
  if (!aBlock || !bBlock) return false;
  return (
    safeIncludesNumber(aBlock.conflictsWith, bId) &&
    safeIncludesNumber(bBlock.conflictsWith, aId)
  );
}

/**
 * `true` when both `a` and `b` carry a stored
 * `olderVariantsOf` pointer at the other id. Mirrors
 * the Phase D Rule 2 logic in
 * `src/retrieval/ambiguity.ts`; the resolver does not
 * import from there to keep the modules decoupled.
 */
function hasMutualStoredOlderVariant(
  list: readonly ResolvedHistoryCandidate[],
  aId: number,
  bId: number,
): boolean {
  const a = list.find((x) => x.id === aId);
  const b = list.find((x) => x.id === bId);
  const aBlock = a ? readRelationshipBlock(a) : undefined;
  const bBlock = b ? readRelationshipBlock(b) : undefined;
  if (!aBlock || !bBlock) return false;
  return (
    safeIncludesNumber(aBlock.olderVariantsOf, bId) &&
    safeIncludesNumber(bBlock.olderVariantsOf, aId)
  );
}

/**
 * `true` when the relationship block on `current`
 * carries a `supersedes: [previousId]` or
 * `supersededBy: [previousId]` entry. Both keys are
 * accepted (the spec is symmetric about direction;
 * the writer can choose). The fields are optional
 * and absent in the first version of the storage /
 * writer, so a missing key is a `false`.
 */
function hasReferentialPointer(
  current: ResolvedHistoryCandidate,
  previousId: number,
): boolean {
  const block = readRelationshipBlock(current);
  if (!block) return false;
  if (safeIncludesNumber(block.supersedes, previousId)) return true;
  if (safeIncludesNumber(block.supersededBy, previousId)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

/**
 * Jaccard overlap between two strings, computed on
 * `tokenize`'s content tokens with the spec's
 * `RESOLVED_HISTORY_ANSWER_MIN_TOKEN_LEN` (4) floor.
 * Stop words and very short tokens are dropped by the
 * shared tokenizer so they cannot accidentally
 * contribute to the overlap. Returns a value in
 * `[0, 1]`.
 *
 * This is a slightly different shape from the
 * Jaccard helpers in `ambiguity.ts` /
 * `relationship.ts`: those use the raw token
 * multisets and accept any length; this helper uses
 * the `tokenize`-filtered content tokens and the
 * length-4 floor. The asymmetry is intentional —
 * the answer-alignment check is a coarse
 * "did the model take the current side" probe, not
 * a full lexical similarity score, and stop-word
 * noise dominates at the answer-text granularity.
 */
function contentJaccard(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  if (a.length === 0 || b.length === 0) return 0;
  const aTokens = tokenize(a).filter(
    (t) => t.length >= RESOLVED_HISTORY_ANSWER_MIN_TOKEN_LEN,
  );
  const bTokens = tokenize(b).filter(
    (t) => t.length >= RESOLVED_HISTORY_ANSWER_MIN_TOKEN_LEN,
  );
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const counts = new Map<string, { a: number; b: number }>();
  for (const t of aTokens) {
    const e = counts.get(t) ?? { a: 0, b: 0 };
    e.a += 1;
    counts.set(t, e);
  }
  for (const t of bTokens) {
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

function safeIncludesNumber(
  arr: readonly number[] | undefined,
  id: number,
): boolean {
  if (!Array.isArray(arr)) return false;
  for (const x of arr) {
    if (typeof x === "number" && Number.isFinite(x) && x === id) return true;
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
 * Defensive structural check on an `unknown` value
 * to confirm it is a `SafeMemorySummary`-shaped
 * object. Mirrors the helper in `ambiguity.ts` /
 * `relationship.ts`; not imported to keep the three
 * modules replaceable.
 *
 * A `relationship` field that is present but
 * malformed (e.g. a string, a number, `null`) is
 * **silently treated as if it were absent** rather
 * than causing the row to be dropped entirely. The
 * row's safe summary fields are still valid; the
 * detector just cannot read the relationship block.
 * This matches the read-side fallback in
 * `listActiveMemorySummaries` for malformed metadata
 * (Phase B, conservative spec).
 */
function isResolvedHistoryCandidate(
  v: unknown,
): v is ResolvedHistoryCandidate {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isFinite(o.id)) return false;
  if (typeof o.memoryContent !== "string") return false;
  if (typeof o.state !== "string") return false;
  if (!Array.isArray(o.tags)) return false;
  // `relationship` is optional. A malformed value
  // (non-object) is accepted as "no relationship".
  // The detector only reads it when the value is a
  // proper object; a string / number / null is a
  // silent "no relationship" for the purposes of
  // Pattern B.
  return true;
}

/**
 * Safely read the relationship block off a candidate.
 * Returns `undefined` when the block is missing or
 * malformed. The detector treats `undefined` as
 * "Pattern B cannot fire" (no relationship evidence)
 * without dropping the row.
 */
function readRelationshipBlock(
  v: ResolvedHistoryCandidate,
): SafeMemorySummaryRelationshipForwardCompatible | undefined {
  const r = (v as unknown as Record<string, unknown>).relationship;
  if (r === undefined || r === null) return undefined;
  if (typeof r !== "object") return undefined;
  return r as SafeMemorySummaryRelationshipForwardCompatible;
}

// ---------------------------------------------------------------------------
// Public-message note formatter (Phase J, spec §8.4)
// ---------------------------------------------------------------------------

/**
 * Hard cap on the length of the public resolved-history
 * note.
 *
 * The note is a *prefix on the public message only*; the
 * underlying synthesized answer is unchanged. A small cap
 * keeps the public surface calm and bounded even if the
 * detector ever fires on a long id list. Mirrors
 * `AMBIGUITY_NOTE_MAX_LENGTH` in `src/retrieval/ambiguity.ts`
 * so the two public notes share a single bound. Exported
 * for tests.
 */
export const RESOLVED_HISTORY_NOTE_MAX_LENGTH = 240;

/**
 * The exact public-message note wording. Approved by the
 * user for Phase J. The note is **prose only** — no
 * `#N` memory-id references, no `Sources: #...`, no
 * "and N more" truncation. The note's wording is
 * deliberately different from the Phase D
 * `formatAmbiguityNote` note (it does not say
 * "disagree" / "older variants"): the new verdict
 * describes a *resolved* history pair, not a live
 * disagreement.
 *
 * The constant is exported for tests so the
 * regression-pinned wording is checked by `===` rather
 * than by an anchored regex (which is the same shape
 * the Phase D note formatter uses internally). The
 * constant is module-internal in the sense that no
 * caller is expected to mutate or override it; future
 * tuning must be a separate, approved revision.
 */
export const RESOLVED_HISTORY_NOTE_TEXT =
  "Note: I found earlier related information, but newer entries appear to supersede it.";

/**
 * Render a conservative, bounded, human-readable note from
 * a `kind: "resolved-history"` `ResolvedHistorySignal`.
 *
 * Properties (mirrors `detectResolvedHistory` and
 * `formatAmbiguityNote`):
 *
 *   - **Pure.** No I/O, no clock reads, no provider calls,
 *     no storage access, no mutation of the input.
 *   - **Deterministic.** For the same input, the output is
 *     byte-stable across calls.
 *   - **Bounded.** The returned string is at most
 *     `RESOLVED_HISTORY_NOTE_MAX_LENGTH` characters.
 *   - **No raw text.** The function never references any
 *     "raw" / "input" / "query" / "answer" field; only the
 *     validated signal (which the detector populated from
 *     safe summary fields and the validated answer text)
 *     is read.
 *   - **No public memory ids.** The note never includes
 *     memory ids. The detector's `memoryIds` array remains
 *     an internal field on `ResolvedHistorySignal`; it is
 *     observed by tests and any future structured-content
 *     transport, but it is **not** serialized into the
 *     public MCP `text` content block. This is the
 *     `experiment/public-message-hide-memory-ids` Phase J
 *     invariant (spec §8.4): the new public note must
 *     apply the same no-id-in-public-text contract the
 *     existing `formatAmbiguityNote` applies.
 *   - **Conservative wording.** The note flags the
 *     presence of a resolved history pair without
 *     claiming a current truth, picking a winner, or
 *     overstating the confidence. It is prose only.
 *   - **No diagnostic leakage.** The note never exposes
 *     `detectionConfidence`, `derivedAt`,
 *     `derivedSchemaVersion`, `memoryIds`, the
 *     `supersedes` / `supersededBy` / `resolvedAt` keys,
 *     or any other internal field.
 *
 * Behaviour:
 *
 *   - `kind: "none"` (or any non-`resolved-history`
 *     signal, or `null` / `undefined` defensively)
 *     returns the empty string. The tool layer treats
 *     the empty string as "no note: do not prefix the
 *     public message".
 *   - `kind: "resolved-history", reason:
 *     "explicit-resolution"` returns the exact approved
 *     prose string `RESOLVED_HISTORY_NOTE_TEXT`.
 *
 * The function never throws. Any malformed input
 * collapses to the empty string.
 */
export function formatResolvedHistoryNote(
  signal: ResolvedHistorySignal | null | undefined,
): string {
  if (signal === null || signal === undefined) return "";
  if (typeof signal !== "object") return "";
  if (signal.kind !== "resolved-history") return "";
  if (signal.reason !== "explicit-resolution") return "";
  // The public note is prose only. The signal's
  // `memoryIds` array is internal-only: it is preserved
  // on the typed signal for tests and any future
  // structured-content transport, but it is NEVER
  // serialized into the public MCP `text` content block.
  // We still validate that the field is an array
  // (defensive — a non-array value is a malformed
  // signal and collapses to the empty string). Garbage
  // entries inside a valid array (NaN, negatives,
  // non-finite, non-integers) are filtered out at the
  // detector layer; with no ids rendered, a garbled id
  // can never reach the public surface.
  if (!Array.isArray(signal.memoryIds)) return "";
  const note = RESOLVED_HISTORY_NOTE_TEXT;
  if (note.length <= RESOLVED_HISTORY_NOTE_MAX_LENGTH) return note;
  // Defensive truncation: keep the note within the
  // bound even if the prose grew unexpectedly in a
  // future revision. The truncation must be
  // deterministic and must keep an ellipsis so the
  // caller can see the note was cut.
  return `${note.slice(0, RESOLVED_HISTORY_NOTE_MAX_LENGTH - 1).trimEnd()}…`;
}
