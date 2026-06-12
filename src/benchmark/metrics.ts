/**
 * Retrieval benchmark metrics.
 *
 * Pure, deterministic metric functions used by the benchmark
 * runner. No I/O, no provider calls, no network. The same inputs
 * always produce the same outputs.
 *
 * The benchmark reports two distinct notions of "correctness"
 * for positive queries, and they are kept separate on purpose:
 *
 *   - `hit@K` (binary, top-K) — a positive query is a "hit" if
 *     its top-K contains AT LEAST ONE of the expected ids. We
 *     do not score partial credit (e.g. 1/3 of the expected
 *     ids). The reason is documented in the runner header: the
 *     lexical baseline is doing candidate retrieval, not
 *     synthesis, so "complete coverage" is not a meaningful
 *     target for it. The hit@1 / hit@3 / hit@5 split lets us
 *     see whether the right id is at the top of the list or
 *     only further down.
 *
 *   - `rank1` (stricter) — a positive query is "rank-1 correct"
 *     iff the TOP result is one of the expected ids. This is a
 *     stricter, more user-facing metric: the candidate the
 *     controller will hand to the synthesizer / surface to the
 *     user is the one at rank 1, not the one at rank 3.
 *
 *   - `currentTruthAt1` (temporal stricter) — a positive query
 *     has its CURRENT truth at rank-1 iff the top result is one
 *     of the `currentTruthIds`. For non-temporal families this
 *     is the same as `rank1` by construction (the "right"
 *     answer is always the current one). For the `temporal`
 *     family it is the metric the reviewer flagged: the old
 *     fact can be in the top-K (so hit@K passes) but still rank
 *     above the current fact (so currentTruthAt1 fails). This
 *     is the gap the benchmark should make visible.
 *
 * For no-answer queries, the metric is the symmetric negative:
 * the run is correct iff the top-K is empty.
 *
 * The metrics module also exposes a small set of derived IR
 * metrics (precision@K, recall@K, F1@5, MRR@5), no-answer
 * confusion-matrix counts (TP/FP/TN/FN, specificity, FPR /
 * confabulation rate, answer coverage, abstention precision),
 * multi-hop / list coverage (partial and complete), current-truth
 * diagnostics at multiple Ks, score diagnostics (top score,
 * score gap between rank-1 and rank-2, mean top score by
 * outcome), structured failure categories, and a small set of
 * orientation-specific metrics for project-status queries. The
 * derived metrics are computed alongside the headline
 * `hit@K` / `rank1` / `currentTruthAt1` numbers so the report
 * surfaces both the simple contract numbers and the richer IR
 * view in the same run. None of these derived metrics change
 * the headline contract or the existing test assertions.
 *
 * Answer-quality evaluation is OUT OF SCOPE for this phase. The
 * `AnswerQualityScaffold` type is exported so a future phase
 * can plug in an LLM-judged quality pass, but the runner
 * does NOT call any provider, does NOT score generated answers,
 * and the scaffold fields are reported as `enabled: false` with
 * a stable `null` evaluation. The scaffold is documented in
 * `src/benchmark/answer-quality.ts` and the runner prints a
 * single labeled line in the human report so a reviewer can see
 * the feature is intentionally disabled.
 *
 * A deterministic `bootstrapCi` helper is also exported for
 * binary-metric 95% confidence intervals. It is NOT wired
 * into the headline number: the runner reports the raw count
 * and percentage, and any future reporter that wants a CI can
 * call `bootstrapCi(outcomes)` directly. Determinism matters
 * because the benchmark report is checked in as a regression
 * artifact; a non-deterministic CI would make byte-equal
 * comparisons noisy.
 */

// ---------------------------------------------------------------------------
// Top-K and K constants
// ---------------------------------------------------------------------------

/**
 * Hard-coded Ks the runner reports on. Changing this list is a
 * benchmark contract change: existing reports and test
 * assertions reference the same K values.
 *
 * `DEFAULT_K` (5) matches the production `DEFAULT_TOP_K`; the
 * per-K metrics are computed at 1, 3, 5, and 10 so a future
 * report can show whether relaxing K beyond the production
 * default helps. The headline numbers (hit@1, hit@3, hit@5)
 * are unchanged.
 */
export const BENCHMARK_K_VALUES: readonly number[] = [1, 3, 5, 10] as const;

/**
 * Fixed Ks used for the headline IR metrics. We keep these
 * separate from `BENCHMARK_K_VALUES` so the headline numbers
 * stay stable even if a future phase adds or removes a K
 * bucket. The MRR / F1 K choice is "5" to match the existing
 * hit@5 contract and the production top-K default.
 */
export const HEADLINE_K = 5 as const;
export const HEADLINE_MRR_K = 5 as const;

// ---------------------------------------------------------------------------
// Query families
// ---------------------------------------------------------------------------

/**
 * Query family labels. The runner uses these to drive the
 * per-family breakdown and the structured failure categoriser.
 * Adding a new family requires extending the
 * `categorizeFailure` function and the per-family aggregate
 * template, both of which are deliberately explicit so the
 * contract is visible at the call site.
 */
export type BenchmarkQueryFamily =
  | "exact"
  | "paraphrase"
  | "temporal"
  | "multi-hop"
  | "no-answer"
  | "orientation";

// ---------------------------------------------------------------------------
// Per-query evaluation
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a single query.
 */
export interface QueryEval {
  queryId: string;
  family: string;
  query: string;
  /** Expected memory ids. Empty for no-answer queries. */
  expectedIds: number[];
  /**
   * Memory ids that represent the CURRENT truth for this
   * query. For non-temporal families this is the same as
   * `expectedIds`. For the `temporal` family the expected id
   * IS the current fact, so this matches `expectedIds`; the
   * field is kept separate so the current-truth@1 metric is
   * a labeled, first-class concept in the data. Empty for
   * no-answer queries.
   */
  currentTruthIds: number[];
  /**
   * Top-K ids actually returned by the ranker, in rank order.
   * Empty if the ranker returned no hits.
   */
  topIds: number[];
  /** Per-candidate score, in the same order as `topIds`. */
  topScores: number[];
  /**
   * `true` iff the top result is one of `expectedIds`. For
   * no-answer queries, `topIds` is empty, so `rank1` is
   * `false` by definition (no positive id can be at rank 1).
   */
  rank1: boolean;
  /**
   * `true` iff the top result is one of `currentTruthIds`. For
   * no-answer queries, `currentTruthAt1` is `false` by
   * definition. For non-temporal positive queries this is the
   * same as `rank1` by construction.
   */
  currentTruthAt1: boolean;
  /**
   * `true` iff the run matched the hit@K expectation:
   *   - positive families: at least one expected id in top-K.
   *   - no-answer family: top-K is empty.
   *
   * Note: `passed` is the hit@K contract, NOT the rank-1
   * contract. A temporal query can have `passed === true`
   * (current fact in top-K) with `rank1 === false` (old fact
   * at the top) and `currentTruthAt1 === false`. That is the
   * gap the stricter metric is designed to surface.
   */
  passed: boolean;
  /**
   * Short human reason. Always non-empty so failure reports
   * show why the run did not pass.
   */
  reason: string;
  /**
   * Per-source RRF contributor breakdown for the top-K
   * returned by the hybrid (RRF) variant. Present only
   * on the hybrid report; `undefined` on lexical / FTS5 /
   * vector reports so the existing per-variant report
   * shapes are byte-stable. The list has one entry per
   * source (lexical, fts5, vector) in that order, with
   * `rank: null` / `score: null` for sources that did
   * not return the candidate. The RRF contribution is
   * `weight / (k + rank)`, or 0 if the candidate was
   * absent from the source. The richer-diagnostics
   * block the Architect's brief asks for.
   */
  hybridContributors?: ReadonlyArray<{
    source: "lexical" | "fts5" | "vector";
    rank: number | null;
    score: number | null;
    contribution: number;
    weight: number;
  }>;
  /**
   * Hybrid RRF score for the top-1 candidate, or `null`
   * if the top-K is empty. Present only on the hybrid
   * report. The score is on the RRF scale
   * (`Σ weight / (k + rank)`); the absolute value is not
   * comparable to the lexical / FTS5 / vector scores
   * because the three scales are different. The richer-
   * diagnostics block uses it to show how confident the
   * fusion was in the top-1.
   */
  hybridTopScore?: number | null;
}

// ---------------------------------------------------------------------------
// Hybrid per-family delta helper
// ---------------------------------------------------------------------------

/**
 * One row of the hybrid per-family delta table. The table
 * is the "hybrid vs best baseline" richer-diagnostics
 * block the brief asks for. For each family:
 *
 *   - `hybridRank1` / `hybridHit5`           — the hybrid's
 *     raw count of rank-1 / hit-5 across the family's
 *     queries.
 *   - `lexicalRank1` / `fts5Rank1` / `vectorRank1` — the
 *     three single-variant rank-1 counts for the same
 *     family.
 *   - `bestBaselineRank1`                    — the max of
 *     the three baseline rank-1 counts; the "best
 *     baseline" the hybrid is being compared to.
 *   - `deltaHybridVsLexical` / `deltaHybridVsBest` —
 *     the rank-1 delta against the lexical baseline and
 *     the best baseline. Positive means the hybrid is
 *     better.
 *   - `hybridTnr` / `bestBaselineTnr`         — no-answer
 *     TNR (specificity) for the family. For the
 *     `no-answer` family these are the headline
 *     numbers; for positive families the no-answer count
 *     is 0 so the TNR is 0 by definition.
 */
export interface HybridPerFamilyDeltaRow {
  family: string;
  total: number;
  hybridRank1: number;
  hybridHit5: number;
  lexicalRank1: number;
  fts5Rank1: number;
  vectorRank1: number;
  bestBaselineRank1: number;
  deltaHybridVsLexical: number;
  deltaHybridVsBest: number;
  hybridTnr: number;
  bestBaselineTnr: number;
  /** Convenience: the names of the variants that tied
   *  for the best baseline at rank-1, in canonical
   *  order. Empty when all three baselines are 0. */
  bestBaselineSources: ReadonlyArray<"lexical" | "fts5" | "vector">;
}

/**
 * Build the per-family delta table from four
 * `RetrievalBenchmarkReport`s: hybrid, lexical, fts5,
 * vector. The reports must have been run on the same
 * corpus and query set, which is the standard benchmark
 * contract; mixing runs from different corpora would
 * invalidate the per-family counts. The function is
 * pure: no I/O, no mutation.
 */
export function buildHybridPerFamilyDelta(
  hybrid: BenchmarkMetrics,
  lexical: BenchmarkMetrics,
  fts5: BenchmarkMetrics,
  vector: BenchmarkMetrics,
): HybridPerFamilyDeltaRow[] {
  const families = new Set<string>();
  for (const f of Object.keys(hybrid.perFamily)) families.add(f);
  for (const f of Object.keys(lexical.perFamily)) families.add(f);
  for (const f of Object.keys(fts5.perFamily)) families.add(f);
  for (const f of Object.keys(vector.perFamily)) families.add(f);
  const sortedFamilies = [...families].sort();
  const out: HybridPerFamilyDeltaRow[] = [];
  for (const f of sortedFamilies) {
    const h = hybrid.perFamily[f];
    const l = lexical.perFamily[f];
    const v = fts5.perFamily[f];
    const w = vector.perFamily[f];
    // A family present in the hybrid report but missing
    // from a baseline (or vice versa) is reported with
    // 0 for the missing side. The benchmark runner runs
    // all four variants on the same query set, so in
    // practice the families are identical.
    const hR1 = h?.rank1 ?? 0;
    const hH5 = h?.hitAt5 ?? 0;
    const lR1 = l?.rank1 ?? 0;
    const vR1 = v?.rank1 ?? 0;
    const wR1 = w?.rank1 ?? 0;
    const best = Math.max(lR1, vR1, wR1);
    const sources: Array<"lexical" | "fts5" | "vector"> = [];
    if (lR1 === best) sources.push("lexical");
    if (vR1 === best) sources.push("fts5");
    if (wR1 === best) sources.push("vector");
    if (best === 0) sources.length = 0;
    // No-answer TNR (specificity) for the family. The
    // baseline reports keep the no-answer family as the
    // only family where noAnswerCorrect is non-zero; for
    // positive families the metric is 0 by definition.
    const hTnr = h?.noAnswerCorrect ?? 0;
    const baselineTnrValues = [
      l?.noAnswerCorrect ?? 0,
      v?.noAnswerCorrect ?? 0,
      w?.noAnswerCorrect ?? 0,
    ];
    const bestTnr = Math.max(...baselineTnrValues);
    out.push({
      family: f,
      total: h?.total ?? l?.total ?? v?.total ?? w?.total ?? 0,
      hybridRank1: hR1,
      hybridHit5: hH5,
      lexicalRank1: lR1,
      fts5Rank1: vR1,
      vectorRank1: wR1,
      bestBaselineRank1: best,
      deltaHybridVsLexical: hR1 - lR1,
      deltaHybridVsBest: hR1 - best,
      hybridTnr: hTnr,
      bestBaselineTnr: bestTnr,
      bestBaselineSources: sources,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregated metrics
// ---------------------------------------------------------------------------

/**
 * Derived IR / classification metrics. All counts and
 * denominators are reported alongside the percentages so a
 * reviewer can re-derive any percentage by hand and the
 * report can be sanity-checked against the headline
 * hit@K / rank1 numbers.
 */
export interface DerivedMetrics {
  // IR @ K (positive families only)
  /** Micro-averaged precision@K across positive queries.
   *  `tp@K / (tp@K + fp@K)` summed then divided by query
   *  count. */
  precisionAtK: number;
  /** Micro-averaged recall@K across positive queries.
   *  `tp@K / (tp@K + fn@K)` summed then divided by query
   *  count. `tp@K + fn@K == |expectedIds|` for a query
   *  because the only "false negative" a candidate retriever
   *  can produce is a missed expected id. */
  recallAtK: number;
  /** F1@5 (harmonic mean of precision@5 and recall@5) at the
   *  headline K. */
  f1At5: number;
  /** Mean reciprocal rank truncated at HEADLINE_MRR_K. For a
   *  positive query with no expected id in the top-K, the
   *  reciprocal rank is 0. The mean is over positive queries
   *  only; no-answer queries are excluded. */
  mrrAtK: number;
  /** Raw counts that drive the percentages above. Kept on
   *  the report so a reviewer can re-derive anything by
   *  hand. */
  tp: number;
  fp: number;
  fn: number;

  // Multi-hop / list coverage
  /** Queries whose top-K contained AT LEAST ONE expected id.
   *  Same number as `hitAtK` in the existing aggregate, kept
   *  here under a clearer name for the multi-hop family. */
  multiHopAny: number;
  /** Queries whose top-K contained EVERY expected id. */
  multiHopComplete: number;
  /** Total multi-hop queries. */
  multiHopTotal: number;
  /** `multiHopAny / multiHopTotal` and
   *  `multiHopComplete / multiHopTotal`. */
  multiHopAnyRate: number;
  multiHopCompleteRate: number;

  // No-answer confusion matrix
  /** True positive: a positive query with at least one
   *  expected id in top-K. (Same number as `hitAtK`.) */
  noAnswerTp: number;
  /** False positive: a no-answer query with at least one
   *  candidate in top-K. */
  noAnswerFp: number;
  /** True negative: a no-answer query with empty top-K. */
  noAnswerTn: number;
  /** False negative: a positive query with empty top-K. */
  noAnswerFn: number;
  /** Specificity / TNR = TN / (TN + FP). */
  noAnswerSpecificity: number;
  /** Confabulation / false-positive rate = FP / (FP + TN).
   *  The symmetric "we made something up" rate for
   *  no-answer queries. */
  noAnswerFpr: number;
  /** Answer coverage = TP / (TP + FN) for positive queries
   *  alone. Numerically identical to `hitAtK / positiveTotal`
   *  in the existing aggregate, reported under a clearer
   *  name. */
  answerCoverage: number;
  /** Abstention precision = TN / (TN + FN). The probability
   *  that, given the system abstained (top-K empty), the
   *  abstention was correct. */
  abstentionPrecision: number;

  // currentTruth@K
  /** currentTruth@1 / @3 / @5 across positive queries.
   *  For non-temporal families each of these equals
   *  `rank1` (the expected id IS the current fact). For the
   *  temporal family the @3 / @5 numbers let a reviewer see
   *  whether the current fact appears anywhere in the
   *  top-K vs only at the top. */
  currentTruthAt1: number;
  currentTruthAt3: number;
  currentTruthAt5: number;
  /** `currentTruthAt5 / positiveTotal`. Like
   *  `currentTruthRecall@5`: what fraction of positive
   *  queries had the CURRENT fact in the top-K? For
   *  non-temporal families this equals the existing
   *  `currentTruthAt1` / `rank1` number. */
  currentTruthRecallAt5: number;
  /** Number of positive queries that have at least one
   *  `currentTruthId` in the top-K. */
  currentTruthHitsAt5: number;
  /** Total positive queries. */
  positiveTotalForCurrentTruth: number;

  // Score diagnostics
  /** Mean top-1 score across all positive queries, separated
   *  by pass / fail outcome. */
  meanTopScorePass: number;
  meanTopScoreFail: number;
  /** Mean score gap between rank-1 and rank-2 across all
   *  positive queries that have at least two candidates.
   *  A small gap means the ranker is barely confident; a
   *  large gap means the rank-1 is clearly the best. */
  meanScoreGap1To2: number;
  /** Mean number of returned candidates per query (the
   *  ranker may return fewer than topK for a no-match
   *  query). */
  meanReturnedCount: number;
  /** Overall mean top-1 score across all queries. */
  meanTopScore: number;
  /** Overall mean top-1 score across no-answer queries. A
   *  high value here is a confabulation signal: the ranker
   *  is returning confidently-wrong candidates for queries
   *  that should return nothing. */
  meanTopScoreNoAnswer: number;
  /** Denominator counts for the per-outcome means. */
  scoreSampleCountPass: number;
  scoreSampleCountFail: number;
  scoreSampleCountNoAnswer: number;
  scoreSampleCountAll: number;
}

/**
 * Per-family aggregate. Keeps the existing fields (total,
 * passed, hit@1, hit@3, hit@5, rank1, currentTruthAt1,
 * noAnswerCorrect) and adds the family-scoped derived metrics
 * so a reviewer can see per-family precision/recall/F1/MRR
 * without re-aggregating by hand.
 */
export interface PerFamilyMetrics {
  total: number;
  passed: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  rank1: number;
  currentTruthAt1: number;
  noAnswerCorrect: number;
  /** Family-level precision@5 and recall@5. */
  precisionAt5: number;
  recallAt5: number;
  f1At5: number;
  /** Family-level MRR@5. 0 for no-answer families. */
  mrrAt5: number;
  /** Family-level TP / FP / FN raw counts. */
  tp: number;
  fp: number;
  fn: number;
}

/**
 * Aggregated metrics for a benchmark run.
 */
export interface BenchmarkMetrics {
  totalQueries: number;
  /**
   * Counts of positive queries (non `no-answer`) by `hit@K`.
   * `hitAtK` is the number of positive queries whose top-K
   * contains at least one expected id.
   */
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  /**
   * Counts of positive queries (non `no-answer`) by the
   * stricter top-hit metric. `rank1` is the number of
   * positive queries whose TOP result is one of the expected
   * ids. `currentTruthAt1` is the number of positive queries
   * whose TOP result is one of the `currentTruthIds`. For
   * non-temporal families the two are equal by construction.
   * For the `temporal` family `currentTruthAt1` is the
   * reviewer-flagged metric: the old fact can be in the top-K
   * (so `hitAtK` passes) but still rank above the current
   * fact (so `currentTruthAt1` fails).
   */
  rank1: number;
  currentTruthAt1: number;
  /** Total positive queries. */
  positiveTotal: number;
  /**
   * True negative rate for no-answer queries:
   * `noAnswerCorrect / noAnswerTotal`. A no-answer query is
   * correct iff the ranker returned zero hits.
   */
  noAnswerCorrect: number;
  noAnswerTotal: number;
  /** Per-family breakdown. */
  perFamily: Record<string, PerFamilyMetrics>;
  /** Aggregate derived metrics. */
  derived: DerivedMetrics;
  /**
   * Structured failure categories. The same `evals` list is
   * the source; the categoriser assigns a `category` to each
   * failing query so the report can show "N temporal
   * wrong-rank1", "M paraphrase misses", etc., without
   * scanning the failure list. Keys are stable strings;
   * values are counts.
   */
  failureCategories: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Orientation metrics
// ---------------------------------------------------------------------------

/**
 * Orientation metrics for project-status queries. This is a
 * sub-aggregate scoped to queries whose family is
 * `"orientation"`. The metrics are:
 *
 *   - `recallAt1` / `recallAt3` / `recallAt5` — at least one
 *     expected id in the top-K, micro-averaged across
 *     orientation queries. The headline retrieval-coverage
 *     numbers for the orientation family.
 *   - `slotsExpected` / `slotsHit` / `slotCoverageAt5` — a
 *     query may declare multiple "slots" (e.g. "current
 *     Postgres version AND current release schedule"). The
 *     slot coverage is `sum(slots_hit) / sum(slots_expected)`,
 *     the fraction of all expected slots that are covered by
 *     the top-K, not the fraction of queries that covered all
 *     of their slots. This is more informative for multi-slot
 *     queries than the binary `recallAtK`.
 *   - `noisyReturnQueries` / `noisyReturnRate` — fraction of
 *     orientation queries whose top-K contains a known
 *     distractor (any office / historical record). The
 *     distractor set is `getKnownDistractorIds()`: for the
 *     24-record project corpus the distractor clusters are
 *     `office` (records 13..16) and the historical-previous
 *     versions (records 21..24). This is the user-visible
 *     noise signal: a project-status query that surfaces the
 *     office dishwasher (or a previous Postgres version) is
 *     surfacing a known distractor. The metric is binary per
 *     query ("did the top-K touch a known distractor at
 *     all?"), not a per-candidate noise rate; a finer-grained
 *     per-candidate noise rate is intentionally out of scope
 *     and would require a per-query "noise label" that the
 *     fixture corpus does not carry.
 *   - `meanNoisePerQuery` — mean number of distractor
 *     candidates in the top-K across orientation queries.
 *     Complements `noisyReturnRate`: a query can be "noisy"
 *     (binary yes) but mostly-signal (a single distractor
 *     tucked at the end of the list) or mostly-noise (every
 *     candidate is a distractor).
 *   - `currentTruthCoverageAt5` / `currentTruthCoverageAt5Rate`
 *     — fraction of orientation queries whose top-5 contains
 *     a `currentTruthId`. Project-status queries are often
 *     about the current state, so the "current" labelling
 *     applies here too. If the orientation corpus has no
 *     temporal gap (the expected id IS the current fact),
 *     this is the same as `recallAt5` / `recallAt5 / total`.
 */
export interface OrientationMetrics {
  total: number;
  /** Queries whose top-5 contains at least one expected id. */
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  /** Sum of expected slots across all orientation queries. */
  slotsExpected: number;
  /** Sum of expected slots that the top-5 covers. */
  slotsHit: number;
  slotCoverageAt5: number;
  /** Orientation queries whose top-5 contains a known
   *  distractor (office / historical record). */
  noisyReturnQueries: number;
  noisyReturnRate: number;
  /** Mean number of distractor candidates in the top-5
   *  across orientation queries. */
  meanNoisePerQuery: number;
  /** Queries whose top-5 contains a `currentTruthId`. */
  currentTruthCoverageAt5: number;
  currentTruthCoverageAt5Rate: number;
}

// ---------------------------------------------------------------------------
// Answer-quality scaffold
// ---------------------------------------------------------------------------

/**
 * Answer-quality scaffold. Future phases will plug an LLM
 * judge (or a heuristic) into this scaffold and emit a
 * per-query quality score. For this phase, the scaffold is
 * exported, the runner always emits `enabled: false` with
 * `null` evaluations, and the human report labels the
 * scaffold as "disabled / not evaluated".
 *
 * The shape is intentionally narrow: a boolean enabled flag,
 * a placeholder provider name (so a future "minimax-judge" or
 * "local-heuristic-judge" can be reported in the artifact
 * without a schema change), and a stable `evaluations` array
 * shape keyed by `queryId` so a consumer can `null`-check
 * cleanly.
 */
export interface AnswerQualityScaffold {
  /**
   * `true` iff the scaffold is wired into the runner and
   * producing per-query evaluations. The runner in this
   * phase always reports `false`.
   */
  enabled: boolean;
  /**
   * Stable human label of the judge that WOULD be used, or
   * `null` if no judge is configured. Kept separate from
   * `enabled` so a future phase can flip `enabled` to
   * `true` without losing the provider name on disk.
   */
  provider: string | null;
  /**
   * Per-query evaluations keyed by `queryId`. The runner
   * does NOT populate this array; it is `null` while the
   * scaffold is disabled so the report shows "not
   * evaluated" rather than an empty list.
   */
  evaluations: ReadonlyArray<AnswerQualityEvaluation> | null;
  /**
   * Free-form note for the reviewer. Used to make the
   * disabled state visible in the report.
   */
  note: string;
}

/**
 * Per-query answer-quality evaluation shape. A future
 * `enabled: true` pass would populate this with the LLM
 * judge's verdict (faithful, partial, off-topic, refusal,
 * etc.), a numeric score in [0, 1], and a short reason. For
 * now, the runner never produces one.
 */
export interface AnswerQualityEvaluation {
  queryId: string;
  /** Faithfulness label (judge-specific). Reserved for the
   *  future provider. */
  label: string;
  /** Numeric score in [0, 1]. Reserved. */
  score: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Bootstrap CI (deterministic, lightweight)
// ---------------------------------------------------------------------------

/**
 * Deterministic bootstrap confidence interval for a binary
 * metric. We DO NOT add bootstrap to the headline number;
 * the runner reports the raw count + percentage, and any
 * future reporter that wants a CI can call this helper. The
 * function is small and self-contained: it resamples the
 * pass/fail outcomes with replacement using a fixed seed,
 * sorts the resampled proportions, and returns the 2.5 /
 * 97.5 percentile bounds. Determinism is important because
 * the benchmark report is checked in as a regression
 * artifact; a non-deterministic CI would make byte-equal
 * comparisons noisy.
 */
export interface BootstrapCi {
  /** 2.5th percentile of the resampled proportion. */
  low: number;
  /** 97.5th percentile. */
  high: number;
  /** Number of bootstrap resamples used. */
  resamples: number;
}

const DEFAULT_BOOTSTRAP_RESAMPLES = 1000;
const DEFAULT_BOOTSTRAP_SEED = 0xc07ec0;

/**
 * Deterministic 32-bit PRNG. We avoid `Math.random` so the
 * bootstrap is reproducible across machines and Node
 * versions. The implementation is a tiny LCG with a fixed
 * multiplier, increment, and modulus. Statistical quality is
 * NOT the point; the point is byte-stable output and a
 * uniform distribution over `[0, 1)` for the purposes of
 * resampling. A real bootstrap can swap in a better PRNG
 * later without changing the function signature.
 */
function makeLcg(seed: number): () => number {
  // Constants from the classic MMIX LCG; large enough
  // prime-ish multipliers give reasonable spread for
  // resampling thousands of binary outcomes.
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 6364136223846793005) + 1442695040888963407) >>> 0;
    return s / 0x100000000;
  };
}

export function bootstrapCi(
  outcomes: ReadonlyArray<boolean>,
  options: { resamples?: number; seed?: number } = {},
): BootstrapCi {
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const n = outcomes.length;
  if (n === 0) {
    return { low: 0, high: 0, resamples };
  }
  const rand = makeLcg(seed);
  // Pre-compute the index set once; the resampler picks
  // from the same array (with replacement) for every
  // resample. The implementation is intentionally simple
  // (no fancy sort / no parallel) — the headline metric
  // aggregates at most ~50 queries so the cost is
  // negligible.
  const proportions = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let pass = 0;
    for (let i = 0; i < n; i++) {
      // `Math.floor(rand() * n)` is uniform over
      // `[0, n)`. The `n > 0` guard above means we never
      // call `rand` with a 0 multiplier.
      const idx = Math.floor(rand() * n);
      if (outcomes[idx]) pass += 1;
    }
    proportions[r] = pass / n;
  }
  const sorted = Array.from(proportions).sort((a, b) => a - b);
  const lowIdx = Math.max(0, Math.floor(0.025 * (resamples - 1)));
  const highIdx = Math.min(resamples - 1, Math.floor(0.975 * (resamples - 1)));
  return {
    low: sorted[lowIdx]!,
    high: sorted[highIdx]!,
    resamples,
  };
}

// ---------------------------------------------------------------------------
// Hit / pass computation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single query.
 *
 * `@param topIds`  - the ranked id list returned by the ranker.
 * `@param topScores` - the score for each id, parallel to `topIds`.
 * `@param currentTruthIds` - the ids that represent the CURRENT
 *   truth for this query. For non-temporal families this is the
 *   same as `expectedIds`. For the `temporal` family the
 *   expected id IS the current fact, so it is also the same as
 *   `expectedIds`. Empty for no-answer queries.
 *
 * For positive families, the query passes iff at least one of the
 * expected ids is in the top-K. For the no-answer family, the
 * query passes iff the top-K is empty (or, equivalently, has no
 * entries).
 *
 * Per-query `rank1` and `currentTruthAt1` are also produced and
 * are reported independently of `passed`. A temporal query can
 * pass (current fact in top-K) while having `rank1: false` and
 * `currentTruthAt1: false` (old fact at the top). That is the
 * gap the stricter metric is designed to surface.
 */
export function evaluateQuery(
  queryId: string,
  family: string,
  query: string,
  expectedIds: number[],
  currentTruthIds: number[],
  topIds: number[],
  topScores: number[],
): QueryEval {
  const expected = new Set(expectedIds);
  const currentTruth = new Set(currentTruthIds);
  if (expected.size === 0) {
    // no-answer query. `rank1` and `currentTruthAt1` are
    // `false` by definition: an empty top-K has no id at
    // position 0, so no positive id can be at rank 1.
    if (topIds.length === 0) {
      return {
        queryId,
        family,
        query,
        expectedIds: [...expectedIds],
        currentTruthIds: [...currentTruthIds],
        topIds: [...topIds],
        topScores: [...topScores],
        rank1: false,
        currentTruthAt1: false,
        passed: true,
        reason: "no-answer query; ranker returned zero hits",
      };
    }
    return {
      queryId,
      family,
      query,
      expectedIds: [...expectedIds],
      currentTruthIds: [...currentTruthIds],
      topIds: [...topIds],
      topScores: [...topScores],
      rank1: false,
      currentTruthAt1: false,
      passed: false,
      reason: `no-answer query; ranker returned ${topIds.length} hit(s)`,
    };
  }
  // positive family
  const top0 = topIds.length >= 1 ? topIds[0]! : undefined;
  const rank1 = top0 !== undefined && expected.has(top0);
  const currentTruthAt1 = top0 !== undefined && currentTruth.has(top0);
  const hitAt1 = rank1; // alias kept for the existing hit@K aggregation
  const hitAt3 = topIds.slice(0, 3).some((id) => expected.has(id));
  const hitAt5 = topIds.slice(0, 5).some((id) => expected.has(id));
  // For "passed" we use hit@5 (the most generous of the three).
  // This is consistent with treating the baseline as a candidate
  // retriever: a relevant id in the top-5 is "retrievable" even
  // if it is not the top hit.
  if (hitAt5) {
    return {
      queryId,
      family,
      query,
      expectedIds: [...expectedIds],
      currentTruthIds: [...currentTruthIds],
      topIds: [...topIds],
      topScores: [...topScores],
      rank1,
      currentTruthAt1,
      passed: true,
      reason: hitAt1
        ? "expected id in top-1"
        : hitAt3
          ? "expected id in top-3"
          : "expected id in top-5",
    };
  }
  return {
    queryId,
    family,
    query,
    expectedIds: [...expectedIds],
    currentTruthIds: [...currentTruthIds],
    topIds: [...topIds],
    topScores: [...topScores],
    rank1,
    currentTruthAt1,
    passed: false,
    reason: `none of the expected ids (${expectedIds.join(", ")}) appeared in top-5`,
  };
}

// ---------------------------------------------------------------------------
// Helpers used by aggregateMetrics and by the runner
// ---------------------------------------------------------------------------

/**
 * Compute the set of "known distractor" ids in the benchmark
 * corpus. The runner passes the result into the orientation
 * noise metric so a project-status query that surfaces a
 * kitchen / historical record is flagged as noisy. The set
 * is derived from the corpus IDs in `corpus.ts`: records
 * 13..16 are the office cluster and 21..24 are the
 * historical-previous versions. A future phase can replace
 * this with a query-supplied "noise labels" map; the
 * function is exported and stable so the contract is
 * testable.
 */
export function getKnownDistractorIds(): ReadonlySet<number> {
  // Records 13..16 (office) + 21..24 (historical). Stable
  // and explicit so the test asserting the noise rate can
  // hard-code the expected set.
  const out = new Set<number>();
  for (let i = 13; i <= 16; i++) out.add(i);
  for (let i = 21; i <= 24; i++) out.add(i);
  return out;
}

/**
 * Categorize a single failing query. The function is exported
 * so tests can pin the categories by hand. The labels are
 * stable strings; the report can group failures by category
 * and a future UI can pivot on them. New categories must be
 * added here and added to the test that pins the category
 * table; they are NOT added implicitly.
 */
export function categorizeFailure(e: QueryEval): string {
  if (e.family === "no-answer") {
    if (e.topIds.length > 0) {
      return "no-answer-fp:ranker-returned-hits";
    }
    // no-answer query that passed (no hits) should never
    // reach the categoriser; defensively return a stable
    // label so the report is well-formed.
    return "no-answer-tn:pass";
  }
  if (e.family === "temporal") {
    if (e.passed && !e.currentTruthAt1) {
      return "temporal:wrong-rank1-old-fact-on-top";
    }
    if (!e.passed) {
      return "temporal:current-fact-missing";
    }
    return "temporal:pass-rank1-correct";
  }
  if (e.family === "paraphrase") {
    return "paraphrase:vocabulary-mismatch";
  }
  if (e.family === "multi-hop") {
    return "multi-hop:no-relevant-in-top-k";
  }
  if (e.family === "orientation") {
    return "orientation:project-status-not-surfaced";
  }
  if (e.family === "exact") {
    return "exact:relevant-missing";
  }
  return "other:uncategorized";
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-query evaluations into the summary metrics.
 *
 * The function is pure: it consumes the eval list, returns the
 * metrics object, and never mutates its input. The Ks are
 * hard-coded to 1, 3, 5 to match the documented benchmark
 * contract; changing them here is a contract change.
 */
export function aggregateMetrics(evals: QueryEval[]): BenchmarkMetrics {
  const perFamilyRaw: Record<string, PerFamilyRawSlot> = {};
  let positiveTotal = 0;
  let hitAt1 = 0;
  let hitAt3 = 0;
  let hitAt5 = 0;
  let rank1 = 0;
  // The aggregate `currentTruthAt1` field is the count of
  // positive queries whose per-eval `currentTruthAt1` flag
  // is true. The derived block tracks the same notion at
  // multiple Ks; the per-K derived counters are kept
  // separate from the aggregate accumulator so we never
  // double-count.
  let currentTruthAt1 = 0;
  let noAnswerTotal = 0;
  let noAnswerCorrect = 0;

  // Aggregate derived metrics accumulators.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let mrrSum = 0;
  let mrrDenom = 0;
  // Per-K current-truth counters used by the derived
  // block. These are recomputed independently from
  // `currentTruthAt1` (which is the per-eval-flag-driven
  // aggregate) so a query whose `currentTruthAt1` flag is
  // true and whose current-truth id is also in top-3 only
  // shows up in the right buckets.
  let currentTruthHitsAt1 = 0;
  let currentTruthHitsAt3 = 0;
  let currentTruthHitsAt5 = 0;
  let sumTopScoreAll = 0;
  let sumTopScorePass = 0;
  let sumTopScoreFail = 0;
  let sumTopScoreNoAnswer = 0;
  let sumGap1To2 = 0;
  let gapSampleCount = 0;
  let sumReturnedCount = 0;
  let countAll = 0;
  let countPass = 0;
  let countFail = 0;
  let countNoAnswer = 0;
  let multiHopAny = 0;
  let multiHopComplete = 0;
  let multiHopTotal = 0;

  const failureCategories: Record<string, number> = {};

  for (const e of evals) {
    const f = e.family;
    const slot = perFamilyRaw[f] ?? freshPerFamily();
    slot.total += 1;
    if (e.passed) slot.passed += 1;

    // Score diagnostics — every query contributes to the
    // overall mean and to the pass/fail subset means. A
    // query with no top-1 has top score 0 (rather than
    // NaN) so the per-query mean is well-formed for a
    // no-hit run. The score gap (rank-1 vs rank-2) is
    // ONLY accumulated for positive queries: a no-answer
    // query's "gap" mixes the noise signal (ranker
    // returned something for a query that should have
    // returned nothing) with the ranker's confidence,
    // which is a different concern. Keeping the gap
    // positive-only makes the per-family lines on the
    // report interpretable.
    const top0Score = e.topScores.length > 0 ? e.topScores[0]! : 0;
    sumTopScoreAll += top0Score;
    countAll += 1;
    sumReturnedCount += e.topIds.length;
    if (e.expectedIds.length > 0 && e.topIds.length >= 2) {
      const s0 = e.topScores[0]!;
      const s1 = e.topScores[1]!;
      sumGap1To2 += s0 - s1;
      gapSampleCount += 1;
    }
    if (e.family === "no-answer") {
      countNoAnswer += 1;
      sumTopScoreNoAnswer += top0Score;
    } else if (e.passed) {
      countPass += 1;
      sumTopScorePass += top0Score;
    } else {
      countFail += 1;
      sumTopScoreFail += top0Score;
    }

    if (e.expectedIds.length === 0) {
      // no-answer family: rank1 / currentTruthAt1 are always
      // false by definition (empty top-K) and are not counted
      // in the per-family or aggregate rank1 buckets.
      noAnswerTotal += 1;
      if (e.passed) {
        noAnswerCorrect += 1;
        slot.noAnswerCorrect += 1;
      } else {
        // No-answer query with at least one hit -> FP.
        // The TP/FP/FN/FP we count here is the
        // binary "this query was answered correctly"
        // confusion matrix, not the per-candidate one.
        fp += 1;
      }
    } else {
      // positive family
      positiveTotal += 1;

      // Per-candidate counts. For each expected id,
      // it is a TP if it is in the top-K and an FN if
      // it is not. Each non-expected id in the top-K
      // is an FP. We count over the ranker's actual
      // top-K (whatever size it returned, not a fixed
      // K), so precision / recall are defined on the
      // ranker's return set.
      const expectedSet = new Set(e.expectedIds);
      const topSet = new Set(e.topIds);
      let queryTp = 0;
      let queryFn = 0;
      for (const id of e.expectedIds) {
        if (topSet.has(id)) queryTp += 1;
        else queryFn += 1;
      }
      let queryFp = 0;
      for (const id of e.topIds) {
        if (!expectedSet.has(id)) queryFp += 1;
      }
      tp += queryTp;
      fn += queryFn;
      fp += queryFp;
      slot.tp += queryTp;
      slot.fp += queryFp;
      slot.fn += queryFn;

      // MRR@5 — reciprocal rank of the FIRST expected id
      // in the top-K (clipped at 5). 0 if none.
      let firstHitRank = 0;
      for (let i = 0; i < Math.min(HEADLINE_MRR_K, e.topIds.length); i++) {
        if (expectedSet.has(e.topIds[i]!)) {
          firstHitRank = i + 1;
          break;
        }
      }
      if (firstHitRank > 0) {
        mrrSum += 1 / firstHitRank;
      }
      mrrDenom += 1;
      slot.mrrSum = (slot.mrrSum ?? 0) + (firstHitRank > 0 ? 1 / firstHitRank : 0);

      // currentTruth@K (positive queries only) — the
      // derived-block counters. The aggregate
      // `currentTruthAt1` is computed below from the
      // per-eval `e.currentTruthAt1` flag.
      const ctSet = new Set(e.currentTruthIds);
      if (e.topIds.length >= 1 && ctSet.has(e.topIds[0]!)) {
        currentTruthHitsAt1 += 1;
      }
      if (e.topIds.slice(0, 3).some((id) => ctSet.has(id))) {
        currentTruthHitsAt3 += 1;
      }
      if (e.topIds.slice(0, 5).some((id) => ctSet.has(id))) {
        currentTruthHitsAt5 += 1;
      }

      if (e.rank1) {
        rank1 += 1;
        slot.rank1 += 1;
      }
      if (e.currentTruthAt1) {
        currentTruthAt1 += 1;
        slot.currentTruthAt1 += 1;
      }
      // `hitAt1` and `rank1` measure the same thing (expected
      // id at position 0) but are reported as separate fields
      // so the report can show them side by side. They are
      // kept in sync by construction.
      if (e.rank1) {
        hitAt1 += 1;
        slot.hitAt1 += 1;
      }
      if (e.topIds.slice(0, 3).some((id) => e.expectedIds.includes(id))) {
        hitAt3 += 1;
        slot.hitAt3 += 1;
      }
      if (e.topIds.slice(0, 5).some((id) => e.expectedIds.includes(id))) {
        hitAt5 += 1;
        slot.hitAt5 += 1;
      }

      // Multi-hop coverage: any-in-top-K vs complete coverage.
      if (e.family === "multi-hop") {
        multiHopTotal += 1;
        if (e.topIds.some((id) => expectedSet.has(id))) {
          multiHopAny += 1;
        }
        if (e.expectedIds.every((id) => topSet.has(id))) {
          multiHopComplete += 1;
        }
      }
    }

    // Failure categorization. We categorize every eval
    // that is a "failure" in any of the senses tracked by
    // the categoriser:
    //   - hit@K miss (`!e.passed` for positive families,
    //     or `e.passed === false` for no-answer — a hit
    //     for a no-answer query is a confabulation).
    //   - temporal wrong-rank1 (`e.passed === true` for
    //     hit@K but `e.currentTruthAt1 === false`).
    //
    // The wrong-rank1 case is the most important: a
    // temporal query that passes hit@K (the current fact
    // is in the top-K) but fails rank1 (the old fact is
    // at the top) is the reviewer-flagged gap. Excluding
    // it from the failure categories would lose the
    // signal the new metric was added to surface. The
    // categoriser handles this case in the `temporal`
    // branch.
    const isCategorizedAsFailure =
      !e.passed ||
      (e.family === "temporal" && e.passed && !e.currentTruthAt1);
    if (isCategorizedAsFailure) {
      const cat = categorizeFailure(e);
      failureCategories[cat] = (failureCategories[cat] ?? 0) + 1;
    }

    perFamilyRaw[f] = slot;
  }

  // Finalize per-family derived metrics.
  const perFamily: Record<string, PerFamilyMetrics> = {};
  for (const [name, slot] of Object.entries(perFamilyRaw)) {
    const pAt5 = slot.tp + slot.fp > 0 ? slot.tp / (slot.tp + slot.fp) : 0;
    const rAt5 = slot.tp + slot.fn > 0 ? slot.tp / (slot.tp + slot.fn) : 0;
    const f1 = pAt5 + rAt5 > 0 ? (2 * pAt5 * rAt5) / (pAt5 + rAt5) : 0;
    const mrr =
      slot.total > 0 ? (slot.mrrSum ?? 0) / Math.max(1, slot.total) : 0;
    perFamily[name] = {
      total: slot.total,
      passed: slot.passed,
      hitAt1: slot.hitAt1,
      hitAt3: slot.hitAt3,
      hitAt5: slot.hitAt5,
      rank1: slot.rank1,
      currentTruthAt1: slot.currentTruthAt1,
      noAnswerCorrect: slot.noAnswerCorrect,
      precisionAt5: pAt5,
      recallAt5: rAt5,
      f1At5: f1,
      mrrAt5: mrr,
      tp: slot.tp,
      fp: slot.fp,
      fn: slot.fn,
    };
  }

  // Aggregate precision@K and recall@K at the headline K.
  // We re-derive these from the raw TP/FP/FN over the
  // ranker's actual top-K (whatever size it returned) so
  // the numbers are the micro-average of per-query
  // precision/recall. The aggregated `precision` is
  // `TP / (TP + FP)` and `recall` is `TP / (TP + FN)`.
  // Both are 0 for an empty corpus.
  const precisionAtK = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recallAtK = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1At5 =
    precisionAtK + recallAtK > 0
      ? (2 * precisionAtK * recallAtK) / (precisionAtK + recallAtK)
      : 0;
  const mrrAtK = mrrDenom > 0 ? mrrSum / mrrDenom : 0;

  // No-answer confusion matrix in the binary
  // "did the system produce a top-K at all" sense.
  // - TP: positive query, top-K non-empty. (Same as
  //   `hitAtK > 0` in the existing aggregate.)
  // - FN: positive query, top-K empty.
  // - TN: no-answer query, top-K empty.
  // - FP: no-answer query, top-K non-empty.
  const noAnswerTp = positiveTotal - countPositiveWithEmptyTopK(evals);
  const noAnswerFn = countPositiveWithEmptyTopK(evals);
  const noAnswerTn = noAnswerCorrect;
  const noAnswerFp = noAnswerTotal - noAnswerCorrect;
  const specificity = noAnswerTn + noAnswerFp > 0
    ? noAnswerTn / (noAnswerTn + noAnswerFp)
    : 0;
  const fpr = noAnswerTn + noAnswerFp > 0
    ? noAnswerFp / (noAnswerFp + noAnswerTn)
    : 0;
  const answerCoverage = positiveTotal > 0
    ? noAnswerTp / Math.max(1, positiveTotal)
    : 0;
  // Abstention precision: TN / (TN + FN). If the
  // system abstained (empty top-K), was it right?
  const abstentionPrecision = noAnswerTn + noAnswerFn > 0
    ? noAnswerTn / (noAnswerTn + noAnswerFn)
    : 0;

  const currentTruthRecallAt5 = positiveTotal > 0
    ? currentTruthHitsAt5 / Math.max(1, positiveTotal)
    : 0;

  const derived: DerivedMetrics = {
    precisionAtK,
    recallAtK,
    f1At5,
    mrrAtK,
    tp,
    fp,
    fn,
    multiHopAny,
    multiHopComplete,
    multiHopTotal,
    multiHopAnyRate: multiHopTotal > 0 ? multiHopAny / multiHopTotal : 0,
    multiHopCompleteRate:
      multiHopTotal > 0 ? multiHopComplete / multiHopTotal : 0,
    noAnswerTp,
    noAnswerFp,
    noAnswerTn,
    noAnswerFn,
    noAnswerSpecificity: specificity,
    noAnswerFpr: fpr,
    answerCoverage,
    abstentionPrecision,
    currentTruthAt1: currentTruthHitsAt1,
    currentTruthAt3: currentTruthHitsAt3,
    currentTruthAt5: currentTruthHitsAt5,
    currentTruthRecallAt5,
    currentTruthHitsAt5,
    positiveTotalForCurrentTruth: positiveTotal,
    meanTopScorePass: countPass > 0 ? sumTopScorePass / countPass : 0,
    meanTopScoreFail: countFail > 0 ? sumTopScoreFail / countFail : 0,
    meanScoreGap1To2:
      gapSampleCount > 0 ? sumGap1To2 / gapSampleCount : 0,
    meanReturnedCount: countAll > 0 ? sumReturnedCount / countAll : 0,
    meanTopScore: countAll > 0 ? sumTopScoreAll / countAll : 0,
    meanTopScoreNoAnswer:
      countNoAnswer > 0 ? sumTopScoreNoAnswer / countNoAnswer : 0,
    scoreSampleCountPass: countPass,
    scoreSampleCountFail: countFail,
    scoreSampleCountNoAnswer: countNoAnswer,
    scoreSampleCountAll: countAll,
  };

  return {
    totalQueries: evals.length,
    hitAt1,
    hitAt3,
    hitAt5,
    rank1,
    currentTruthAt1,
    positiveTotal,
    noAnswerCorrect,
    noAnswerTotal,
    perFamily,
    derived,
    failureCategories,
  };
}

/**
 * Count positive queries whose top-K is empty. Used by the
 * no-answer confusion matrix in `aggregateMetrics`. Exported
 * so the helper is independently testable.
 */
export function countPositiveWithEmptyTopK(evals: QueryEval[]): number {
  let n = 0;
  for (const e of evals) {
    if (e.expectedIds.length > 0 && e.topIds.length === 0) n += 1;
  }
  return n;
}

interface PerFamilyRawSlot {
  total: number;
  passed: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  rank1: number;
  currentTruthAt1: number;
  noAnswerCorrect: number;
  tp: number;
  fp: number;
  fn: number;
  mrrSum?: number;
}

function freshPerFamily(): PerFamilyRawSlot {
  return {
    total: 0,
    passed: 0,
    hitAt1: 0,
    hitAt3: 0,
    hitAt5: 0,
    rank1: 0,
    currentTruthAt1: 0,
    noAnswerCorrect: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    mrrSum: 0,
  };
}

// ---------------------------------------------------------------------------
// Orientation aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate orientation-specific metrics from a list of
 * per-query evals. Only queries with `family === "orientation"`
 * contribute; the rest are ignored. The function is pure and
 * deterministic.
 */
export function aggregateOrientationMetrics(
  evals: QueryEval[],
  options: { distractorIds?: ReadonlySet<number> } = {},
): OrientationMetrics {
  const distractors = options.distractorIds ?? getKnownDistractorIds();
  const orientation = evals.filter((e) => e.family === "orientation");
  let recallAt1 = 0;
  let recallAt3 = 0;
  let recallAt5 = 0;
  let slotsExpected = 0;
  let slotsHit = 0;
  let noisyReturnQueries = 0;
  let sumNoisePerQuery = 0;
  let currentTruthCoverageAt5 = 0;
  for (const e of orientation) {
    const expected = new Set(e.expectedIds);
    slotsExpected += expected.size;
    let slotsHitForQuery = 0;
    for (const id of e.expectedIds) {
      if (e.topIds.includes(id)) slotsHitForQuery += 1;
    }
    slotsHit += slotsHitForQuery;
    if (e.topIds.length >= 1 && e.topIds[0] !== undefined && expected.has(e.topIds[0])) {
      recallAt1 += 1;
    }
    if (e.topIds.slice(0, 3).some((id) => expected.has(id))) recallAt3 += 1;
    if (e.topIds.slice(0, 5).some((id) => expected.has(id))) recallAt5 += 1;
    const noiseForQuery = e.topIds.filter((id) => distractors.has(id)).length;
    sumNoisePerQuery += noiseForQuery;
    if (noiseForQuery > 0) noisyReturnQueries += 1;
    const ct = new Set(e.currentTruthIds);
    if (e.topIds.slice(0, 5).some((id) => ct.has(id))) {
      currentTruthCoverageAt5 += 1;
    }
  }
  const total = orientation.length;
  return {
    total,
    recallAt1,
    recallAt3,
    recallAt5,
    slotsExpected,
    slotsHit,
    slotCoverageAt5: slotsExpected > 0 ? slotsHit / slotsExpected : 0,
    noisyReturnQueries,
    noisyReturnRate: total > 0 ? noisyReturnQueries / total : 0,
    meanNoisePerQuery: total > 0 ? sumNoisePerQuery / total : 0,
    currentTruthCoverageAt5,
    currentTruthCoverageAt5Rate:
      total > 0 ? currentTruthCoverageAt5 / total : 0,
  };
}

// ---------------------------------------------------------------------------
// Answer-quality scaffold factory
// ---------------------------------------------------------------------------

/**
 * Build a disabled `AnswerQualityScaffold`. The runner calls
 * this in this phase. A future phase can wrap the function
 * with a judge; the public shape is stable.
 */
export function buildAnswerQualityScaffold(
  options: { note?: string } = {},
): AnswerQualityScaffold {
  return {
    enabled: false,
    provider: null,
    evaluations: null,
    note:
      options.note ??
      "answer-quality evaluation is scaffolded but disabled in this phase. " +
        "No provider / LLM judge is invoked; generated answers are not scored.",
  };
}
