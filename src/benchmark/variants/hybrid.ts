/**
 * Benchmark-only hybrid retrieval variant with Reciprocal Rank
 * Fusion (RRF).
 *
 * Why this exists:
 *   The lexical, FTS5, and vector variants each have well-
 *   documented strengths and weaknesses on the benchmark query
 *   set:
 *   - lexical  is strong on exact technical terms and weak on
 *              paraphrase; it carries no real ranking signal.
 *   - FTS5     is strong on the same exact-term queries, slightly
 *              weaker on very short / function-word-heavy queries,
 *              and has BM25-tuned ranking.
 *   - vector   is strong on paraphrase and weak on exact technical
 *              terms; cosine is not aligned with token overlap.
 *
 *   The Architect's brief asks for a benchmark-only hybrid that
 *   fuses the three variants by RANK, not by raw score, so a
 *   strong contributor from any source can lift a candidate
 *   into the top-K. Reciprocal Rank Fusion (Cormack, Clarke,
 *   Buettcher 2009) does exactly that: it is rank-only, scale-
 *   invariant, and well-suited to fusing radically different
 *   score distributions.
 *
 * Score semantics (RRF):
 *   For a candidate `c` and a set of variant rankings
 *   `R_1, R_2, ..., R_n`, the RRF score is:
 *
 *     rrf(c) = Σ_i  weight_i / (k + rank_i(c))
 *
 *   where:
 *     - `rank_i(c)` is the 1-based rank of `c` in `R_i`, or
 *       `∞` (treated as 0 contribution) if `c` is not in `R_i`.
 *     - `weight_i` is the per-variant weight (default 1.0).
 *     - `k` is a smoothing constant. The conventional default
 *       in the RRF literature is k = 60. We expose k as an
 *       option and benchmark at k ∈ {20, 60, 100} so a
 *       reviewer can see the trade-off: a smaller k makes the
 *       rank-1 position dominate the fusion, a larger k
 *       flattens the contribution of high ranks and gives more
 *       weight to mid-list hits.
 *
 * Why rank-fusion, not score-fusion:
 *   The three variants return scores on incompatible scales
 *   (lexical 0..1+, FTS5 0..1 squashed bm25, vector 0..1
 *   cosine). Naive score averaging would require per-corpus
 *   normalization and is brittle to per-variant threshold
 *   changes. RRF works on rank order, so it composes the three
 *   contributors without ever comparing their raw scores.
 *
 * Scope (benchmark-only):
 *   - All three contributing variants are already benchmark-
 *     only. The hybrid module is a thin fuser: it does not
 *     touch the production `rankLexical` path, does not change
 *     the public MCP API, and does not introduce a new
 *     candidate shape.
 *   - The hybrid variant is reachable only through the
 *     benchmark path. Source-tree guards in
 *     `tests/retrieval-hybrid.test.ts` enforce this with the
 *     same shape as the FTS5 / vector guards.
 *
 * Determinism:
 *   - Each contributing variant is deterministic for a given
 *     (query, corpus, options). The fusion is a pure function
 *     of the per-variant rankings, so the hybrid output is
 *     deterministic for a given (query, corpus, k, weights).
 *   - Ties on the RRF score are broken by ascending id, the
 *     same stability contract the three single variants use.
 *
 * Score scale:
 *   - With three variants, all weights 1.0, the maximum RRF
 *     score for a candidate that is rank-1 in all three is
 *     `3 / (k + 1)`. For k = 60 that is 0.0492. We do not
 *     squash the RRF score; the ranker uses threshold = 0
 *     (passes anything that has at least one contribution)
 *     and the RRF scale is a fixed, monotonic transform of
 *     the underlying ranks. A future phase that wants a
 *     "higher is better" normalized score can rescale; the
 *     contract is "higher is better" and the metric block
 *     treats the score as a relative ranker output, not a
 *     probability.
 *
 * Threshold and no-answer:
 *   - Default threshold is 0 (no filter), the same default
 *     the FTS5 and vector variants use. A hybrid run that
 *     receives a no-answer query returns the empty set iff
 *     NONE of the three contributing variants return a hit
 *     (i.e. the RRF score for every candidate is exactly 0).
 *   - The hybrid variant does NOT introduce an abstention
 *     gate. The calibration experiment is the place where
 *     abstention gates are studied; the hybrid is just a
 *     ranker.
 */

import {
  rankLexical,
  type LexicalCandidate,
  type LexicalScoredCandidate,
  type LexicalRankingOptions,
} from "../../retrieval/lexical.js";
import { rankFts5, type Fts5RankingOptions } from "./fts5.js";
import { rankVector, type VectorRankingOptions } from "./vector.js";
import {
  rankDenseVectorWithMetadataAsync,
  type DenseVectorRankingOptions,
  type DenseVectorRankResult,
} from "./dense-vector.js";
import type { DenseEmbedder } from "./dense-embedder.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * RRF weight set. Weights are non-negative finite numbers.
 * A weight of 0 effectively removes the variant from the
 * fusion. A negative or non-finite weight throws at
 * `rankHybrid` time (the public function is defensive — bad
 * inputs fail loud, not silent).
 *
 * Default: all weights 1.0 (uniform fusion).
 */
export interface HybridWeights {
  lexical?: number;
  fts5?: number;
  vector?: number;
  /**
   * Weight for the real dense vector contributor. Ignored
   * unless `useDenseVector: true` is passed on the
   * `HybridRankingOptions`. Same semantics as `vector`.
   */
  vectorDense?: number;
}

/**
 * Options for the hybrid ranker. Extends `LexicalRankingOptions`
 * with hybrid-specific knobs. The `topK` / `threshold` defaults
 * are the same as the single variants; the hybrid does not
 * introduce a separate topK contract.
 */
export interface HybridRankingOptions extends LexicalRankingOptions {
  /**
   * RRF smoothing constant. Conventional default is 60 (the
   * value used in the RRF paper, also the value most
   * implementations pick). Smaller values make rank-1 dominate
   * the fusion; larger values flatten the contribution of high
   * ranks. Must be a positive finite number; non-positive or
   * non-finite values throw at `rankHybrid` time.
   */
  k?: number;
  /**
   * Per-variant RRF weights. Defaults to 1.0 for every
   * variant, which is uniform fusion. A weight of 0
   * effectively removes the variant from the fusion
   * (its `rank_i` term is multiplied by 0, so only the
   * remaining variants contribute).
   */
  weights?: HybridWeights;
  /**
   * Optional overrides for the contributing variants. Useful
   * for tests and for the future real-embedder path. The
   * defaults delegate to `rankLexical` /
   * `rankFts5` / `rankVector` with the same `threshold` /
   * `topK` and (for the lexical variant) the same lexical
   * threshold. A future hybrid experiment that wants a
   * different per-variant threshold can pass it here without
   * touching the public `HybridRankingOptions` shape.
   */
  perVariantOptions?: {
    lexical?: LexicalRankingOptions;
    fts5?: Fts5RankingOptions;
    vector?: VectorRankingOptions;
    vectorDense?: DenseVectorRankingOptions;
  };
  /**
   * When `true`, the hybrid replaces the hashed-bag-of-words
   * `vector` contributor with the real local dense vector
   * contributor (`vector-dense`). The contributor label on
   * the diagnostic is `vector-dense` so a reviewer can see
   * which embedder produced the contributor's rank. The
   * real embedder must be passed via `denseVectorEmbedder`
   * (or `perVariantOptions.vectorDense.embedder`).
   *
   * Default: `false` (the existing hashed-BoW vector
   * contributor is used). The CLI flag
   * `--hybrid-use-dense-vector` flips the flag on; the
   * benchmark runner then constructs the real embedder from
   * the `--embedder` flag and threads it through.
   */
  useDenseVector?: boolean;
  /**
   * Real local dense embedder for the
   * `vector-dense` contributor. Required when
   * `useDenseVector: true`. Ignored otherwise.
   */
  denseVectorEmbedder?: DenseEmbedder;
  /**
   * Embedding kind for the `vector-dense`
   * contributor. Same contract as
   * `DenseVectorRankingOptions.kind`: the Qwen3
   * embedder distinguishes queries (which receive
   * the `Instruct: <task>\nQuery:<query>` prefix)
   * from documents (verbatim). The hybrid
   * benchmark runner always passes
   * `kind: "query"` for the user query string;
   * the candidate texts are documents. Default:
   * `"document"`, mirroring the dense vector
   * ranker.
   */
  denseKind?: "query" | "document";
}

/**
 * A single per-variant contribution to a candidate's RRF
 * score. The hybrid ranker returns a list of these for the
 * top-K candidates so a reviewer can see WHY a candidate
 * landed in the top-K and which source did the heavy
 * lifting.
 *
 * `present: false` means the candidate was not in the
 * contributor's top-K at all; the contribution is 0 and the
 * other fields are zeroed.
 */
export interface RrfContributor {
  /** The variant label. */
  source: "lexical" | "fts5" | "vector" | "vector-dense";
  /**
   * 1-based rank in the contributor's top-K, or null if the
   * candidate was not present in the contributor's ranking.
   */
  rank: number | null;
  /**
   * The contributor's raw score for this candidate, or null
   * if the candidate was not present. The score is the
   * variant's own "higher is better" score; it is on the
   * contributor's natural scale, not the RRF scale.
   */
  score: number | null;
  /**
   * The RRF contribution: `weight / (k + rank)`, or 0 if the
   * candidate was not present. Exposed on the diagnostic so
   * the report can show the per-source contribution without
   * re-running the math.
   */
  contribution: number;
  /**
   * The weight applied for this variant (1.0 default, or
   * whatever the caller passed). Exposed for transparency.
   */
  weight: number;
}

/**
 * A hybrid-ranked candidate with full RRF diagnostics.
 * `contributors` is keyed by source; the score is the RRF
 * score; the variant-level ranker output is preserved for
 * traceability.
 */
export interface HybridScoredCandidate {
  id: number;
  /** RRF score. Higher is better. */
  score: number;
  /** Per-variant contribution breakdown. Always contains an
   *  entry for every configured source, in variant order
   *  (lexical, fts5, vector). */
  contributors: RrfContributor[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default RRF smoothing constant. The conventional value
 * used in the RRF paper and in most implementations. Must be
 * a positive finite number. The benchmark sweep runs at
 * k ∈ {20, 60, 100} so a reviewer can see the trade-off.
 */
export const DEFAULT_RRF_K = 60;

/**
 * Default threshold for the hybrid variant. RRF scores are
 * positive for any candidate with at least one contributing
 * variant; the natural "no match" outcome (every variant
 * returned an empty list) yields RRF = 0, which is below
 * the default threshold. A no-answer query therefore
 * short-circuits to an empty top-K. A future phase that
 * wants to surface a confidence-based abstention can layer
 * that on top of the calibration experiment; the ranker
 * itself does not introduce a gate.
 */
export const DEFAULT_HYBRID_THRESHOLD = 0;

/**
 * Default top-K for the hybrid variant. Mirrors the
 * lexical, FTS5, and vector defaults.
 */
export const DEFAULT_HYBRID_TOP_K = 5;

/**
 * The k values the benchmark sweep runs. We keep this list
 * small (three values) so a single sweep is readable:
 *   - k = 20  : rank-1 dominates. A candidate that is rank-1
 *               in any contributor effectively wins.
 *   - k = 60  : the conventional default.
 *   - k = 100 : mid-list hits contribute more; rank-1's
 *               advantage is smaller.
 *
 * A future phase can extend the sweep with k = 1 (pure
 * "any rank-1" indicator) or k = 1000 (almost-uniform
 * rank weighting); the three above are the standard
 * "lower, default, higher" triumvirate.
 */
export const RRF_SWEEP_K_VALUES: readonly number[] = [20, 60, 100] as const;

// ---------------------------------------------------------------------------
// RRF math
// ---------------------------------------------------------------------------

/**
 * RRF contribution of a single (source, rank) pair. Returns
 * 0 if the candidate was not in the source's ranking
 * (`rank === null`), otherwise `weight / (k + rank)`.
 *
 * The function is exported as a pure helper so tests can
 * assert on the math without going through the ranker.
 */
export function rrfContribution(
  rank: number | null,
  weight: number,
  k: number,
): number {
  if (rank === null) return 0;
  if (!Number.isFinite(rank) || rank < 1) {
    throw new Error(
      `rrfContribution: rank must be a positive integer or null (got ${rank})`,
    );
  }
  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error(
      `rrfContribution: weight must be a non-negative finite number (got ${weight})`,
    );
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(
      `rrfContribution: k must be a positive finite number (got ${k})`,
    );
  }
  if (weight === 0) return 0;
  return weight / (k + rank);
}

/**
 * Fuse a list of per-variant rankings into a single RRF
 * ranking. The function is pure: it takes the three ranked
 * lists (each as `LexicalScoredCandidate[]`), the weights,
 * and `k`, and returns the top-K candidates sorted by RRF
 * score descending with id ascending tie-break.
 *
 * Inputs:
 *   - `rankings`  : one ranked list per variant. The order
 *                   of the list matters: index 0 is rank 1.
 *                   The list may be empty (the variant
 *                   returned no hits).
 *   - `weights`   : per-variant RRF weights (1.0 default).
 *   - `k`         : RRF smoothing constant.
 *   - `topK`      : number of candidates to return.
 *   - `sourceLabels`: parallel to `rankings`, the variant
 *                   label for diagnostics.
 *
 * Output:
 *   - A list of `HybridScoredCandidate` objects, sorted by
 *     RRF score desc, id asc, length ≤ `topK`. The
 *     `contributors` field carries one entry per source
 *     (including the sources that did NOT return the
 *     candidate) so a reviewer can see the full trace.
 *
 * The function is exported for tests and for the benchmark
 * runner. The CLI-facing entry point `rankHybrid` builds
 * the per-variant rankings from the candidate set, then
 * calls this.
 */
export function fuseRankings(
  rankings: ReadonlyArray<{
    label: "lexical" | "fts5" | "vector" | "vector-dense";
    list: ReadonlyArray<LexicalScoredCandidate>;
    weight: number;
  }>,
  k: number,
  topK: number,
): HybridScoredCandidate[] {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`fuseRankings: k must be a positive finite number (got ${k})`);
  }
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error(`fuseRankings: topK must be a positive integer (got ${topK})`);
  }
  // For each variant, build a map id -> { rank, score }.
  // The rank is 1-based (rank-1 → 1). Variants that do not
  // include an id leave it absent from the map; the
  // contribution is 0.
  const perVariantIndex: Map<
    number,
    { label: "lexical" | "fts5" | "vector" | "vector-dense"; rank: number; score: number; weight: number }
  >[] = [];
  for (const r of rankings) {
    if (!Number.isFinite(r.weight) || r.weight < 0) {
      throw new Error(
        `fuseRankings: weight must be a non-negative finite number (got ${r.weight} for ${r.label})`,
      );
    }
    const idx = new Map<number, { label: "lexical" | "fts5" | "vector" | "vector-dense"; rank: number; score: number; weight: number }>();
    for (let i = 0; i < r.list.length; i++) {
      const c = r.list[i]!;
      // First-seen wins on duplicates within a single
      // variant's ranking. The three contributing rankers
      // are stable on ties (score desc, id asc) and do not
      // produce duplicates, but the contract is "first
      // occurrence is the rank", which is the conservative
      // choice for an RRF helper.
      if (!idx.has(c.id)) {
        idx.set(c.id, {
          label: r.label,
          rank: i + 1,
          score: c.score,
          weight: r.weight,
        });
      }
    }
    perVariantIndex.push(idx);
  }
  // Collect the union of ids across all variants.
  const union = new Set<number>();
  for (const idx of perVariantIndex) {
    for (const id of idx.keys()) union.add(id);
  }
  // Build the per-id fusion.
  const fused: HybridScoredCandidate[] = [];
  for (const id of union) {
    let total = 0;
    const contributors: RrfContributor[] = [];
    for (let s = 0; s < perVariantIndex.length; s++) {
      const idx = perVariantIndex[s]!;
      const hit = idx.get(id);
      const label = rankings[s]!.label;
      const weight = rankings[s]!.weight;
      if (hit) {
        const contribution = rrfContribution(hit.rank, weight, k);
        total += contribution;
        contributors.push({
          source: label,
          rank: hit.rank,
          score: hit.score,
          contribution,
          weight,
        });
      } else {
        contributors.push({
          source: label,
          rank: null,
          score: null,
          contribution: 0,
          weight,
        });
      }
    }
    fused.push({ id, score: total, contributors });
  }
  // Stable sort: RRF score desc, then id asc. Matches the
  // stability contract of the three single variants.
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id - b.id;
  });
  return fused.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank candidates by RRF-fused score against the query and
 * return the top-K that pass the threshold.
 *
 * Behavior:
 *   - Each contributing variant is run independently with
 *     `threshold: 0` and the requested `topK`, so the fuser
 *     sees the full per-variant ranking without any pre-
 *     filter. The fuser applies the hybrid threshold on the
 *     RRF score, not on the per-variant scores.
 *   - The candidate set is the same set all three
 *     contributing variants consume. The benchmark runner
 *     builds it from the corpus records.
 *   - The function is deterministic for a given (query,
 *     corpus, k, weights, per-variant options, threshold,
 *     top-K). Ties on the RRF score are broken by ascending
 *     id, the same stability contract the three single
 *     variants use.
 *   - A query that tokenizes to nothing returns an empty
 *     array. The lexical variant short-circuits on a
 *     zero-token query; we delegate to it for that guard so
 *     the hybrid matches the lexical / FTS5 / vector no-
 *     answer path. (The vector variant also short-circuits
 *     on a zero-token query; the lexical short-circuit is
 *     the conservative anchor.)
 */
export function rankHybrid(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: HybridRankingOptions = {},
): HybridScoredCandidate[] {
  if (options.useDenseVector) {
    throw new Error(
      "rankHybrid: useDenseVector=true is async-only; use rankHybridAsync",
    );
  }
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`rankHybrid: k must be a positive finite number (got ${k})`);
  }
  const topK = options.topK ?? DEFAULT_HYBRID_TOP_K;
  const threshold = options.threshold ?? DEFAULT_HYBRID_THRESHOLD;
  const weights = options.weights ?? {};
  const wLex = weights.lexical ?? 1;
  const wFts = weights.fts5 ?? 1;
  const wVec = weights.vector ?? 1;
  for (const w of [wLex, wFts, wVec]) {
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(
        `rankHybrid: weights must be non-negative finite numbers (got ${w})`,
      );
    }
  }
  // Per-variant options. The defaults use the same
  // `threshold` / `topK` as the public options. The lexical
  // ranker has its own threshold semantics (0.2 default);
  // when a caller passes `options.threshold` we propagate
  // it to all three variants so the no-answer path is
  // consistent.
  const lexOpts: LexicalRankingOptions = {
    threshold: options.perVariantOptions?.lexical?.threshold ?? 0,
    topK,
    ...(options.perVariantOptions?.lexical ?? {}),
  };
  const ftsOpts: Fts5RankingOptions = {
    threshold: options.perVariantOptions?.fts5?.threshold ?? 0,
    topK,
    ...(options.perVariantOptions?.fts5 ?? {}),
  };
  const vecOpts: VectorRankingOptions = {
    threshold: options.perVariantOptions?.vector?.threshold ?? 0,
    topK,
    ...(options.perVariantOptions?.vector ?? {}),
  };
  // Zero-token short-circuit: delegate to lexical, the
  // conservative anchor. The lexical ranker returns [] for
  // a zero-token query; we mirror that.
  const lexProbe = rankLexical(query, candidates, lexOpts);
  const ftsList = rankFts5(query, candidates, ftsOpts);
  const vecList = rankVector(query, candidates, vecOpts);
  // If the lexical probe returned empty AND the FTS5 +
  // vector lists are also empty, the union is empty and
  // there is nothing to fuse. This is the "no-answer"
  // short-circuit: a query with no token overlap in any
  // contributing variant yields an empty hybrid top-K.
  if (lexProbe.length === 0 && ftsList.length === 0 && vecList.length === 0) {
    return [];
  }
  const fused = fuseRankings(
    [
      { label: "lexical", list: lexProbe, weight: wLex },
      { label: "fts5", list: ftsList, weight: wFts },
      { label: "vector", list: vecList, weight: wVec },
    ],
    k,
    topK,
  );
  if (threshold > 0) {
    return fused.filter((c) => c.score >= threshold);
  }
  return fused;
}

// ---------------------------------------------------------------------------
// Thin compatibility adapter
// ---------------------------------------------------------------------------

/**
 * Adapter that returns the hybrid ranking in the same
 * `LexicalScoredCandidate[]` shape the metrics / runner
 * expect: `{id, score}[]`, score descending, id ascending
 * tie-break, top-K clipped. The full per-contributor
 * diagnostics are dropped in this shape; the benchmark
 * runner calls `rankHybrid` directly when it wants the
 * diagnostics.
 *
 * The adapter is exported so a future runner change can
 * adopt it as a one-liner; the v1 runner calls `rankHybrid`
 * for the diagnostics path.
 */
export function rankHybridAsLexical(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: HybridRankingOptions = {},
): LexicalScoredCandidate[] {
  return rankHybrid(query, candidates, options).map((c) => ({
    id: c.id,
    score: c.score,
  }));
}

// ---------------------------------------------------------------------------
// Async entry point: hybrid with real dense vector contributor
// ---------------------------------------------------------------------------

/**
 * The async result of a hybrid rank. Same as
 * `HybridScoredCandidate[]` plus an `embeddingBackend`
 * block for the dense contributor (when used) and a
 * `contributors` block describing which contributors
 * were active in this run.
 */
export interface HybridAsyncRankResult {
  hits: HybridScoredCandidate[];
  /**
   * Embedder metadata for the dense vector contributor,
   * when `useDenseVector: true`. `undefined` otherwise.
   */
  embeddingBackend?: import("./dense-embedder.js").EmbedderMetadata;
  /**
   * The list of contributor labels that participated in
   * this run. Useful for the report's metadata block.
   */
  contributors: ReadonlyArray<"lexical" | "fts5" | "vector" | "vector-dense">;
}

/**
 * Async hybrid ranker. Mirrors `rankHybrid` exactly,
 * except:
 *   - the `vector` slot is replaced with `vector-dense`
 *     when `options.useDenseVector === true` (the real
 *     local semantic embedder wired through
 *     `options.denseVectorEmbedder`).
 *   - the function is async because the dense vector
 *     forward pass is async.
 *   - the result carries the embedder metadata so the
 *     runner can surface it on the report.
 *
 * Determinism: same contract as `rankHybrid`. The
 * `vector-dense` contributor is deterministic for a
 * fixed model + ONNX runtime.
 */
export async function rankHybridAsync(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: HybridRankingOptions = {},
): Promise<HybridAsyncRankResult> {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`rankHybridAsync: k must be a positive finite number (got ${k})`);
  }
  const topK = options.topK ?? DEFAULT_HYBRID_TOP_K;
  const threshold = options.threshold ?? DEFAULT_HYBRID_THRESHOLD;
  const weights = options.weights ?? {};
  const wLex = weights.lexical ?? 1;
  const wFts = weights.fts5 ?? 1;
  const wVec = weights.vector ?? 1;
  const wVecDense = weights.vectorDense ?? 1;
  for (const w of [wLex, wFts, wVec, wVecDense]) {
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(
        `rankHybridAsync: weights must be non-negative finite numbers (got ${w})`,
      );
    }
  }
  if (options.useDenseVector && !options.denseVectorEmbedder) {
    throw new Error(
      "rankHybridAsync: useDenseVector=true requires denseVectorEmbedder to be set",
    );
  }
  const lexOpts: LexicalRankingOptions = {
    threshold: options.perVariantOptions?.lexical?.threshold ?? 0,
    topK,
    ...(options.perVariantOptions?.lexical ?? {}),
  };
  const ftsOpts: Fts5RankingOptions = {
    threshold: options.perVariantOptions?.fts5?.threshold ?? 0,
    topK,
    ...(options.perVariantOptions?.fts5 ?? {}),
  };
  // Zero-token short-circuit: mirror the sync ranker.
  const lexProbe = rankLexical(query, candidates, lexOpts);
  const ftsList = rankFts5(query, candidates, {
    threshold: options.perVariantOptions?.fts5?.threshold ?? 0,
    topK,
    ...(options.perVariantOptions?.fts5 ?? {}),
  });
  let vecList: LexicalScoredCandidate[] = [];
  let denseEmbeddingBackend:
    | import("./dense-embedder.js").EmbedderMetadata
    | undefined;
  let activeLabels: Array<"lexical" | "fts5" | "vector" | "vector-dense">;
  if (options.useDenseVector && options.denseVectorEmbedder) {
    const denseOpts: DenseVectorRankingOptions = {
      threshold: options.perVariantOptions?.vectorDense?.threshold ?? 0,
      topK,
      ...(options.perVariantOptions?.vectorDense ?? {}),
      embedder: options.denseVectorEmbedder,
      // The hybrid benchmark is always called
      // with the user query string. The dense
      // vector contributor embeds that query with
      // the `kind: "query"` flag so the Qwen3
      // embedder can apply the
      // `Instruct: <task>\nQuery:<query>`
      // instruction prefix on the query side and
      // the unprefixed text on the document
      // side. The fallback embedders (stub,
      // MiniLM) ignore the flag.
      kind: options.denseKind ?? "query",
    };
    const denseRes: DenseVectorRankResult =
      await rankDenseVectorWithMetadataAsync(query, candidates, denseOpts);
    vecList = denseRes.hits;
    denseEmbeddingBackend = denseRes.embeddingBackend;
    activeLabels = ["lexical", "fts5", "vector-dense"];
  } else {
    const vecOpts: VectorRankingOptions = {
      threshold: options.perVariantOptions?.vector?.threshold ?? 0,
      topK,
      ...(options.perVariantOptions?.vector ?? {}),
    };
    vecList = rankVector(query, candidates, vecOpts);
    activeLabels = ["lexical", "fts5", "vector"];
  }
  if (
    lexProbe.length === 0 &&
    ftsList.length === 0 &&
    vecList.length === 0
  ) {
    return {
      hits: [],
      contributors: activeLabels,
      ...(denseEmbeddingBackend !== undefined
        ? { embeddingBackend: denseEmbeddingBackend }
        : {}),
    };
  }
  const rankings: Array<{
    label: "lexical" | "fts5" | "vector" | "vector-dense";
    list: ReadonlyArray<LexicalScoredCandidate>;
    weight: number;
  }> = [
    { label: "lexical", list: lexProbe, weight: wLex },
    { label: "fts5", list: ftsList, weight: wFts },
  ];
  if (options.useDenseVector) {
    rankings.push({ label: "vector-dense", list: vecList, weight: wVecDense });
  } else {
    rankings.push({ label: "vector", list: vecList, weight: wVec });
  }
  const fused = fuseRankings(rankings, k, topK);
  const filtered =
    threshold > 0 ? fused.filter((c) => c.score >= threshold) : fused;
  return {
    hits: filtered,
    contributors: activeLabels,
    ...(denseEmbeddingBackend !== undefined
      ? { embeddingBackend: denseEmbeddingBackend }
      : {}),
  };
}
