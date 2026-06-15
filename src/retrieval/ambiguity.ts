/**
 * Conservative recall-side ambiguity detector.
 *
 * Phase C of the conflict / currentness metadata design
 * (see `docs/conflict-currentness-metadata.md`). This module is
 * intentionally a pure, deterministic, offline helper:
 *
 *   - No I/O. No storage reads or writes.
 *   - No provider calls.
 *   - No state transitions.
 *   - No re-ranking. The detector never reorders the top-K
 *     candidates the recall controller already chose.
 *   - No raw text. The function only ever inspects safe
 *     summary fields and the validated answer text the
 *     controller received from the synthesis provider.
 *   - No mutation. Inputs are read-only.
 *   - No clock reads. The caller may pass `asOf` for byte-
 *     stable test output, but the field is informational; the
 *     detector never gates on a timestamp.
 *
 * What it does:
 *
 *   - Inspects the ranked top-K summaries (with their
 *     relationship metadata, when the read-side projection
 *     carries it) plus the synthesized answer.
 *   - Returns a conservative `AmbiguitySignal`. The default
 *     is `{ kind: "none" }` — silence is the safe default.
 *   - The signal carries only bounded ids / reason / confidence,
 *     never raw text. It is an internal field on
 *     `RecallOutcome`, observable to tests and any future
 *     structured-content transport, but never serialized
 *     into the public MCP `text` content block (the
 *     `src/tools/recall.ts` projection drops it). The
 *     public message must also never echo the `memoryIds`
 *     field as `#N` references: the note formatter
 *     (`formatAmbiguityNote` below) emits prose only.
 *
 * Conservative thresholds from the spec (exported for tests):
 *
 *   - `AMBIGUITY_CONFIDENCE_THRESHOLD` (0.80)
 *     The minimum per-rule confidence required to emit a
 *     `kind: "ambiguous"` signal. Below it, the detector
 *     stays silent. Tunable in a later revision behind the
 *     same approval gate as a public behaviour change.
 *
 *   - `MAX_AMBIGUITY_IDS` (16)
 *     Hard cap on the `memoryIds` array in the signal. Per
 *     spec §6 the related-id arrays are bounded; the same
 *     bound is applied here for consistency. The public
 *     note never includes any of these ids; the bound
 *     protects internal storage and structured transport
 *     only.
 *
 * The detector is intentionally a placeholder heuristic
 * (spec §9.2 — "small, deterministic lexical overlap with a
 * conservative threshold, plus a shared-tag / opposing-claim
 * check"). The interface is the contract; the internals are
 * replaceable. The bar for emitting any downstream-visible
 * signal is intentionally high.
 */

import type { SafeMemorySummary } from "../storage/storage.js";
import { tokenize } from "./lexical.js";

// ---------------------------------------------------------------------------
// Thresholds and bounds (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Conservative confidence threshold for emitting any
 * `kind: "ambiguous"` signal. Exported so tests can pin the
 * exact value. Not configurable through any public API;
 * future tuning must be a separate, approved revision
 * (spec §9.2).
 */
export const AMBIGUITY_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Hard cap on the `memoryIds` array in a `kind: "ambiguous"`
 * signal. Mirrors `MAX_RELATED_IDS` in `relationship.ts`; the
 * detector must never grow unbounded when the stored
 * relationship block is corrupted or has stale ids.
 */
export const MAX_AMBIGUITY_IDS = 16;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Relationship block projected onto a `SafeMemorySummary` by
 * the read-side projection in `listActiveMemorySummaries`.
 * The block is optional: rows written before Phase B (or
 * rows whose stored `metadata` JSON is malformed) carry the
 * empty shape (empty id arrays, `detectionConfidence: 0`).
 *
 * This shape mirrors `PersistedRelationshipBlock` in
 * `relationship.ts`. The detector never depends on raw
 * fields beyond the id arrays and the version literal; the
 * rest is informational.
 */
export interface SafeMemorySummaryRelationship {
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
}

/**
 * Optional extension of `SafeMemorySummary` that carries the
 * relationship block the read-side projection returns. The
 * detector accepts either the bare shape (no `relationship`
 * key) or the extended shape. When the key is absent, the
 * detector treats the row as having no stored relationship
 * data — it can still flag conflicts via the answer-text /
 * asymmetric-negation path, but cannot claim a stored
 * `conflictsWith` pointer.
 */
export type SafeMemorySummaryWithRelationship = SafeMemorySummary & {
  relationship?: SafeMemorySummaryRelationship;
};

/** Input to the detector. */
export interface AmbiguityInput {
  /**
   * Ranked top-K candidates the recall path actually used.
   * Order is the order the ranker produced (most-relevant
   * first). The detector never re-ranks this list.
   */
  topCandidates: readonly SafeMemorySummaryWithRelationship[];
  /**
   * Synthesized answer text the provider returned. The
   * detector only inspects safe, controller-validated text
   * (i.e. the post-strip / post-redaction answer from
   * `validateAnswer`). Raw query text is never present here.
   */
  answer: string;
  /**
   * Optional deterministic timestamp in ms epoch. The
   * detector does not read the wall clock itself; whatever
   * the caller passes in (or `0` if omitted) is echoed in
   * the `AmbiguitySignal.asOf` field. Reserved for future
   * revisions; the first version does not gate on a
   * timestamp.
   */
  asOf?: number;
}

/**
 * Conservative ambiguity signal. The default value is
 * `{ kind: "none" }`. The discriminated union is the
 * interface; the detector never returns a string / number
 * / boolean.
 */
export type AmbiguitySignal =
  | { kind: "none"; asOf: number }
  | {
      kind: "ambiguous";
      reason: "conflicting-candidates";
      memoryIds: number[];
      confidence: number;
      asOf: number;
    }
  | {
      kind: "ambiguous";
      reason: "older-variant-suspected";
      memoryIds: number[];
      confidence: number;
      asOf: number;
    };

// ---------------------------------------------------------------------------
// Pure detection
// ---------------------------------------------------------------------------

/**
 * Conservative recall-side ambiguity detector.
 *
 * Properties (mirrors `deriveRelationshipMetadata`):
 *   - **Pure.** No side effects, no I/O, no clock reads, no
 *     provider calls, no storage access.
 *   - **Deterministic.** For the same
 *     `(topCandidates, answer, asOf)`, the output is
 *     byte-stable across calls. The `topCandidates` order
 *     does not affect the result, but the `id`-ordering
 *     inside emitted arrays is deterministic (ascending
 *     `id`).
 *   - **Non-mutating.** Inputs are never modified.
 *   - **Conservative.** Below-threshold signals are dropped
 *     silently. The default is `kind: "none"`.
 *   - **Bounded output.** `memoryIds` length is at most
 *     `MAX_AMBIGUITY_IDS`, ascending.
 *   - **No raw text.** The function never references any
 *     "raw" / "input" / "query" field; only safe summary
 *     fields and the validated answer text are read.
 *
 * Detection rules (first version, conservative):
 *
 *   1. **`conflicting-candidates`.** Two or more candidates
 *      that the stored `relationship.conflictsWith` block
 *      points at each other. Confidence is the
 *      `min(confidenceA, confidenceB)` of the two
 *      `detectionConfidence` values in the stored blocks.
 *      Below `AMBIGUITY_CONFIDENCE_THRESHOLD` -> silent.
 *
 *   2. **`older-variant-suspected`.** A pair of candidates
 *      that the stored `relationship.olderVariantsOf` block
 *      points at each other. Same confidence rule.
 *
 *   3. **Asymmetric-negation between top candidates.**
 *      A safety net for the case where the stored
 *      `relationship` block is missing or stale: if two
 *      top candidates share high lexical overlap AND exactly
 *      one of them contains a negation marker AND the
 *      synthesized answer contains a phrase from the
 *      *other* side, the detector emits
 *      `conflicting-candidates` with a `confidence` in
 *      `[AMBIGUITY_CONFIDENCE_THRESHOLD, 1]`. This is the
 *      lexical counterpart to the structural pointer in (1)
 *      and is gated on the same threshold.
 *
 * The detector is silent in every other case. It does not
 * emit `kind: "ambiguous"` for the no-relationship, no-
 * overlap, low-confidence, or single-candidate inputs that
 * are the steady state of the recall MVP.
 */
export function detectAmbiguity(input: AmbiguityInput): AmbiguitySignal {
  const { topCandidates, answer } = input;
  const asOf = typeof input.asOf === "number" && Number.isFinite(input.asOf)
    ? Math.trunc(input.asOf)
    : 0;

  // Defensive: a non-array `topCandidates` becomes an empty
  // list. The type is `readonly` so a structural type bug
  // would be caught at the call site, but this also defends
  // against `null` / `undefined` slipping through `unknown`-
  // typed boundaries.
  const list = Array.isArray(topCandidates) ? topCandidates : [];
  const safeAnswer = typeof answer === "string" ? answer : "";

  if (list.length < 2) {
    // A single candidate (or none) cannot be in conflict with
    // itself; the only signal available in the first version
    // is pairwise. Stay silent.
    return { kind: "none", asOf };
  }

  // ---- Rule 1: stored `conflictsWith` points between two top candidates ----
  const conflictIds = findMutualStoredConflict(list);
  if (conflictIds !== null) {
    const conf = storedConflictConfidence(list, conflictIds);
    if (conf >= AMBIGUITY_CONFIDENCE_THRESHOLD) {
      return {
        kind: "ambiguous",
        reason: "conflicting-candidates",
        memoryIds: sortAsc(conflictIds).slice(0, MAX_AMBIGUITY_IDS),
        confidence: clamp01(conf),
        asOf,
      };
    }
  }

  // ---- Rule 2: stored `olderVariantsOf` points between two top candidates ----
  const olderIds = findMutualStoredOlderVariant(list);
  if (olderIds !== null) {
    const conf = storedOlderVariantConfidence(list, olderIds);
    if (conf >= AMBIGUITY_CONFIDENCE_THRESHOLD) {
      return {
        kind: "ambiguous",
        reason: "older-variant-suspected",
        memoryIds: sortAsc(olderIds).slice(0, MAX_AMBIGUITY_IDS),
        confidence: clamp01(conf),
        asOf,
      };
    }
  }

  // ---- Rule 3: lexical + asymmetric-negation + answer alignment ----
  // Safety net for the case where the stored relationship
  // block is missing or stale. Two top candidates share
  // high overlap, exactly one negates, and the synthesized
  // answer aligns with the non-negating side.
  const lexical = lexicalNegationSignal(list, safeAnswer);
  if (lexical !== null && lexical.confidence >= AMBIGUITY_CONFIDENCE_THRESHOLD) {
    return {
      kind: "ambiguous",
      reason: "conflicting-candidates",
      memoryIds: sortAsc(lexical.memoryIds).slice(0, MAX_AMBIGUITY_IDS),
      confidence: clamp01(lexical.confidence),
      asOf,
    };
  }

  return { kind: "none", asOf };
}

// ---------------------------------------------------------------------------
// Internal rule implementations
// ---------------------------------------------------------------------------

/**
 * Find a pair of ids `a, b` (a < b) such that:
 *   - `a` appears in `topCandidates`, and its stored
 *     `relationship.conflictsWith` includes `b`.
 *   - `b` appears in `topCandidates`, and its stored
 *     `relationship.conflictsWith` includes `a`.
 *
 * Returns the two ids, or `null` if no such pair exists in
 * the top-K. The first such pair is returned; the detector
 * is conservative and the bound is `MAX_AMBIGUITY_IDS`.
 */
function findMutualStoredConflict(
  list: readonly SafeMemorySummaryWithRelationship[],
): [number, number] | null {
  const idSet = new Set<number>();
  for (const c of list) {
    if (isSafeMemorySummaryWithRelationship(c) && Number.isFinite(c.id)) {
      idSet.add(c.id);
    }
  }
  for (const a of list) {
    if (!isSafeMemorySummaryWithRelationship(a)) continue;
    if (!Number.isFinite(a.id)) continue;
    const aConf = a.relationship?.conflictsWith;
    if (!Array.isArray(aConf)) continue;
    for (const b of aConf) {
      if (typeof b !== "number" || !Number.isFinite(b)) continue;
      if (!idSet.has(b)) continue;
      const otherRow = list.find((x) => x.id === b);
      if (!otherRow || !isSafeMemorySummaryWithRelationship(otherRow)) continue;
      const bConf = otherRow.relationship?.conflictsWith;
      if (!Array.isArray(bConf)) continue;
      if (!bConf.includes(a.id)) continue;
      return [a.id, b];
    }
  }
  return null;
}

/**
 * Compute the confidence for a stored mutual-conflict pair.
 * The detector treats the lower of the two
 * `detectionConfidence` values as the conservative point
 * estimate, so a row with a stale low-confidence block
 * cannot pull the signal over the threshold.
 */
function storedConflictConfidence(
  list: readonly SafeMemorySummaryWithRelationship[],
  pair: [number, number],
): number {
  const a = list.find((x) => x.id === pair[0]);
  const b = list.find((x) => x.id === pair[1]);
  const aConf = a?.relationship?.detectionConfidence ?? 0;
  const bConf = b?.relationship?.detectionConfidence ?? 0;
  return Math.min(aConf, bConf);
}

/**
 * Find a pair of ids `a, b` (a < b) such that:
 *   - `a` appears in `topCandidates`, and its stored
 *     `relationship.olderVariantsOf` includes `b`.
 *   - `b` appears in `topCandidates`, and its stored
 *     `relationship.olderVariantsOf` includes `a`.
 */
function findMutualStoredOlderVariant(
  list: readonly SafeMemorySummaryWithRelationship[],
): [number, number] | null {
  const idSet = new Set<number>();
  for (const c of list) {
    if (isSafeMemorySummaryWithRelationship(c) && Number.isFinite(c.id)) {
      idSet.add(c.id);
    }
  }
  for (const a of list) {
    if (!isSafeMemorySummaryWithRelationship(a)) continue;
    if (!Number.isFinite(a.id)) continue;
    const aOlder = a.relationship?.olderVariantsOf;
    if (!Array.isArray(aOlder)) continue;
    for (const b of aOlder) {
      if (typeof b !== "number" || !Number.isFinite(b)) continue;
      if (!idSet.has(b)) continue;
      const otherRow = list.find((x) => x.id === b);
      if (!otherRow || !isSafeMemorySummaryWithRelationship(otherRow)) continue;
      const bOlder = otherRow.relationship?.olderVariantsOf;
      if (!Array.isArray(bOlder)) continue;
      if (!bOlder.includes(a.id)) continue;
      return [a.id, b];
    }
  }
  return null;
}

/**
 * Compute the confidence for a stored mutual-older-variant
 * pair, mirroring `storedConflictConfidence`.
 */
function storedOlderVariantConfidence(
  list: readonly SafeMemorySummaryWithRelationship[],
  pair: [number, number],
): number {
  const a = list.find((x) => x.id === pair[0]);
  const b = list.find((x) => x.id === pair[1]);
  const aConf = a?.relationship?.detectionConfidence ?? 0;
  const bConf = b?.relationship?.detectionConfidence ?? 0;
  return Math.min(aConf, bConf);
}

interface LexicalNegationHit {
  memoryIds: [number, number];
  confidence: number;
}

/**
 * Lexical counterpart to the stored-pointer rules. Two top
 * candidates share high lexical overlap, exactly one side
 * negates, and the synthesized answer contains a content
 * fragment from the *non-negating* side. The point estimate
 * is `overlap + claimBump`, bounded at `0.99` so it stays
 * well below the implicit 1.0 ceiling.
 *
 * The function returns the first such pair; the conservative
 * first version does not exhaustively enumerate.
 */
function lexicalNegationSignal(
  list: readonly SafeMemorySummaryWithRelationship[],
  answer: string,
): LexicalNegationHit | null {
  if (answer.length === 0) return null;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a) continue;
    if (!isSafeMemorySummaryWithRelationship(a)) continue;
    if (typeof a.summary !== "string" || a.summary.length === 0) continue;
    const aTokens = tokenize(a.summary);
    if (aTokens.length === 0) continue;
    const aHasNeg = hasNegationMarker(a.summary);
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (!b) continue;
      if (!isSafeMemorySummaryWithRelationship(b)) continue;
      if (typeof b.summary !== "string" || b.summary.length === 0) continue;
      const bTokens = tokenize(b.summary);
      if (bTokens.length === 0) continue;
      const bHasNeg = hasNegationMarker(b.summary);
      // Asymmetric negation: exactly one side negates.
      if (aHasNeg === bHasNeg) continue;
      if (!aHasNeg && !bHasNeg) continue; // unreachable; defensive
      const overlap = jaccard(aTokens, bTokens);
      // High overlap is required; below 0.6 we cannot claim
      // the two summaries are even talking about the same
      // fact.
      if (overlap < 0.6) continue;
      // The synthesized answer must align with the
      // non-negating side. The detector only requires one
      // content token from the non-negating side to be
      // present in the answer; that is a conservative proxy
      // for "the model took the non-negating side". We use
      // a content token set (length >= 4) so stop words do
      // not accidentally match.
      const nonNeg = aHasNeg ? b : a;
      const nonNegTokens = aHasNeg ? bTokens : aTokens;
      const answerLc = answer.toLowerCase();
      let aligned = false;
      for (const t of nonNegTokens) {
        if (t.length < 4) continue;
        if (answerLc.includes(t)) {
          aligned = true;
          break;
        }
      }
      if (!aligned) continue;
      const base = overlap; // in [0.6, 1.0]
      const claimBump = 0.25; // conservative; structural mutual-pointer would be higher
      const confidence = Math.min(0.99, base + claimBump);
      return {
        memoryIds: a.id < b.id ? [a.id, b.id] : [b.id, a.id],
        confidence,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small lexical helpers (mirrors the conservative pieces in
// `relationship.ts`; the detector does not import from there
// so the modules stay decoupled and replaceable.)
// ---------------------------------------------------------------------------

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

function hasNegationMarker(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (raw.length === 0) continue;
    if (NEGATION_MARKERS.has(raw)) return true;
  }
  return false;
}

/**
 * Jaccard overlap of two token lists, computed on token
 * *multisets* (so repeated words count). Returns a value in
 * `[0, 1]`. Mirrors the helper in `relationship.ts`; not
 * imported to keep the two modules replaceable independently.
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

function sortAsc(ids: readonly [number, number] | readonly number[]): number[] {
  const arr = [...ids];
  arr.sort((x, y) => x - y);
  return arr;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Defensive structural check on an `unknown` value to confirm
 * it is a `SafeMemorySummary`-shaped object. Mirrors the
 * helper in `relationship.ts`; not imported to keep the two
 * modules replaceable.
 */
function isSafeMemorySummaryWithRelationship(
  v: unknown,
): v is SafeMemorySummaryWithRelationship {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isFinite(o.id)) return false;
  if (typeof o.summary !== "string") return false;
  if (typeof o.state !== "string") return false;
  if (!Array.isArray(o.tags)) return false;
  // `relationship` is optional. When present, it must be an
  // object; anything else is a malformed projection and the
  // row is treated as having no relationship block.
  if (o.relationship !== undefined) {
    if (typeof o.relationship !== "object" || o.relationship === null) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public-message note formatter (Phase D, spec §5.4)
// ---------------------------------------------------------------------------

/**
 * Hard cap on the length of the public ambiguity note.
 *
 * The note is a *prefix on the public message only*; the
 * underlying synthesized answer is unchanged. A small cap
 * keeps the public surface calm and bounded even if the
 * detector ever fires on a long id list.
 *
 * Mirrors the spec's 240-char guidance. Exported for tests.
 */
export const AMBIGUITY_NOTE_MAX_LENGTH = 240;

/**
 * Render a conservative, bounded, human-readable note from a
 * `kind: "ambiguous"` `AmbiguitySignal`.
 *
 * Properties (mirrors `detectAmbiguity` and
 * `deriveRelationshipMetadata`):
 *
 *   - **Pure.** No I/O, no clock reads, no provider calls,
 *     no storage access, no mutation of the input.
 *   - **Deterministic.** For the same input, the output is
 *     byte-stable across calls.
 *   - **Bounded.** The returned string is at most
 *     `AMBIGUITY_NOTE_MAX_LENGTH` characters.
 *   - **No raw text.** The function never references any
 *     "raw" / "input" / "query" / "answer" field; only safe
 *     summary fields and the validated answer text are
 *     read by the *detector* (the note itself never reads
 *     answer text).
 *   - **No public memory ids.** The note never includes
 *     memory ids. The detector's `memoryIds` array remains
 *     an internal field on `AmbiguitySignal`; it is observed
 *     by tests and any future structured-content transport,
 *     but it is **not** serialized into the public MCP
 *     `text` content block. The user-facing note names the
 *     condition (disagreement / older variant possibility)
 *     without leaking internal id references.
 *   - **Conservative wording.** The note flags the
 *     disagreement or the older-variant possibility. It
 *     does not claim a current truth, does not pick a
 *     "winner" between disagreeing candidates, and does not
 *     claim a paraphrase relationship as a fact.
 *   - **No diagnostic leakage.** The note never exposes
 *     `detectionConfidence`, `derivedAt`,
 *     `derivedSchemaVersion`, or any other internal field.
 *
 * Behaviour:
 *
 *   - `kind: "none"` (or any non-`ambiguous` signal, or
 *     `null` / `undefined` defensively) returns the empty
 *     string. The tool layer treats the empty string as
 *     "no note: do not prefix the public message".
 *   - `kind: "ambiguous", reason: "conflicting-candidates"`
 *     returns a short line that flags the disagreement.
 *   - `kind: "ambiguous", reason: "older-variant-suspected"`
 *     returns a short, softer line that flags the
 *     older-variant possibility. The wording is
 *     deliberately softer ("may include") because the
 *     detector can only *suspect* a paraphrase relationship
 *     from the stored relationship block; it has not
 *     re-derived the paraphrase itself.
 *
 * The function never throws. Any malformed input collapses
 * to the empty string.
 */
export function formatAmbiguityNote(signal: AmbiguitySignal | null | undefined): string {
  if (signal === null || signal === undefined) return "";
  if (typeof signal !== "object") return "";
  if (signal.kind !== "ambiguous") return "";
  const reason = signal.reason;
  if (reason !== "conflicting-candidates" && reason !== "older-variant-suspected") {
    return "";
  }
  // The public note is prose only. The signal's `memoryIds`
  // array is internal-only: it is preserved on the typed
  // signal for tests and any future structured-content
  // transport, but it is NEVER serialized into the public
  // MCP `text` content block. We do still validate that
  // the field is an array (defensive — a non-array value is
  // a malformed signal and collapses to the empty string).
  // Garbage entries inside a valid array (NaN, negatives,
  // non-finite, non-integers) are filtered out at the
  // detector layer; with no ids rendered, a garbled id
  // can never reach the public surface.
  if (!Array.isArray(signal.memoryIds)) return "";
  const prefix =
    reason === "conflicting-candidates"
      ? "Note: stored memories on this topic disagree."
      : "Note: stored memories on this topic may include older variants.";
  if (prefix.length <= AMBIGUITY_NOTE_MAX_LENGTH) return prefix;
  // Defensive truncation: keep the note within the bound
  // even if the prose grew unexpectedly in a future
  // revision. The truncation must be deterministic and
  // must keep an ellipsis so the caller can see the note
  // was cut.
  return `${prefix.slice(0, AMBIGUITY_NOTE_MAX_LENGTH - 1).trimEnd()}…`;
}
