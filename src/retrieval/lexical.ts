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

/**
 * Suffix-stripping tokenizer for the benchmark-only stemmed variant.
 *
 * Pipeline:
 *   1. Run the existing `tokenize(text)` so the input is
 *      lowercased, split on non-alphanumeric runs, and pre-filtered
 *      for short tokens, pure-digit tokens, and the original
 *      STOP_WORDS set.
 *   2. For each surviving token `w` with `w.length >= 5`, apply
 *      the suffix-strip regex
 *        /(?:ingly|edly|ing|ed|ies|ied|ly|s)$/
 *      The alternation is ordered longest-first so the first
 *      match wins ("stopped" -> "stopp", "friendly" -> "friend").
 *   3. Filter the result:
 *        - drop the empty string (the strip removed everything);
 *        - drop tokens shorter than 3 characters (a stemmer
 *          that leaves 1-2 chars is not producing a content
 *          token; this also catches cases like "using" -> "us");
 *        - re-check the STOP_WORDS set so a stem does not
 *          resurrect a stopword (e.g. "use" -> "use" is still
 *          a stopword; "having" -> "have" is a stopword).
 *
 * The function is intentionally a sibling of `tokenize`, not a
 * modification of it. The production `rankLexical` and all other
 * production code in this module continue to use `tokenize`.
 * This sibling is consumed only by the benchmark variant in
 * `src/benchmark/variants/lexical-stemmed.ts`.
 *
 * Determinism: same input -> same output. The regex is greedy
 * on the first alternative that matches the end of the string;
 * there is no randomness, no model, no state.
 */
export function tokenizeStemmed(text: string): string[] {
  if (typeof text !== "string") return [];
  const stemRe = /(?:ingly|edly|ing|ed|ies|ied|ly|s)$/;
  const out: string[] = [];
  for (const raw of tokenize(text)) {
    // Length guard: only strip when the token is long enough
    // that a 2-5 character suffix removal still leaves a
    // plausible content word. The spec pins the guard at 5.
    const stemmed = raw.length >= 5 ? raw.replace(stemRe, "") : raw;
    if (stemmed.length === 0) continue;
    // After the strip a token can shrink to 1-2 chars (e.g.
    // "using" -> "us", "goes" -> "goe"). Those are not content
    // tokens and must not contribute to overlap. This mirrors
    // the original tokenize's `length < 3` floor.
    if (stemmed.length < 3) continue;
    // Re-check the stopword set so a stem cannot resurrect a
    // stopword. Example: "use" survives tokenize but is in
    // STOP_WORDS, so it is still dropped here.
    if (STOP_WORDS.has(stemmed)) continue;
    out.push(stemmed);
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
