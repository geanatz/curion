/**
 * Superseded-memory demotion helper.
 *
 * Pure production-path helper for the recall controller.
 * When a stale/superseded memory and its superseding counterpart
 * are both active candidates in the ranked list, the stale one
 * is demoted so the superseding candidate ranks higher.
 *
 * Properties:
 *   - Pure. No side effects, no I/O.
 *   - Deterministic. Same input -> same output.
 *   - Non-mutating. The input scored array is not modified.
 *   - No public API changes. Only internal ranking order changes.
 *
 * Demotion rule:
 *   When candidate A `supersedes` candidate B (A's relationship
 *   block carries `supersedes: [B]` or candidate B `supersededBy: [A]`),
 *   and both A and B are in the scored candidate list, B is demoted.
 *   The demotion multiplies B's score by `DEMOTION_FACTOR` (0.01),
 *   which reliably places the stale candidate below any non-stale
 *   candidate with a non-zero score. Relative order of non-stale
 *   candidates is preserved.
 *
 * Missing references are ignored safely: if A `supersedes` B but
 * B is not in the candidate set, no action is taken.
 */

import type { LexicalScoredCandidate } from "./lexical.js";

/**
 * The factor by which a superseded candidate's score is multiplied
 * when both the superseding and superseded candidates are present.
 * 0.01 means a superseded candidate with score 0.95 becomes 0.0095,
 * placing it below any candidate with score >= 0.01 (all passing
 * candidates have score >= the threshold, which is at least 0.2).
 */
export const DEMOTION_FACTOR = 0.01;

/**
 * Input shape for the demotion helper. Extends the scored candidate
 * with optional relationship metadata.
 */
export interface ScoredCandidateWithRelationship {
  id: number;
  score: number;
  /** Relationship metadata from the storage read. May be absent. */
  relationship?: {
    supersedes?: readonly number[];
    supersededBy?: readonly number[];
  };
}

/**
 * Apply superseded-memory demotion to a scored candidate list.
 *
 * When both a superseding candidate (A) and its superseded target (B)
 * are present in the scored list, B's score is multiplied by
 * `DEMOTION_FACTOR`, reliably placing it below all non-stale candidates.
 *
 * Relative order of non-stale candidates is preserved.
 * Missing supersession references are silently ignored.
 *
 * @param scored - Ranked candidates from `rankLexical`, with relationship
 *                 metadata attached from the storage read.
 * @returns A new scored array with stale candidates demoted. The input
 *          array is not modified.
 */
export function demoteSupersededMemories(
  scored: ReadonlyArray<ScoredCandidateWithRelationship>
): LexicalScoredCandidate[] {
  if (scored.length <= 1) {
    // No pair possible; return a defensive copy.
    return scored.map((c) => ({ id: c.id, score: c.score }));
  }

  // Build the candidate id set for O(1) membership checks.
  const candidateIds = new Set<number>();
  for (const c of scored) {
    candidateIds.add(c.id);
  }

  // Identify stale candidate ids: those that are superseded by another
  // candidate in the list.
  const staleIds = new Set<number>();
  for (const c of scored) {
    const rel = c.relationship;
    if (!rel) continue;

    // Case 1: c.supersedes = [otherIds]. If any otherId is also in
    // the candidate set, that otherId is stale (c is the superseding one).
    if (rel.supersedes) {
      for (const otherId of rel.supersedes) {
        if (typeof otherId !== "number" || !Number.isFinite(otherId)) continue;
        if (candidateIds.has(otherId)) {
          staleIds.add(otherId);
        }
      }
    }

    // Case 2: c.supersededBy = [otherIds]. If any otherId is also in
    // the candidate set, c is stale (otherId is the superseding one).
    if (rel.supersededBy) {
      for (const otherId of rel.supersededBy) {
        if (typeof otherId !== "number" || !Number.isFinite(otherId)) continue;
        if (candidateIds.has(otherId)) {
          staleIds.add(c.id);
        }
      }
    }
  }

  // Apply demotion: multiply stale candidates' scores by DEMOTION_FACTOR.
  // Build a new array (non-mutating).
  const result: LexicalScoredCandidate[] = scored.map((c) => {
    if (staleIds.has(c.id)) {
      return { id: c.id, score: c.score * DEMOTION_FACTOR };
    }
    return { id: c.id, score: c.score };
  });

  // Re-sort: score desc, then id desc (newer memory wins ties).
  // This preserves the lexical ranker's ordering for non-stale candidates
  // while placing demoted candidates at the bottom.
  result.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });

  return result;
}
