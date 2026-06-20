/**
 * Conservative supersession detector for the remember flow.
 *
 * Pure, deterministic, offline helper — no I/O, no provider calls,
 * no clock reads, no mutation of inputs.
 *
 * Purpose: when `remember` is called with text that explicitly
 * supersedes an older related memory (e.g. "no longer use X, use Y;
 * replaced by; superseded by; new policy overrides old policy"), this
 * detector identifies the superseded id(s) and emits a bounded
 * `SupersessionSignal` so the controller can write bidirectional
 * metadata:
 *
 *   - new memory:  `supersedes: [oldId, ...]`
 *   - old memory:  `supersededBy: [newId, ...]`
 *
 * The recall demotion helper (`demoteSupersededMemories`) then uses
 * that metadata to rank the current memory above the stale one.
 *
 * Design constraints (conservative, spec §9.2):
 *
 *   1. **Explicit replacement language required.** The detector
 *      fires only on high-confidence supersession phrasings:
 *      "no longer use X", "use Y instead", "replaced by",
 *      "supersedes / superseded by", "previous X is superseded",
 *      "new policy overrides old policy", "do not use X, use Y".
 *      Ambiguous language ("we decided to change" without an
 *      explicit override) returns no signal.
 *
 *   2. **Strong topical overlap required.** Even with explicit
 *      supersession language, the candidate and the related memory
 *      must share enough tokens (Jaccard >= `MIN_OVERLAP_FOR_SUPERSESSION`)
 *      to be considered about the same topic. This prevents a
 *      sentence like "we no longer use Jira, we use Linear now"
 *      from incorrectly claiming to supersede an unrelated memory
 *      about "Jira for bug tracking".
 *
 *   3. **Earlier-id rule.** The candidate must have a *higher* id
 *      than the related memory it supersedes (newer supersedes
 *      older). This is the same directional invariant the
 *      `olderVariantsOf` rule uses and prevents a newer memory
 *      from claiming to supersede a memory that did not yet exist.
 *
 *   4. **If uncertain, return no signal.** The default is silent.
 *      The bar is intentionally high: false-positive supersession
 *      metadata would incorrectly demote a valid current memory.
 *
 *   5. **No raw text inspection.** Only `memoryContent` (the
 *      controller-normalized safe summary) is read.
 *
 * No state transition is performed. Memories stay `active`. The
 * detector only emits metadata; the controller is responsible for
 * writing it and for patching the old row's `supersededBy` field.
 */

import { tokenize } from "./lexical.js";
import type { SafeMemorySummary } from "../storage/storage.js";

// ---------------------------------------------------------------------------
// Thresholds and constants (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Minimum Jaccard token overlap between the candidate and a
 * related memory required to consider the supersession claim
 * topically credible.
 *
 * Set to 0.5 (50% token overlap). This is lower than the
 * `conflictsWith` threshold (0.6) because supersession language
 * is a much stronger signal than mere topic overlap — but we
 * still require meaningful shared content to avoid a
 * "no longer use Postgres, use SQLite" claim superseding a
 * memory about "Redis caching".
 */
export const MIN_OVERLAP_FOR_SUPERSESSION = 0.5;

/**
 * Minimum number of shared content tokens (after stop-word
 * filtering) required alongside the supersession phrasings.
 * This is a secondary anchor check that fires only when the
 * Jaccard is close to the threshold.
 */
export const MIN_SHARED_CONTENT_TOKENS = 2;

/**
 * Hard cap on superseded ids emitted per call. Per spec §6,
 * all id arrays are bounded to 16.
 */
export const MAX_SUPERSEDED_IDS = 16;

// ---------------------------------------------------------------------------
// Supersession signal
// ---------------------------------------------------------------------------

/**
 * Result of scanning a single candidate/other pair for
 * supersession signals. Returned by `scoreSupersessionSignal`.
 */
export interface SupersessionSignal {
  /**
   * Ids of memories the candidate supersedes. Sorted ascending.
   * At most `MAX_SUPERSEDED_IDS` entries.
   */
  supersededIds: number[];
  /**
   * Highest per-rule confidence used this call, in `[0, 1]`.
   * `0` when no rule fired.
   */
  confidence: number;
}

/**
 * Input to the supersession detection pass.
 */
export interface SupersessionDetectionInput {
  /**
   * The candidate memory (the one being remembered now).
   * Only `id`, `memoryContent`, `tags` are inspected.
   */
  candidate: SafeMemorySummary;
  /**
   * Related active memories to compare against. Only those with
   * `id < candidate.id` are considered (newer supersedes older).
   */
  others: readonly SafeMemorySummary[];
}

// ---------------------------------------------------------------------------
// Supersession phrase patterns
//
// Each pattern is a [regex, polarity, confidence-boost] tuple.
//
// polarity:
//   +1  → candidate claims to supersede the other
//   -1  → candidate claims to be superseded by the other
//
// confidence-boost: fixed additive bonus when the phrase matches.
// Total confidence = overlap-base + phrase-bonus, clamped to [0, 1].
// The overlap base is the Jaccard between candidate and other tokens,
// in the range [MIN_OVERLAP_FOR_SUPERSESSION, 1.0] when the function
// is called (callers must already have verified the minimum overlap).
// ---------------------------------------------------------------------------

interface PhrasePattern {
  regex: RegExp;
  /** +1 = candidate supersedes other; -1 = candidate is superseded by other */
  polarity: 1 | -1;
  /** Fixed confidence bonus on top of the overlap base */
  boost: number;
}

/**
 * Supersession phrasings the detector recognises.
 *
 * All patterns are case-insensitive. The regexes are anchored
 * internally so they match a phrase boundary, not an arbitrary
 * substring inside an unrelated word.
 *
 * Polarity convention (matches `supersedes` / `supersededBy` field
 * naming on the `RelationshipMetadataFields` type):
 *   - polarity = +1  → candidate.supersedes = [other.id]  (candidate is newer/better)
 *   - polarity = -1  → candidate.supersededBy = [other.id] (candidate is stale)
 *
 * The caller handles the direction: this function returns signals
 * with `polarity === +1` when the candidate claims to supersede the
 * other, and the caller writes `supersedes`. The `other.id` is
 * always the "old" memory being superseded.
 */
const SUPERSESSION_PATTERNS: readonly PhrasePattern[] = [
  // "X supersedes Y" / "X is superseded by Y"
  // These are the canonical forms; check them first.
  {
    regex: /\bsupersedes\b/i,
    polarity: 1,
    boost: 0.40,
  },
  {
    regex: /\bsuperseded\s+by\b/i,
    polarity: -1,
    boost: 0.40,
  },

  // "X is replaced by Y" / "X replaces Y"
  {
    regex: /\bis\s+replaced\s+by\b/i,
    polarity: -1,
    boost: 0.40,
  },
  {
    regex: /\breplaces?\b/i,
    polarity: 1,
    boost: 0.35,
  },

  // "no longer use X, use Y instead" / "do not use X, use Y"
  // polarity +1: candidate is "use Y" (the new correct thing)
  // polarity -1: candidate is "X" (the old wrong thing — rare in candidates)
  // We handle the +1 case (new memory says "use new thing") via the
  // general negation+instead pattern below.

  // "instead of X, use Y" / "use Y instead of X"
  {
    regex: /\buse\s+\w+\s+instead\s+(?:of\s+)?\w+/i,
    polarity: 1,
    boost: 0.35,
  },

  // "do not use X" (strong deprecation marker; candidate is the NEW thing)
  {
    regex: /\bdo\s+not\s+use\b/i,
    polarity: 1,
    boost: 0.30,
  },
  {
    regex: /\bdon'?t\s+use\b/i,
    polarity: 1,
    boost: 0.30,
  },

  // "no longer use X" (explicit deprecation)
  {
    regex: /\bno\s+longer\s+use\b/i,
    polarity: 1,
    boost: 0.35,
  },

  // "previous X is superseded" / "previous policy is superseded"
  {
    regex: /\bprevious\s+\w+\s+is\s+superseded\b/i,
    polarity: 1,
    boost: 0.40,
  },

  // "new policy overrides old policy"
  {
    regex: /\boverrides?\b/i,
    polarity: 1,
    boost: 0.35,
  },

  // "old X is deprecated" / "X is deprecated, use Y"
  {
    regex: /\bis\s+deprecated\b/i,
    polarity: 1,
    boost: 0.25,
  },

  // "move from X to Y" / "migrated from X to Y"
  {
    regex: /\bmigrated?\s+from\s+\w+\s+to\s+\w+/i,
    polarity: 1,
    boost: 0.30,
  },
  {
    regex: /\bmove[sd]?\s+from\s+\w+\s+to\s+\w+/i,
    polarity: 1,
    boost: 0.30,
  },

  // "switched from X to Y"
  {
    regex: /\bswitched?\s+from\s+\w+\s+to\s+\w+/i,
    polarity: 1,
    boost: 0.30,
  },
];

// ---------------------------------------------------------------------------
// Pure detection entry point
// ---------------------------------------------------------------------------

/**
 * Scan the candidate's `memoryContent` for explicit supersession
 * language against the related memories in `others`.
 *
 * Returns `null` when no supersession signal is strong enough to
 * emit a credible claim. The default is silent (conservative).
 *
 * Properties:
 *   - Pure. No side effects, no I/O, no clock reads.
 *   - Deterministic. Same inputs -> same output.
 *   - Non-mutating.
 *   - Returns `null` (no signal) for ambiguous or unrelated pairs.
 *
 * @param input - `{ candidate, others }` as defined above.
 * @returns A `SupersessionSignal` with `supersededIds: []` when
 *          no confident supersession is detected, or a non-empty
 *          `supersededIds` array when at least one related memory
 *          is confidently superseded.
 */
export function detectSupersession(
  input: SupersessionDetectionInput,
): SupersessionSignal | null {
  const { candidate, others } = input;

  // Fast path: if the candidate memoryContent is empty, no signal.
  if (!candidate.memoryContent || candidate.memoryContent.trim().length === 0) {
    return null;
  }

  // Collect candidates with enough topical overlap.
  // We compute token sets once per candidate and reuse them.
  const candidateTokens = tokenize(candidate.memoryContent);
  if (candidateTokens.length === 0) return null;

  const candidateContentTokens = contentTokens(candidateTokens);

  const supersededIds: number[] = [];
  let maxConfidence = 0;

  for (const other of others) {
    if (!isSafeMemorySummary(other)) continue;
    if (other.id === candidate.id) continue;
    if (other.state !== "active") continue;
    // Directional rule: newer supersedes older.
    if (other.id >= candidate.id) continue;

    const otherTokens = tokenize(other.memoryContent);
    if (otherTokens.length === 0) continue;

    // ---- Topical anchor: Jaccard overlap must be high enough ----
    const overlap = jaccard(candidateTokens, otherTokens);
    if (overlap < MIN_OVERLAP_FOR_SUPERSESSION) continue;

    // Secondary shared-content check: when overlap is marginal,
    // require a minimum number of shared content tokens.
    const sharedContent = intersectCount(
      candidateContentTokens,
      contentTokens(otherTokens),
    );
    if (
      overlap < MIN_OVERLAP_FOR_SUPERSESSION + 0.1 &&
      sharedContent < MIN_SHARED_CONTENT_TOKENS
    ) {
      continue;
    }

    // ---- Scan for supersession phrasing ----
    const result = scanForSupersessionPhrasing(
      candidate.memoryContent,
      other.memoryContent,
      overlap,
    );
    if (result === null) continue;

    // ---- Polarity check ----
    // polarity +1: candidate claims to supersede other.
    // polarity -1: candidate claims to be superseded by other (rare in
    // a new candidate memory; we still record it but only when the
    // phrasing is unambiguous).
    if (result.polarity !== 1) continue;

    supersededIds.push(other.id);
    if (result.confidence > maxConfidence) {
      maxConfidence = result.confidence;
    }
    if (supersededIds.length >= MAX_SUPERSEDED_IDS) break;
  }

  if (supersededIds.length === 0) {
    return null;
  }

  // Sort ascending for deterministic output.
  supersededIds.sort((a, b) => a - b);

  return {
    supersededIds,
    confidence: clamp01(maxConfidence),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan candidate text for supersession phrasing.
 * Returns null if no supersession language is found.
 */
function scanForSupersessionPhrasing(
  candidateText: string,
  _otherText: string,
  overlap: number,
): { polarity: 1 | -1; confidence: number } | null {
  for (const pattern of SUPERSESSION_PATTERNS) {
    if (pattern.regex.test(candidateText)) {
      // Combine the overlap base with the phrase boost.
      // overlap is in [MIN_OVERLAP_FOR_SUPERSESSION, 1.0] here.
      const confidence = Math.min(1, overlap + pattern.boost);
      return { polarity: pattern.polarity, confidence };
    }
  }
  return null;
}

/**
 * Jaccard overlap on token multisets.
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

/**
 * Count shared content tokens between two token lists.
 * Filters out short tokens (< 3 chars) that are likely stop words.
 */
function intersectCount(a: readonly string[], b: readonly string[]): number {
  const setB = new Set(b);
  let n = 0;
  const seen = new Set<string>();
  for (const t of a) {
    if (seen.has(t)) continue;
    if (t.length < 3) continue; // skip short/stop-word tokens
    seen.add(t);
    if (setB.has(t)) n += 1;
  }
  return n;
}

/**
 * Extract content tokens (>= 3 chars) from a token list.
 */
function contentTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => t.length >= 3);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Minimal structural check on an `unknown` value to confirm
 * it is a `SafeMemorySummary`-shaped object. Defensive boundary.
 */
function isSafeMemorySummary(v: unknown): v is SafeMemorySummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isFinite(o.id)) return false;
  if (typeof o.memoryContent !== "string") return false;
  if (typeof o.state !== "string") return false;
  if (!Array.isArray(o.tags)) return false;
  return true;
}