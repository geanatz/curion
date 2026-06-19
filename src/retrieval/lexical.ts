/**
 * Minimal lexical ranking for the recall MVP.
 *
 * Goals:
 *   - Deterministic. Same input -> same output, every time.
 *   - Small and self-contained. No embeddings, no FTS, no vector math.
 *   - Defensible threshold. A near-zero overlap should not pass.
 *
 * Algorithm:
 *   1. Tokenize the query and the candidate summary into normalized
 *      word tokens. Tokens are lowercased, stripped of punctuation,
 *      and must be at least 3 characters of letters/digits to count.
 *   2. Score each candidate with the union of:
 *      a) Jaccard-style overlap: |Q ∩ C| / |Q| (recall-style, favors
 *         covering the query terms even if the candidate is long).
 *      b) An exact-phrase boost: if any 2-token window from the
 *         query appears verbatim in the candidate (case-insensitive,
 *         whitespace-normalized), the candidate gets a fixed bump.
 *   3. Filter to candidates whose score is >= the threshold.
 *   4. Sort by score descending, then by id descending (newer wins ties).
 *
 * This is intentionally NOT a proper BM25 / TF-IDF implementation.
 * The MVP is small, deterministic, and easy to reason about. Future
 * phases can swap this for a real variant (see `retrieval/variants.ts`)
 * without changing the controller's interface.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LexicalCandidate {
  /** Stable id (memory id). */
  id: number;
  /** Text to match against the query. */
  text: string;
  /** Optional pre-computed tags to include in the match. */
  tags?: string[];
}

export interface LexicalScoredCandidate {
  id: number;
  /** Score in [0, 1+]. Higher is more relevant. */
  score: number;
}

export interface LexicalRankingOptions {
  /** Minimum score to keep a candidate. Default 0.2. */
  threshold?: number;
  /** Maximum number of returned candidates. Default 5. */
  topK?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default relevance threshold. */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.2;

/** Default top-K. */
export const DEFAULT_TOP_K = 5;

/**
 * Minimum number of overlap tokens a candidate must have to pass,
 * regardless of the score. This guards against very short query /
 * candidate pairs that share a single incidental common word (e.g.
 * "the project uses Postgres" vs "the project team drinks tea"
 * share "project" — 1/3 = 0.33, which is above the 0.2 threshold
 * but is clearly not the same topic). The default of `1` keeps
 * the ranker honest: it requires at least one content word to
 * match. Tests that want stricter behavior can raise this.
 */
export const MIN_OVERLAP_TOKENS = 1;

/**
 * Exact-phrase boost added to a candidate's score when any 2-token
 * window from the query appears verbatim in the candidate. The boost
 * is small enough that pure token overlap still drives ordering, but
 * large enough to break ties between near-equivalent overlap
 * candidates.
 */
export const EXACT_PHRASE_BOOST = 0.2;

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into normalized word tokens.
 *
 * Rules:
 *   - Lowercase.
 *   - Split on any non-alphanumeric run.
 *   - Drop tokens shorter than 3 characters or that are pure digits
 *     (we don't want years / numbers to dominate the overlap).
 *   - Drop the small English stop-word set below.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any",
  "can", "had", "her", "was", "one", "our", "out", "day", "get",
  "has", "him", "his", "how", "man", "new", "now", "old", "see",
  "two", "way", "who", "boy", "did", "its", "let", "put", "say",
  "she", "too", "use", "this", "that", "with", "from", "have",
  "they", "their", "there", "what", "when", "your", "were", "been",
  "will", "would", "could", "should", "about", "into", "than",
  "then", "them", "these", "those", "because", "where", "which",
  "while", "whom", "ever", "very", "just", "also", "into", "over",
  "such", "some", "only", "more", "most", "other", "than", "each",
]);

export function tokenize(text: string): string[] {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (/^\d+$/.test(raw)) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute the lexical score and overlap count for a single
 * candidate against a query.
 *
 * Returns `{ score, overlap }` where:
 *   - `score` is in [0, 1+]. Higher is more relevant.
 *     - 0 means no overlap at all.
 *     - Up to 1 means perfect token coverage of the query.
 *     - > 1 means the candidate also contains an exact-phrase
 *       match (boost of `EXACT_PHRASE_BOOST`).
 *   - `overlap` is the absolute count of query tokens that appear
 *     in the candidate. The ranker uses this to enforce a
 *     `MIN_OVERLAP_TOKENS` floor so a single shared word
 *     (e.g. "project") never passes the threshold.
 */
export function scoreCandidateDetailed(
  query: string,
  candidateText: string,
): { score: number; overlap: number } {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { score: 0, overlap: 0 };
  const cTokens = tokenize(candidateText);
  if (cTokens.length === 0) return { score: 0, overlap: 0 };
  const cSet = new Set(cTokens);
  let overlap = 0;
  for (const t of qTokens) {
    if (cSet.has(t)) overlap += 1;
  }
  if (overlap === 0) return { score: 0, overlap: 0 };
  const recall = overlap / qTokens.length;
  let score = recall;
  // Exact-phrase boost: look for a 2-token window from the query
  // that appears verbatim in the candidate's tokens.
  if (qTokens.length >= 2 && hasExactPhraseMatch(qTokens, cTokens)) {
    score += EXACT_PHRASE_BOOST;
  }
  return { score, overlap };
}

/**
 * Compute the lexical score for a single candidate against a query.
 *
 * Returns 0..1+ where:
 *   - 0 means no overlap at all.
 *   - Up to 1 means perfect token coverage of the query.
 *   - > 1 means the candidate also contains an exact-phrase match
 *     (boost of `EXACT_PHRASE_BOOST`).
 *
 * Exported for unit testing. The ranking helper below uses
 * `scoreCandidateDetailed` to also enforce the minimum-overlap
 * floor.
 */
export function scoreCandidate(query: string, candidateText: string): number {
  return scoreCandidateDetailed(query, candidateText).score;
}

function hasExactPhraseMatch(
  qTokens: string[],
  cTokens: string[],
): boolean {
  // Build a set of every 2-token window in the candidate for O(1) lookup.
  const cWindows = new Set<string>();
  for (let i = 0; i + 1 < cTokens.length; i++) {
    cWindows.add(`${cTokens[i]} ${cTokens[i + 1]}`);
  }
  for (let i = 0; i + 1 < qTokens.length; i++) {
    if (cWindows.has(`${qTokens[i]} ${qTokens[i + 1]}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank candidates by lexical score against the query and return the
 * top-K that pass the threshold.
 *
 * Deterministic: ties on score are broken by descending id (newer
 * memory wins). The input candidates are never mutated.
 *
 * Returns an empty array if:
 *   - the query tokenizes to zero tokens, OR
 *   - no candidate reaches the threshold.
 */
export function rankLexical(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: LexicalRankingOptions = {},
): LexicalScoredCandidate[] {
  const threshold = options.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const q = typeof query === "string" ? query : "";
  const qTokens = tokenize(q);
  if (qTokens.length === 0) return [];

  // Pre-compute the candidate's match text once (summary + tags).
  const scored: LexicalScoredCandidate[] = [];
  for (const c of candidates) {
    const matchText =
      typeof c.text === "string" && c.text.length > 0
        ? c.text
        : "";
    const tagPart =
      Array.isArray(c.tags) && c.tags.length > 0
        ? ` ${c.tags.join(" ")}`
        : "";
    const { score, overlap } = scoreCandidateDetailed(
      q,
      `${matchText}${tagPart}`,
    );
    // Apply both the threshold and the minimum-overlap floor.
    // A single shared stopword-y token (e.g. "project") is not
    // enough evidence that the candidate is about the same
    // topic; we require at least MIN_OVERLAP_TOKENS shared
    // content words.
    if (score >= threshold && overlap >= MIN_OVERLAP_TOKENS) {
      scored.push({ id: c.id, score });
    }
  }
  // Sort: score desc, then id desc (newer memory wins ties).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });
  return scored.slice(0, topK);
}
