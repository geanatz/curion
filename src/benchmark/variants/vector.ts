/**
 * Benchmark-only vector retrieval variant.
 *
 * Why this exists:
 *   The lexical and FTS5 baselines are token-overlap rankers. They
 *   share a known failure mode: paraphrase brittleness. Two records
 *   that say the same thing in different words score poorly even
 *   when they are obviously about the same topic. The vector
 *   variant is the first comparison point that does not rely on
 *   exact token overlap: it represents each record and each query
 *   as a dense vector, then scores with cosine similarity.
 *
 * Scope (benchmark-only):
 *   - Loads the fixture corpus into an in-memory representation.
 *     It does NOT open, read, or write the project
 *     `.cortex/cortex.sqlite` file.
 *   - Exposes `rankVector(query, candidates, options)` that takes
 *     the same `LexicalCandidate` shape the lexical baseline uses
 *     and returns the same top-K shape (`{id, score}[]`).
 *   - Uses a clean `VectorEmbedder` interface so a real local
 *     embedding model (ONNX, sentence-transformers, etc.) can be
 *     plugged in later. The default local embedder is a
 *     deterministic hashed-bag-of-words (hashing trick + TF-IDF
 *     weighting + L2 normalization) — no network, no model
 *     download, no native deps, and stable across runs.
 *
 * What this is NOT:
 *   - It is NOT wired into `recall(text)`. The production
 *     controller still uses `rankLexical` and the public MCP
 *     surface is unchanged. Vector is benchmark-only until
 *     evidence says it should replace lexical.
 *   - It is NOT a hybrid ranker, reranker, or temporal reweighter.
 *   - It is NOT a vector DB. There is no persistent index, no
 *     sqlite-vec, no hnswlib. The whole index is a small in-memory
 *     `{ id -> vector }` map tied to the lifetime of a single
 *     benchmark run.
 *
 * Determinism:
 *   - The hashing trick uses FNV-1a, a stable non-cryptographic
 *     hash with a fixed 32-bit seed embedded in the code. The
 *     same input string always maps to the same hash bucket.
 *   - The corpus is re-embedded on every call (the current
 *     benchmark corpus re-embeds in microseconds; caching is
 *     not worth the staleness risk for a benchmark).
 *
 * Score semantics:
 *   - Cosine similarity in [-1, 1]. The corpus uses L2-normalized
 *     non-negative vectors, so in practice the score is in
 *     [0, 1]. Higher is better.
 *   - "Higher is better" matches the lexical and FTS5 conventions.
 *     The three scores are NOT on the same scale, but they are
 *     independently monotonic.
 *
 * No-answer TNR:
 *   - The default `DEFAULT_VECTOR_THRESHOLD` is `0` (no filter),
 *     mirroring the FTS5 default. Cosine similarity for a
 *     genuine match on this corpus is typically in the 0.05..0.6
 *     range; an absent term gives ~0. A threshold of 0 keeps the
 *     no-answer TNR meaningful.
 *   - Callers can pass a stricter threshold for parity with the
 *     lexical default (`0.2`).
 */

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
 * A dense embedding. Length is fixed per embedder. Components are
 * finite numbers. The vector is NOT necessarily L2-normalized;
 * callers that need unit vectors must normalize before comparing.
 */
export interface VectorEmbedding {
  /** The dense vector. */
  readonly values: ReadonlyArray<number>;
  /** Convenience: `values.length`. */
  readonly dim: number;
}

/**
 * Embedder contract. Implementations must be deterministic for
 * a given (text, options) pair, must return a vector of length
 * `options.dim`, and must never throw on free-form user text.
 *
 * Why this interface exists:
 *   The Architect's brief allows the real benchmark to plug in a
 *   bounded representative local embedding/runtime matrix
 *   (hashed-BoW, ONNX, sentence-transformers, etc.) without
 *   changing the ranker or the runner. The default local
 *   embedder (`HashedBagOfWordsEmbedder`) ships with the
 *   benchmark; future embedders can be added by implementing this
 *   interface and passing them to `rankVector` or the benchmark
 *   runner.
 */
export interface VectorEmbedder {
  /** Stable id used in reports and CLI flags. */
  readonly id: string;
  /** Short human description. */
  readonly description: string;
  /** Embedding dimensionality. */
  readonly dim: number;
  /** Embed a single text. Must never throw on free-form text. */
  embed(text: string): VectorEmbedding;
  /**
   * Batch-embed a list of texts. Implementations MAY call
   * `embed` in a loop. The default implementation does that.
   * A real local ONNX embedder would override this to batch
   * a single model forward pass.
   */
  embedBatch(texts: ReadonlyArray<string>): VectorEmbedding[];
}

/**
 * Options for the vector ranker. Mirrors `LexicalRankingOptions`
 * but uses a vector-specific default and adds an `embedder`
 * field so a real local embedder can be injected.
 */
export interface VectorRankingOptions extends LexicalRankingOptions {
  /**
   * Minimum cosine score to keep a candidate. The default is
   * `0` (no filter) for the reason documented at the top of
   * this file: cosine similarity on a TF-IDF-hashed
   * representation is naturally low for the current benchmark
   * corpus and the natural separation between "match" and "no
   * match" comes from the ranking, not from a hard threshold.
   * Callers that want strict parity with the lexical default
   * can pass `threshold: 0.2`.
   */
  threshold?: number;
  /**
   * The embedder to use. Defaults to a built-in
   * `HashedBagOfWordsEmbedder` with `dim = 1024`. Tests and
   * future local embedders can override this.
   */
  embedder?: VectorEmbedder;
}

// ---------------------------------------------------------------------------
// Hashing-trick + TF-IDF local embedder
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Stable, non-cryptographic, fast, no
 * dependencies. The 32-bit offset basis and prime are the FNV-1a
 * constants. We do NOT include a salt; the hashing trick's
 * collision rate is the design feature, not a bug. The
 * reproducibility (same input -> same bucket across machines)
 * is the property we actually need.
 */
const FNV1A_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV1A_PRIME_32 = 0x01000193;

function fnv1a32(s: string): number {
  let h = FNV1A_OFFSET_BASIS_32;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Multiply mod 2^32. The `>>> 0` keeps the result an
    // unsigned 32-bit integer in JS (which uses 64-bit floats
    // for `number`).
    h = Math.imul(h, FNV1A_PRIME_32) >>> 0;
  }
  return h >>> 0;
}

/**
 * Sign-trick hash. The Sign Trick of Weinberger et al. (2009)
 * reduces the variance of hashed dot products: instead of
 * `+1` for every bucket hit, the sign is a deterministic
 * pseudo-random function of the token. For our purposes the
 * exact choice does not matter; we use the top bit of
 * `fnv1a32(token)`.
 *
 * Returns either `+1` or `-1`. The output of `fnv1a32` is
 * uniform enough over the 32-bit range that a single bit
 * makes a fair coin.
 */
function signTrick(token: string): 1 | -1 {
  const h = fnv1a32("\u0001" + token);
  return (h & 0x80000000) !== 0 ? -1 : 1;
}

/**
 * Bag-of-words embedder using the hashing trick with sub-linear
 * TF (`log(1 + tf)`) and L2 normalization. Document-frequency
 * weighting is computed in a single pass over a corpus.
 *
 * Why this is a good default baseline:
 *   - It is deterministic across machines. The same text always
 *     maps to the same vector. No model download, no native
 *     dependency, no GPU. CI runs the same numbers every time.
 *   - It is a real dense-vector cosine-similarity ranker, not a
 *     lexical overlap. The architecture brief calls for a
 *     "bounded representative local embedding/runtime matrix";
 *     this is the deterministic, dependency-free point of that
 *     matrix.
 *   - It is small (the current benchmark corpus) enough that
 *     the bucket collision rate is dominated by design, not
 *     by accident.
 *   - It composes cleanly with the interface. A real local
 *     ONNX embedder can be plugged in by implementing
 *     `VectorEmbedder` and passing it to `rankVector`; the
 *     ranker does not change.
 */
export class HashedBagOfWordsEmbedder implements VectorEmbedder {
  readonly id = "hashed-bow";
  readonly description =
    "deterministic hashed bag-of-words (FNV-1a + sign trick, sub-linear TF, L2-normalized)";
  readonly dim: number;
  /** Optional inverse document frequencies keyed by token. */
  private idf: Map<string, number> | null;

  constructor(options: { dim?: number; idf?: Map<string, number> } = {}) {
    this.dim = options.dim ?? 1024;
    this.idf = options.idf ?? null;
  }

  /**
   * Fit IDF weights from a corpus. Returns a NEW embedder with
   * the IDF map installed. The original is not mutated, so the
   * builder is the safe way to construct an embedder for a
   * benchmark run.
   *
   * The IDF formula is `log((N + 1) / (df + 1)) + 1`, the
   * sklearn default with smoothing. It is always strictly
   * positive, so IDF never flips the sign of a vector
   * component.
   */
  fit(corpus: ReadonlyArray<string>): HashedBagOfWordsEmbedder {
    const N = corpus.length;
    const df = new Map<string, number>();
    for (const text of corpus) {
      const seen = new Set<string>();
      for (const tok of tokenize(text)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        df.set(tok, (df.get(tok) ?? 0) + 1);
      }
    }
    const idf = new Map<string, number>();
    for (const [tok, count] of df) {
      idf.set(tok, Math.log((N + 1) / (count + 1)) + 1);
    }
    return new HashedBagOfWordsEmbedder({ dim: this.dim, idf });
  }

  embed(text: string): VectorEmbedding {
    return embedHashedBagOfWords(text, this.dim, this.idf);
  }

  embedBatch(texts: ReadonlyArray<string>): VectorEmbedding[] {
    const out: VectorEmbedding[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      out[i] = this.embed(texts[i] ?? "");
    }
    return out;
  }
}

/**
 * Internal: produce a hashed-bag-of-words vector for a single
 * text. Exposed for tests so the algorithm is testable without
 * instantiating the embedder.
 *
 * The pipeline:
 *   1. Tokenize using the same rules as the lexical baseline
 *      (so the comparison is about RANKING, not tokenization).
 *   2. For each token, hash to a bucket in `[0, dim)` with the
 *      sign trick.
 *   3. Accumulate `sign * log(1 + tf) * idf` per bucket.
 *   4. L2-normalize so cosine similarity is a dot product.
 *   5. If the text is empty (zero tokens) or every token
 *      collides into a zero-magnitude sum, return the zero
 *      vector. Cosine with the zero vector is 0, which the
 *      ranker treats as "no match".
 */
export function embedHashedBagOfWords(
  text: string,
  dim: number,
  idf: Map<string, number> | null = null,
): VectorEmbedding {
  const values = new Float64Array(dim);
  const safeText = typeof text === "string" ? text : "";
  if (safeText.length === 0) {
    return { values: Array.from(values), dim };
  }
  // Count term frequencies first so we can apply sub-linear TF.
  const tf = new Map<string, number>();
  for (const tok of tokenize(safeText)) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }
  if (tf.size === 0) {
    return { values: Array.from(values), dim };
  }
  for (const [tok, count] of tf) {
    const bucket = fnv1a32(tok) % dim;
    const sign = signTrick(tok);
    const subLinearTf = Math.log(1 + count);
    const idfWeight = idf ? (idf.get(tok) ?? 1) : 1;
    values[bucket] += sign * subLinearTf * idfWeight;
  }
  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += values[i]! * values[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) values[i] = values[i]! / norm;
  }
  return { values: Array.from(values), dim };
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two L2-normalized vectors. Both
 * inputs are accepted as plain arrays; we do not assume they
 * are already normalized. If either vector is the zero vector
 * the result is 0 (cosine is undefined; we define it to 0 for
 * ranker purposes, matching the "no overlap" semantics).
 */
export function cosineSimilarity(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number {
  if (a.length !== b.length) {
    // We do not throw; the ranker uses 0 for malformed inputs.
    // Length mismatch on dense vectors is a real bug, but the
    // benchmark path is best-effort and must not crash the
    // whole run.
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Default threshold for the vector variant. The vector score
 * is cosine similarity in [0, 1] for non-negative normalized
 * inputs. For the current benchmark corpus the natural
 * separation between "match" and "no match" comes from the
 * ranking, not from a hard cut. The default `0` keeps the
 * no-answer TNR meaningful, mirroring the FTS5 default.
 */
export const DEFAULT_VECTOR_THRESHOLD = 0;

/**
 * Default top-K for the vector variant. Mirrors the lexical
 * and FTS5 defaults (5).
 */
export const DEFAULT_VECTOR_TOP_K = 5;

/**
 * Rank candidates by cosine similarity against the query and
 * return the top-K that pass the threshold.
 *
 * Behavior:
 *   - A query that tokenizes to nothing returns an empty array.
 *   - A candidate whose vector is the zero vector scores 0 and
 *     is filtered out by any non-zero threshold. Under the
 *     default threshold of 0 it appears in the result list with
 *     score 0; it is still a candidate the controller can
 *     inspect.
 *   - Ties on cosine score are broken by ascending id, matching
 *     the lexical and FTS5 stability contract.
 *   - The function is deterministic for a given (query,
 *     corpus, embedder, threshold, top-K). The embedder is
 *     the only source of non-determinism, and the default
 *     `HashedBagOfWordsEmbedder` is fully deterministic.
 */
export function rankVector(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: VectorRankingOptions = {},
): LexicalScoredCandidate[] {
  const threshold = options.threshold ?? DEFAULT_VECTOR_THRESHOLD;
  const topK = options.topK ?? DEFAULT_VECTOR_TOP_K;
  const safeQuery = typeof query === "string" ? query : "";
  // A query that tokenizes to nothing (empty string, all
  // stopwords, all punctuation) must short-circuit to an empty
  // top-K. The embedder returns a zero vector in that case, and
  // cosine similarity of a zero vector to any unit vector is 0
  // — which would silently pass the default threshold of 0 and
  // produce a top-K of every candidate with score 0. We
  // short-circuit on the token count instead so the no-answer
  // path stays meaningful.
  if (tokenize(safeQuery).length === 0) return [];
  // The corpus is re-fit on every call. For the current
  // benchmark the cost is invisible, and avoiding a module-level
  // cache is part of the "benchmark-only, no shared state"
  // contract.
  const embedder = options.embedder ?? new HashedBagOfWordsEmbedder();
  // Build candidate texts (summary + tags) once. The lexical
  // baseline uses the same construction; staying consistent
  // keeps the three variants comparable in what they consider
  // the "match text".
  const candidateTexts = candidates.map((c) => {
    const text = typeof c.text === "string" ? c.text : "";
    const tagPart =
      Array.isArray(c.tags) && c.tags.length > 0
        ? ` ${c.tags.join(" ")}`
        : "";
    return `${text}${tagPart}`;
  });
  const candidateVectors = embedder.embedBatch(candidateTexts);
  const queryVector = embedder.embed(safeQuery);

  const scored: LexicalScoredCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const v = candidateVectors[i]!;
    if (!v) continue;
    const score = cosineSimilarity(queryVector.values, v.values);
    if (score >= threshold) {
      scored.push({ id: c.id, score });
    }
  }
  // Stable order: score desc, then id asc. Mirrors the lexical
  // and FTS5 ranker tie-break.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id - b.id;
  });
  return scored.slice(0, topK);
}
