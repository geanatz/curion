/**
 * Benchmark-only FTS5 retrieval variant.
 *
 * Why this exists:
 *   The lexical baseline in `src/retrieval/lexical.ts` is a small
 *   hand-rolled token-overlap ranker. It is deterministic and easy
 *   to reason about, but it has well-known weaknesses (paraphrase
 *   brittleness, no stemming, no prefix matching, no real ranking
 *   model). SQLite ships with FTS5 — a purpose-built full-text
 *   engine with BM25 ranking, prefix queries, and a tokenizer.
 *   This module is the A/B test against the lexical baseline using
 *   the exact same corpus and query set.
 *
 * Scope (benchmark-only):
 *   - Loads the fixture corpus into an IN-MEMORY SQLite database
 *     (`":memory:"`). It does NOT open, read, or write the project
 *     `.curion/curion.sqlite` file.
 *   - Exposes a `rankFts5(query, candidates, options)` function
 *     that takes the same `LexicalCandidate` shape the lexical
 *     baseline uses and returns the same top-K shape
 *     (`{id, score}[]`).
 *   - Sanitizes the user query so FTS5 operator characters
 *     (`"`, `*`, `(`, `)`, `:`, `^`, `-`, `+`, `OR`, `AND`,
 *     `NOT`, `NEAR`) cannot blow up the FTS5 parser and so a
 *     query like `What is "Postgres" + CI?` does NOT get
 *     interpreted as a phrase + AND query.
 *
 * What this is NOT:
 *   - It is NOT wired into `recall(text)`. The production
 *     controller still uses `rankLexical` and the public MCP
 *     surface is unchanged. FTS5 is benchmark-only until
 *     evidence says it should replace lexical.
 *   - It is NOT a hybrid ranker. It is a single-variant
 *     comparison point.
 *   - It is NOT a vector / embedding search.
 *
 * Determinism:
 *   - `bm25()` in SQLite FTS5 is deterministic for a given index
 *     state. We rebuild the in-memory index from the same
 *     `BENCHMARK_RECORDS` on every call, so two runs against the
 *     same corpus + queries produce the same top-K.
 *
 * Score semantics:
 *   - FTS5 `bm25()` returns NEGATIVE numbers (lower = better).
 *     We invert and squash to a positive [0, 1]-ish score using
 *     `1 / (1 + |bm25|)`. The lexical baseline is
 *     `0..1+` (higher = better). Both are "higher is better" but
 *     they are NOT on the same scale. They are independent
 *     measurements. We keep both.
 */

import Database from "better-sqlite3";
import { tokenize } from "../../retrieval/lexical.js";
import type {
  LexicalCandidate,
  LexicalScoredCandidate,
  LexicalRankingOptions,
} from "../../retrieval/lexical.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the FTS5 ranker. Mirrors `LexicalRankingOptions`
 * but uses an FTS5-specific default. Kept separate so the
 * production lexical code does not need to know about FTS5.
 */
export interface Fts5RankingOptions extends LexicalRankingOptions {
  /**
   * Minimum score to keep a candidate. The FTS5 score is the
   * squashed `1 / (1 + |bm25|)` value, in (0, 1]. Default
   * `0` (no threshold) because FTS5's BM25 for a strong
   * match is typically a small positive number near 0.3..0.6
   * and the lexical default of 0.2 is a much stronger filter
   * than FTS5's natural separation between "match" and "no
   * match". The no-answer TNR metric only needs `topK` to be
   * respected; the threshold is therefore relaxed by default
   * for FTS5. Tests that want strict parity with the lexical
   * baseline can pass `threshold: 0.2` explicitly.
   */
  threshold?: number;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * FTS5 reserved tokens that the query parser interprets as
 * operators. We strip these so a user query that contains the
 * literal word "OR" or "AND" (common in technical questions) is
 * not treated as a boolean operator.
 */
const FTS5_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "AND", "OR", "NOT", "NEAR",
]);

/**
 * Build a safe FTS5 MATCH expression from a free-form user query.
 *
 * Strategy: tokenize the input using the SAME rules as the
 * lexical baseline (lowercase, drop stopwords, drop short tokens,
 * drop pure-digit tokens, drop non-alphanumeric runs), then wrap
 * each surviving token in double quotes to force FTS5 to treat
 * it as a literal term. Surviving tokens are joined with ` OR `.
 *
 * Why OR, not implicit AND:
 *   The lexical baseline scores with Jaccard-style overlap —
 *   a single shared token contributes to the score. FTS5's
 *   default implicit-AND MATCH would require EVERY token to
 *   appear in a candidate, which is much stricter than the
 *   lexical baseline and would silence most positive queries.
 *   Joining the sanitized tokens with `OR` matches the lexical
 *   baseline's "any overlap counts" semantics: a candidate is
 *   in the hit set if it contains at least one query term, and
 *   BM25 ranks them.
 *
 * Why this is safe:
 *   - Inside a double-quoted FTS5 string, almost no character has
 *     special meaning. Quotes themselves are escaped by doubling
 *     them (`""`). We strip any double quotes from the token
 *     before quoting, so the input never needs the escape.
 *   - The lexical tokenizer already drops punctuation, so
 *     operator characters like `*`, `:`, `(`, `)`, `^`, `-`, `+`
 *     are gone before we touch the string.
 *   - The reserved-word filter covers `AND` / `OR` / `NOT` /
 *     `NEAR`. FTS5 is case-insensitive for keywords, so we drop
 *     them in any case. A user query like
 *     "Postgres OR MySQL" loses the disjunction, but the
 *     explicit `OR` we add between sanitized terms is the
 *     intended semantics for a benchmark OR-style match.
 *
 * Returns an empty string iff there are no usable tokens. Callers
 * MUST treat an empty result as "no query" and return an empty
 * hit list.
 */
export function sanitizeFts5Query(query: string): string {
  const tokens = tokenize(query);
  const out: string[] = [];
  for (const t of tokens) {
    if (FTS5_RESERVED_WORDS.has(t.toUpperCase())) continue;
    // Defense in depth: even though tokenize strips
    // non-alphanumerics, a future token change could leak a
    // double-quote. Strip them here so the quoted form is
    // always well-formed.
    const clean = t.replace(/"/g, "");
    if (clean.length === 0) continue;
    out.push(`"${clean}"`);
  }
  return out.join(" OR ");
}

// ---------------------------------------------------------------------------
// In-memory index
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory FTS5 index for a candidate set.
 *
 * Each call returns a brand-new `:memory:` database. This is
 * intentionally NOT cached at module level: the index is tied to
 * the lifetime of a single benchmark run, and the in-memory
 * nature of the DB is part of the contract (no on-disk writes,
 * no shared state across calls).
 *
 * The schema is two tables:
 *   - `memories`  : the source of truth (id, summary, tags).
 *   - `memories_fts` : an FTS5 virtual table over summary + tags.
 *     We use the `unicode61` tokenizer (the default) so tokenization
 *     matches the lexical ranker closely enough that the comparison
 *     is about RANKING, not tokenization.
 *
 * Exposed for tests; the benchmark runner uses `rankFts5` below
 * and does not touch the index directly.
 */
export interface Fts5Index {
  readonly db: Database.Database;
  /** Number of documents (memories) loaded. */
  readonly size: number;
  /** Close the in-memory database. Idempotent. */
  close(): void;
}

export function buildFts5Index(
  candidates: ReadonlyArray<LexicalCandidate>,
): Fts5Index {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memories (
      id     INTEGER PRIMARY KEY,
      summary TEXT NOT NULL,
      tags    TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      memory_id UNINDEXED,
      summary,
      tags,
      tokenize = 'unicode61'
    );
  `);
  const insert = db.prepare(
    "INSERT INTO memories (id, summary, tags) VALUES (?, ?, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO memories_fts (memory_id, summary, tags) VALUES (?, ?, ?)",
  );
  // Wrap inserts in a transaction so the index is built atomically.
  // A partial index would be a real bug for the benchmark; the
  // transaction makes any failure all-or-nothing.
  const tx = db.transaction((rows: LexicalCandidate[]) => {
    for (const c of rows) {
      const summary = typeof c.text === "string" ? c.text : "";
      const tags = Array.isArray(c.tags) ? c.tags.join(" ") : "";
      insert.run(c.id, summary, tags);
      insertFts.run(c.id, summary, tags);
    }
  });
  tx([...candidates]);
  return {
    db,
    size: candidates.length,
    close(): void {
      try {
        db.close();
      } catch {
        // already closed; ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Convert an FTS5 BM25 score to the benchmark's
 * "higher is better, ~[0, 1]" convention.
 *
 * `bm25()` returns negative numbers where MORE NEGATIVE is
 * BETTER. To match the lexical baseline's "higher is better"
 * convention we negate, then squash to a positive value in
 * (0, 1] using `bm / (bm + k)`:
 *
 *   - bm = 0     (no match)         -> 0
 *   - bm = -1    (weak match)       -> 1 / (1 + k)  (small positive)
 *   - bm = -k    (medium match)     -> 0.5
 *   - bm = -inf  (perfect match)    -> 1
 *
 * `k` is a softening constant. We use 5 because BM25 values in
 * this corpus cluster between -1 and -8; k=5 maps that range
 * to roughly 0.17..0.62, leaving headroom for very strong
 * matches while keeping weak matches in the same scale. The
 * absolute value is not meaningful across corpora; it is a
 * per-rank monotonic transform that preserves ordering.
 */
export function normalizeFts5Score(bm25: number): number {
  if (!Number.isFinite(bm25)) return 0;
  // bm25 <= 0 always. Negate so a "stronger" match is a
  // larger positive number.
  const pos = -bm25;
  if (pos <= 0) return 0;
  const k = 5;
  return pos / (pos + k);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Default threshold for the FTS5 variant. The FTS5 squashed
 * score for a strong match is typically in the 0.2..0.7 range;
 * 0 means "no filter" and is the only value that keeps the
 * benchmark's no-answer TNR meaningful. See
 * `Fts5RankingOptions.threshold` for the rationale.
 */
export const DEFAULT_FTS5_THRESHOLD = 0;

/**
 * Rank candidates by FTS5 BM25 against the query and return the
 * top-K that pass the threshold.
 *
 * Behavior:
 *   - The query is sanitized through `sanitizeFts5Query`. A
 *     query with no usable tokens returns an empty array.
 *   - FTS5 may return zero hits (e.g. the corpus has no
 *     matching terms). The function then returns an empty
 *     array, matching the lexical baseline's no-answer path.
 *   - Ties on the squashed score are broken by ascending id,
 *     matching the lexical baseline's stability contract.
 *
 * The function is synchronous. The in-memory index is built
 * once per call; for the current benchmark corpus the cost is
 * well under a millisecond on a developer laptop and
 * irrelevant for a benchmark report.
 */
export function rankFts5(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: Fts5RankingOptions = {},
): LexicalScoredCandidate[] {
  const threshold = options.threshold ?? DEFAULT_FTS5_THRESHOLD;
  const topK = options.topK ?? 5;
  const safeQuery = sanitizeFts5Query(query);
  if (safeQuery.length === 0) return [];

  const index = buildFts5Index(candidates);
  try {
    // We ask FTS5 for K + a small overshoot, then apply the
    // threshold in JS. Pushing the threshold down to SQL
    // (e.g. with a `bm25(memory_fts) > -X` filter) would be
    // faster, but the squashed score is a JS-side transform
    // and we want one source of truth for "what passed".
    const overshoot = Math.max(topK * 2, 10);
    const rows = index.db
      .prepare(
        `SELECT memory_id AS id, bm25(memories_fts) AS bm
           FROM memories_fts
           WHERE memories_fts MATCH ?
           ORDER BY bm25(memories_fts) ASC
           LIMIT ?`,
      )
      .all(safeQuery, overshoot) as Array<{ id: number; bm: number }>;

    const scored: LexicalScoredCandidate[] = [];
    for (const r of rows) {
      const score = normalizeFts5Score(r.bm);
      if (score < threshold) continue;
      scored.push({ id: r.id, score });
    }
    // Stable order: score desc, then id asc. This mirrors
    // the lexical ranker's tie-break.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id - b.id;
    });
    return scored.slice(0, topK);
  } finally {
    index.close();
  }
}
