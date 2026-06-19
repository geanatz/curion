/**
 * Benchmark-only lexical retrieval variant with light suffix stemming.
 *
 * Why this exists:
 *   The lexical baseline in `src/retrieval/lexical.ts` is a small
 *   hand-rolled token-overlap ranker. It is deterministic and easy
 *   to reason about, but it has a well-known weakness: inflection
 *   brittleness. A query that uses "running" will not match a
 *   candidate that uses "run", and a query that uses "friendly"
 *   will not match a candidate that uses "friend". This module is
 *   the A/B test that adds a single-step suffix stemmer on top of
 *   the same Jaccard-style overlap score, while keeping every
 *   other property of the lexical ranker identical (threshold,
 *   top-K, tie-break, minimum-overlap floor).
 *
 * Scope (benchmark-only):
 *   - Exposes `rankLexicalStemmed(query, candidates, options)` that
 *     takes the same `LexicalCandidate` shape the lexical baseline
 *     uses and returns the same top-K shape (`{id, score}[]`).
 *   - Tokenizes both query and candidate text with
 *     `tokenizeStemmed` (the sibling of `tokenize` exported from
 *     `src/retrieval/lexical.ts`).
 *   - Scores with the same Jaccard-style overlap
 *     `|Q ∩ C| / |Q|` the production lexical ranker uses, with
 *     the same `MIN_OVERLAP_TOKENS` floor.
 *   - Does NOT touch the production `rankLexical` path. The
 *     controller still uses the unstemmed ranker; this variant
 *     is reachable only through the benchmark path.
 *
 * What this is NOT:
 *   - It is NOT wired into `recall(text)`. The production
 *     controller still uses `rankLexical` and the public MCP
 *     surface is unchanged.
 *   - It is NOT a proper Porter / Snowball stemmer. The strip is
 *     a single regex with a fixed suffix list; it is a cheap
 *     baseline, not a linguistic tool.
 *   - It is NOT an FTS5, vector, or dense ranker. It is a
 *     lexical ranker with a different tokenizer.
 *
 * Determinism:
 *   - `tokenizeStemmed` is deterministic (no randomness, no state,
 *     fixed regex). The overlap computation is a pure set
 *     intersection. Two runs against the same (query, corpus,
 *     threshold, top-K) produce the same top-K.
 *   - Ties on score are broken by descending id (newer memory
 *     wins), the same stability contract the lexical baseline
 *     uses.
 *
 * Score semantics:
 *   - Same as the lexical baseline: `|Q ∩ C| / |Q|` in [0, 1].
 *     Higher is better. No exact-phrase boost is added; the
 *     spec calls for pure Jaccard-overlap scoring on the
 *     stemmed tokens, and adding the boost would muddy the
 *     comparison with the unstemmed baseline.
 *
 * No-answer TNR:
 *   - A query that stems to zero tokens returns an empty array,
 *     matching the lexical baseline's no-answer path.
 *   - The `MIN_OVERLAP_TOKENS` floor (1) is applied so a single
 *     shared token (e.g. "project") never passes the threshold
 *     on its own, matching the lexical baseline.
 */

import { tokenizeStemmed } from "../../retrieval/lexical.js";
import {
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOP_K,
  MIN_OVERLAP_TOKENS,
} from "../../retrieval/lexical.js";
import type {
  LexicalCandidate,
  LexicalScoredCandidate,
  LexicalRankingOptions,
} from "../../retrieval/lexical.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the stemmed lexical ranker. Extends
 * `LexicalRankingOptions` so the threshold and top-K defaults
 * match the production lexical ranker exactly. There is no
 * variant-specific option today; the interface is kept open
 * for future tweaks (e.g. a different minimum-overlap floor).
 */
export interface LexicalStemmedRankingOptions extends LexicalRankingOptions {}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute the stemmed lexical score and overlap count for a
 * single candidate against a query.
 *
 * Returns `{ score, overlap }` where:
 *   - `score` is `|Q ∩ C| / |Q|` in [0, 1]. 0 means no
 *     overlap after stemming. The ranker applies the threshold
 *     and the `MIN_OVERLAP_TOKENS` floor on top of this.
 *   - `overlap` is the absolute count of query stems that
 *     appear in the candidate stems. Used by the ranker to
 *     enforce the minimum-overlap floor.
 *
 * Exposed for unit testing; the ranking helper below uses
 * the same computation.
 */
export function scoreStemmedCandidateDetailed(
  query: string,
  candidateText: string,
): { score: number; overlap: number } {
  const qTokens = tokenizeStemmed(query);
  if (qTokens.length === 0) return { score: 0, overlap: 0 };
  const cTokens = tokenizeStemmed(candidateText);
  if (cTokens.length === 0) return { score: 0, overlap: 0 };
  const cSet = new Set(cTokens);
  let overlap = 0;
  for (const t of qTokens) {
    if (cSet.has(t)) overlap += 1;
  }
  if (overlap === 0) return { score: 0, overlap: 0 };
  return { score: overlap / qTokens.length, overlap };
}

/**
 * Compute the stemmed lexical score for a single candidate
 * against a query. Convenience wrapper around
 * `scoreStemmedCandidateDetailed`; the ranker uses the detailed
 * form so it can also enforce the minimum-overlap floor.
 */
export function scoreStemmedCandidate(
  query: string,
  candidateText: string,
): number {
  return scoreStemmedCandidateDetailed(query, candidateText).score;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank candidates by stemmed-token overlap against the query
 * and return the top-K that pass the threshold.
 *
 * The function is the stemmed counterpart of
 * `src/retrieval/lexical.ts:rankLexical`. The shape contract
 * is identical: `{id, score}[]`, score desc, id desc tie-break,
 * threshold respected, top-K cap respected. The only
 * difference is the tokenizer: this function uses
 * `tokenizeStemmed` for both query and candidate text, so a
 * query that uses "friendly" matches a candidate that uses
 * "friend" (and vice versa).
 *
 * Behavior:
 *   - A query that stems to zero tokens returns an empty array,
 *     matching the lexical baseline's no-answer path.
 *   - The `MIN_OVERLAP_TOKENS` floor is applied so a single
 *     shared stem never passes the threshold on its own.
 *   - Ties on score are broken by descending id (newer memory
 *     wins), matching the lexical stability contract.
 *
 * The function is synchronous and side-effect-free. It does
 * not open, read, or write the project storage. It is
 * benchmark-only; the production `recall(text)` controller
 * still uses the unstemmed `rankLexical`.
 */
export function rankLexicalStemmed(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: LexicalStemmedRankingOptions = {},
): LexicalScoredCandidate[] {
  return rankLexicalStemmedInner(query, candidates, options);
}

// The inner worker lives below so the public function stays
// at the top of the file for readability. The threshold /
// topK / min-overlap constants are imported from the lexical
// module above to keep the two rankers in lockstep.
function rankLexicalStemmedInner(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: LexicalStemmedRankingOptions,
): LexicalScoredCandidate[] {
  const threshold = options.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const q = typeof query === "string" ? query : "";
  // Short-circuit on a zero-stem query. The stemmed ranker
  // inherits the lexical baseline's "no query -> no results"
  // contract: an empty top-K is the only honest answer when
  // the query produced no content stems.
  if (tokenizeStemmed(q).length === 0) return [];

  // Pre-compute the candidate's match text once (summary +
  // tags). The construction matches `rankLexical` exactly so
  // the two rankers agree on what counts as "the match text"
  // for a candidate.
  const scored: LexicalScoredCandidate[] = [];
  for (const c of candidates) {
    const matchText =
      typeof c.text === "string" && c.text.length > 0 ? c.text : "";
    const tagPart =
      Array.isArray(c.tags) && c.tags.length > 0
        ? ` ${c.tags.join(" ")}`
        : "";
    const { score, overlap } = scoreStemmedCandidateDetailed(
      q,
      `${matchText}${tagPart}`,
    );
    if (score >= threshold && overlap >= MIN_OVERLAP_TOKENS) {
      scored.push({ id: c.id, score });
    }
  }
  // Stable order: score desc, then id desc. Mirrors the
  // lexical ranker tie-break (newer memory wins).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });
  return scored.slice(0, topK);
}
