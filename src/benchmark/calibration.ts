/**
 * Benchmark-only abstention / calibration experiment.
 *
 * Why this exists:
 *   The retrieval benchmark exposes a no-answer TNR (true
 *   negative rate) metric: the ranker abstains iff its top-K
 *   is empty. In production, the controller also abstains iff
 *   the top-K is empty. The default thresholds (lexical=0.2,
 *   fts5=0, vector=0) are mostly chosen for retrieval-quality
 *   reasons, not for abstention/calibration reasons. The
 *   Architect's brief asks for a benchmark-only study of how
 *   to set per-variant abstention gates that trade no-answer
 *   TNR against positive retrieval quality.
 *
 * Scope (benchmark-only):
 *   - This module is read-only and does not change the public
 *     MCP API or the production `recall(text)` behavior. It is
 *     NOT wired into the controller. The gates it computes are
 *     a research artifact, not a deployment policy.
 *   - No answer-quality evaluation. The scaffold is still
 *     disabled in this phase.
 *   - No corpus expansion. The 60-record fixture corpus and
 *     54-query query set are unchanged.
 *
 * Score semantics (handled in this module, not assumed):
 *   - lexical: 0..1+ Jaccard-style, "higher is better".
 *     threshold gates use `topScore >= t`.
 *   - fts5: already normalized in the variant to a positive
 *     0..1 score (`1 / (1 + |bm25|)`-style squash). The
 *     original `bm25()` value is negative (lower = better);
 *     the variant's `LexicalScoredCandidate.score` is already
 *     "higher is better". We document this in the report and
 *     assert it via a unit test.
 *   - vector: cosine similarity in [0, 1] for the
 *     non-negative L2-normalized BoW vectors produced by the
 *     default embedder. "Higher is better".
 *   - vector-dense: cosine similarity in [0, 1] for the
 *     non-negative L2-normalized vectors produced by the
 *     real local dense embedder (or the deterministic stub).
 *     "Higher is better" — same contract as `vector`. The
 *     same threshold / margin / ratio gate math applies.
 *   - hybrid-dense: Reciprocal Rank Fusion (RRF) score in
 *     (0, N/(k+1)] for N contributing variants, all weights
 *     1.0 by default. "Higher is better" — a higher RRF
 *     score means more contributors agreed on the top
 *     candidate. The same threshold / margin / ratio gate
 *     math applies, with the new "contributor support"
 *     diagnostic (per-source rank in the RRF top-1) added
 *     to the per-query trace.
 *
 * Gate taxonomy:
 *   - `threshold` — abstain iff `topScore < t`. The simplest
 *     absolute gate. Works for all three variants because all
 *     three return "higher is better" scores.
 *   - `margin`    — abstain iff `topScore - secondScore < m`,
 *     or if the ranker returned zero / one candidate. Captures
 *     "the ranker is barely confident the top is better than
 *     the runner-up".
 *   - `ratio`     — abstain iff `topScore / secondScore < r`
 *     (with second = 0 treated as ratio = +Infinity → pass).
 *     Captures the same idea as margin but in a relative form
 *     that is robust to per-corpus score-scale shifts.
 *   - `topScore`  — alias for `threshold` (kept for naming
 *     clarity at the call site).
 *
 *   The gates are OR-combined by default: the ranker abstains
 *   if ANY active gate triggers. A future calibration run
 *   could plug in AND / voting combinations, but the v1
 *   experiment uses OR (the conservative choice for a
 *   benchmark-only study).
 *
 * Per-query regression reporting:
 *   For every query the calibration pass records, per gate:
 *   - the original top-K ids and scores (no threshold),
 *   - the abstention decision under the active gates,
 *   - whether the abstention was "correct" (i.e. the
 *     abstention agreed with the gold label: a no-answer
 *     query should abstain, a positive query should not).
 *   - the per-family regression impact (positive queries
 *     forced to abstain count as regressions; no-answer
 *     queries that the ranker fixed by abstaining count as
 *     "no-answer FPs fixed").
 *
 *   This is the per-query diagnostic the Architect's brief
 *   asked for: topScore, secondScore, scoreGap, scoreRatio,
 *   gate decision, whether abstention was correct, before/
 *   after result ids.
 *
 * The calibration module NEVER mutates the production
 * controller, the public MCP API, or the existing single-
 * variant benchmark report shape. The output is a
 * `CalibrationReport` artifact that lives next to the
 * existing JSON reports under `.curion/benchmark/`.
 */

import type { QueryEval, BenchmarkMetrics } from "./metrics.js";
import type { LexicalScoredCandidate } from "../retrieval/lexical.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single abstention gate.
 *
 * `kind` is the gate family; `value` is its threshold. Gates
 * are evaluated independently and the ranker abstains if ANY
 * active gate triggers (OR-combination). Setting `active: false`
 * disables a gate without removing it from the report.
 */
export interface CalibrationGate {
  /** "threshold" | "margin" | "ratio" | "topScore". */
  kind: "threshold" | "margin" | "ratio" | "topScore";
  /** Gate value. Interpretation depends on `kind`. */
  value: number;
  /**
   * Whether the gate is active. Inactive gates are still
   * reported (so the sweep's full trace is on disk) but do not
   * contribute to the abstention decision. Default true.
   */
  active?: boolean;
  /**
   * Short human label for the report. Defaults to
   * `"<kind>@<value>"` if omitted.
   */
  label?: string;
}

/**
 * A calibration experiment. The runner composes a gate set
 * from this config, runs the benchmark under each gate, and
 * reports the trade-offs.
 */
export interface CalibrationConfig {
  /**
   * Per-variant gates. Each entry adds a gate to the
   * abstention check for that variant. A variant without an
   * entry is calibrated with no extra gate (i.e. abstention
   * decision is the same as the ranker's natural empty /
   * non-empty output).
   *
   * The `vector-dense` and `hybrid-dense` entries are
   * optional and only consulted by the dense calibration
   * runner; the sync `runCalibration` ignores them. The
   * existing lexical / fts5 / vector entries are unchanged
   * — adding the new keys is purely additive and the
   * existing calibration runner treats unknown keys as a
   * no-op.
   */
  gatesByVariant: {
    lexical?: CalibrationGate[];
    fts5?: CalibrationGate[];
    vector?: CalibrationGate[];
    /** Real dense vector variant (`vector-dense`). */
    vectorDense?: CalibrationGate[];
    /** Dense hybrid variant (`hybrid-dense`): RRF over
     *  lexical / FTS5 / vector-dense. */
    hybridDense?: CalibrationGate[];
  };
  /**
   * The "score sweep" — a small set of candidate gate values
   * to evaluate for each gate kind. The calibration report
   * emits one row per (variant, gate kind, candidate value)
   * so a reviewer can see the full trade-off curve, not just
   * a single chosen point.
   */
  sweep: {
    threshold?: number[];
    margin?: number[];
    ratio?: number[];
  };
  /**
   * Score direction override. The default is the variant's
   * documented direction (all three are "higher is better" in
   * the public `LexicalScoredCandidate.score`). Setting
   * `direction: "lower-is-better"` inverts the gate comparison
   * so an experimenter can test the raw FTS5 `bm25()` value
   * without going through the squashed variant. The override
   * is reported in the artifact; it is NOT applied silently.
   */
  direction?: "higher-is-better" | "lower-is-better";
}

/**
 * A per-query calibration diagnostic. Carries the score
 * distribution and the abstention decision for the active
 * gates, plus a before/after diff so a reviewer can see which
 * ids were kept or dropped.
 */
export interface CalibrationQueryDiagnostic {
  queryId: string;
  family: string;
  isPositive: boolean;
  topScore: number;
  secondScore: number;
  /** `topScore - secondScore`. 0 if fewer than 2 candidates. */
  scoreGap: number;
  /**
   * `topScore / secondScore`. `Infinity` if secondScore is 0
   * AND topScore > 0 (ranker is the only candidate). `1.0` if
   * topScore == secondScore == 0 (no signal). Defined as 1.0
   * in the "no signal" case so a reviewer can sort on it.
   */
  scoreRatio: number;
  /** Per-candidate ids, in the ranker's natural order, with
   *  no threshold filter. */
  originalTopIds: number[];
  /** Per-candidate scores, parallel to `originalTopIds`. */
  originalTopScores: number[];
  /** The abstention decision under the active gates. */
  abstained: boolean;
  /** Which gate(s) caused the abstention, if any. */
  abstainedByGate: string[];
  /**
   * True iff the abstention matched the gold label. For a
   * positive query the correct behavior is NOT to abstain;
   * for a no-answer query the correct behavior IS to
   * abstain. The flag is the most direct "did this gate
   * help" signal: an abstention on a positive query is a
   * regression, an abstention on a no-answer query is a
   * fix.
   */
  abstentionWasCorrect: boolean;
  /**
   * Top ids AFTER the abstention decision. Equal to
   * `originalTopIds` if the ranker did not abstain, or `[]`
   * if it did. Kept as a separate field so a reviewer can
   * diff before/after without recomputing the gate.
   */
  afterAbstainTopIds: number[];
  /**
   * The "natural" verdict: empty top-K without any
   * abstention gate applied. `true` iff the ranker returned
   * zero hits under its rank-time threshold. This is the
   * pre-calibration TNR signal: queries the ranker was
   * already abstaining on, before any of our gates.
   */
  naturallyAbstained: boolean;
  /**
   * Hybrid-aware contributor support diagnostic. Present
   * only on per-query traces from the `hybrid-dense` (or
   * future `hybrid`) calibration pass; `undefined` on the
   * single-variant traces (lexical / FTS5 / vector /
   * vector-dense). The block carries the per-source RRF
   * rank for the top-1 candidate, the raw per-source
   * score, and the RRF contribution, so a reviewer can see
   * WHY the fusion surfaced a candidate. The block is
   * ADDITIVE: existing fields and the per-query trace
   * contract are unchanged.
   */
  contributorSupport?: ReadonlyArray<{
    source: "lexical" | "fts5" | "vector-dense";
    rank: number | null;
    score: number | null;
    contribution: number;
  }>;
  /**
   * Hybrid-aware abstention-only diagnostic. Present only
   * on `hybrid-dense` traces; `undefined` on single-variant
   * traces. The number of contributors that returned the
   * top-1 candidate (i.e. RRF rank-1 was non-null in their
   * ranking). A value of 1 means only one source surfaced
   * the candidate; 3 means all three agreed. The value is a
   * leading indicator of confidence: a "1 of 3" agreement
   * is a stronger abstention signal than a "3 of 3"
   * agreement.
   */
  contributorAgreementCount?: number;
}

/**
 * Per-variant calibration result. One row per (variant, gate
 * kind, candidate value) + the "no extra gate" baseline.
 */
export interface CalibrationVariantResult {
  variant: "lexical" | "fts5" | "vector" | "vector-dense" | "hybrid-dense";
  /** Stable human label for the gate. */
  gateLabel: string;
  /**
   * The gate value. `null` for the "no extra gate" baseline
   * row (which uses the ranker's own empty-top-K as the
   * abstention decision).
   */
  gateValue: number | null;
  /**
   * The gate kind, or `null` for the baseline row. Used to
   * group rows in the human report.
   */
  gateKind: CalibrationGate["kind"] | null;
  /**
   * Number of positive queries that the gate forced to
   * abstain (regressions). Computed over the calibration
   * diagnostics.
   */
  positiveRegressions: number;
  /**
   * Number of no-answer queries that the gate fixed
   * (i.e. the ranker originally returned hits, and the gate
   * caused an abstention). These are the "no-answer FPs
   * fixed" numbers the brief asks for.
   */
  noAnswerFixed: number;
  /**
   * Number of no-answer queries that the gate incorrectly
   * allowed to pass (ranker returned hits, gate did not
   * trigger). The "remaining FPs" — i.e. the gate's residual
   * confabulation rate.
   */
  noAnswerRemainingFp: number;
  /**
   * Trade-off: the headline metrics under the gate. Mirrors
   * the single-variant `BenchmarkMetrics` shape so a reviewer
   * can read the calibration output the same way they read
   * the regular benchmark. The metrics are computed against
   * the "after abstain" top-K.
   */
  metrics: {
    hitAt5: number;
    rank1: number;
    currentTruthAt1: number;
    noAnswerCorrect: number;
    positiveTotal: number;
    noAnswerTotal: number;
    /** Multi-hop partial / complete. */
    multiHopAny: number;
    multiHopTotal: number;
    multiHopComplete: number;
    /** Orientation recall@5 and slot coverage. */
    orientationRecallAt5: number;
    orientationSlotCoverageAt5: number;
    orientationTotal: number;
  };
  /**
   * Per-query diagnostics, keyed by `queryId`. The full
   * trace is on disk so a reviewer can dig into any row.
   */
  diagnostics: CalibrationQueryDiagnostic[];
}

/**
 * Top-level calibration report. The on-disk artifact is one
 * of these. The shape is intentionally similar to a
 * `ComparisonBenchmarkReport` (per-variant sections + a small
 * summary table) so existing tooling can read it without a
 * new schema.
 */
export interface CalibrationReport {
  generatedAt: string;
  config: {
    recordCount: number;
    queryCount: number;
    direction: "higher-is-better" | "lower-is-better";
  };
  /**
   * Baseline rows: one per variant, no extra gate (i.e.
   * abstention == ranker returned empty). The baseline
   * matches the existing single-variant benchmark report's
   * no-answer TNR.
   */
  baseline: CalibrationVariantResult[];
  /**
   * Sweep rows: one per (variant, gate kind, candidate
   * value). Grouped by variant and gate kind in the report
   * so a reviewer can read the trade-off curve for each
   * gate family in turn.
   */
  sweep: CalibrationVariantResult[];
  /**
   * The "best" row per variant, picked by a simple scoring
   * rule: maximize the no-answer TNR delta over baseline,
   * tie-break on smallest positive regression count, then
   * on highest hit@5. The rule is documented in the report
   * so the choice is auditable.
   *
   * The `vectorDense` / `hybridDense` keys are populated
   * only on dense calibration reports; the sync calibration
   * report leaves them `null` and the existing three
   * calibratable variants (`lexical`, `fts5`, `vector`)
   * remain the canonical keys for the sync report. The new
   * keys are ADDITIVE — the existing three keys are
   * unchanged in shape and meaning, so existing tooling
   * that reads the sync report continues to work.
   */
  bestByVariant: {
    lexical: CalibrationVariantResult | null;
    fts5: CalibrationVariantResult | null;
    vector: CalibrationVariantResult | null;
    /** Dense real-vector variant. */
    vectorDense?: CalibrationVariantResult | null;
    /** Dense hybrid (RRF over lexical / FTS5 / vector-dense). */
    hybridDense?: CalibrationVariantResult | null;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default sweep grid. Three small grids, each chosen to span
 * the empirically-observed score distribution from the
 * earlier benchmark runs (lexical: top scores cluster around
 * 0.2..0.7; FTS5: 0.2..0.7 after squash; vector: 0.0..0.6 on
 * a 24-record corpus with the BoW embedder). The grids are
 * intentionally small (3..5 values each) so a calibration
 * report stays readable. A reviewer who wants a finer grid
 * can pass a custom `CalibrationConfig`.
 */
export const DEFAULT_CALIBRATION_SWEEP: CalibrationConfig["sweep"] = {
  threshold: [0.1, 0.2, 0.3, 0.4, 0.5],
  margin: [0.0, 0.05, 0.1, 0.2, 0.3],
  ratio: [1.0, 1.25, 1.5, 2.0, 3.0],
};

/**
 * Default sweep grid for the dense variants (`vector-dense`
 * and `hybrid-dense`). The values are tuned to the
 * empirically-observed score distribution of the dense
 * embedder on the 60-record fixture corpus:
 *
 *   - For `vector-dense`, cosine similarity on the
 *     MiniLM / stub embedder is concentrated in
 *     [0.0, 0.9]; the `0%` no-answer TNR at the
 *     default threshold of 0 motivates a wider
 *     threshold grid that spans the natural gap
 *     between confabulating and matching scores.
 *   - For `hybrid-dense`, the RRF score is bounded by
 *     `N / (k + 1)` for N contributing variants. With
 *     three contributors and `k = 60`, the maximum
 *     possible RRF is `0.0492`. The threshold grid is
 *     scaled down to that range so the sweep explores
 *     the full feasible space.
 *
 * The margin and ratio grids are the same as the sync
 * defaults: the relative confidence of the dense
 * embedder is on a similar scale to the hashed-BoW
 * control, so the gap/ratio semantics are unchanged.
 *
 * The grid is intentionally small (3..5 values per
 * gate family) so the dense calibration report stays
 * readable. A reviewer who wants a finer grid can
 * pass a custom `CalibrationConfig`.
 */
export const DEFAULT_DENSE_CALIBRATION_SWEEP: CalibrationConfig["sweep"] = {
  // Cosine similarity threshold; spans the natural
  // match / no-match gap on the dense embedder. The
  // grid deliberately starts below the empirical
  // confabulation floor (so the baseline row is
  // captured) and reaches into the strong-match
  // range (so a stricter gate is also visible).
  threshold: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  // Top-1 to top-2 absolute margin. The dense
  // embedder is sharper than the hashed-BoW control
  // for paraphrase / exact matches, so a smaller
  // margin (e.g. 0.05) is a useful "barely
  // confident" signal.
  margin: [0.0, 0.05, 0.1, 0.15, 0.2, 0.3],
  // Top-1 / top-2 ratio. Same scale as the sync
  // default; the dense embedder naturally produces
  // larger ratios for true matches (the top-1
  // dominates) and ratios near 1.0 for confabulating
  // candidates (the top-1 and top-2 are roughly
  // tied).
  ratio: [1.0, 1.25, 1.5, 2.0, 3.0],
};

/**
 * Default sweep grid for the dense RRF variant
 * (`hybrid-dense`). The RRF score scale is
 * significantly smaller than the cosine scale: with
 * three contributors, k = 60, the maximum possible
 * RRF is `3 / 61 ≈ 0.0492`. The threshold grid is
 * therefore expressed in the same units but
 * pre-scaled to that range so the sweep explores
 * the full feasible space:
 *   - `0.005` ≈ "at least one contributor ranked the
 *     candidate in the top-1 with strong weight".
 *   - `0.01`  ≈ "two contributors both in the top-K".
 *   - `0.02`  ≈ "two contributors both near the
 *     top, or one strong top-1 plus a mid-list
 *     hit".
 *   - `0.03`  ≈ "most contributors agreed on the
 *     top".
 *   - `0.04`  ≈ "near-saturation; all three
 *     contributors are near rank 1".
 *
 * The grid is intentionally tight at the low end
 * (where the abstention decision is most
 * informative) and sparse at the high end. A
 * reviewer who wants a different distribution can
 * pass a custom `CalibrationConfig`.
 */
export const DEFAULT_HYBRID_DENSE_CALIBRATION_SWEEP: CalibrationConfig["sweep"] = {
  // The empirically-observed RRF top-1 score range on
  // the 60-record fixture corpus is roughly
  // [0.016, 0.049] for both positive and no-answer
  // queries, with the natural match / confabulation
  // gap concentrated around 0.025..0.030. The grid
  // spans that gap densely so a reviewer can see the
  // steep trade-off at the natural separation point.
  // A threshold of 0.01 is a permissive "abstain only
  // on a single-contributor weak hit" gate; 0.04 is a
  // strict "abstain unless most contributors
  // agreed" gate.
  threshold: [0.01, 0.02, 0.025, 0.03, 0.04],
  // Top-1 to top-2 absolute margin. The RRF score
  // differences on this corpus are typically in the
  // [0, 0.005] range, so the grid is tight at the
  // low end.
  margin: [0.0, 0.002, 0.005, 0.01, 0.02],
  // Top-1 / top-2 ratio. Same scale as the sync
  // default; the dense hybrid fusion naturally
  // produces larger ratios for true matches.
  ratio: [1.0, 1.25, 1.5, 2.0, 3.0],
};

// ---------------------------------------------------------------------------
// Per-query diagnostic builder
// ---------------------------------------------------------------------------

/**
 * Compute the per-query score distribution from a "no
 * threshold" rank. The function is pure: it takes a list of
 * candidates (rank order + parallel scores) and returns the
 * shape used by the per-query diagnostic block.
 */
export function computeScoreDistribution(
  scored: ReadonlyArray<LexicalScoredCandidate>,
): {
  topScore: number;
  secondScore: number;
  scoreGap: number;
  scoreRatio: number;
} {
  const topScore = scored.length > 0 ? (scored[0]?.score ?? 0) : 0;
  const secondScore = scored.length > 1 ? (scored[1]?.score ?? 0) : 0;
  const scoreGap = topScore - secondScore;
  // Ratio: defined as 1.0 if both are 0 (no signal), as
  // +Infinity if secondScore is 0 and topScore > 0 (only
  // candidate), and as topScore / secondScore otherwise.
  let scoreRatio: number;
  if (topScore === 0 && secondScore === 0) scoreRatio = 1.0;
  else if (secondScore === 0) scoreRatio = Number.POSITIVE_INFINITY;
  else scoreRatio = topScore / secondScore;
  return { topScore, secondScore, scoreGap, scoreRatio };
}

/**
 * Evaluate a set of gates against a score distribution and
 * return the abstention decision + the gates that triggered.
 *
 * The function is direction-aware: under
 * `higher-is-better` (the default) the gate is "abstain if
 * metric < value". Under `lower-is-better` it is "abstain if
 * metric > value". The direction is reported in the artifact
 * and asserted in tests.
 */
export function evaluateGates(
  dist: {
    topScore: number;
    secondScore: number;
    scoreGap: number;
    scoreRatio: number;
  },
  gates: ReadonlyArray<CalibrationGate>,
  direction: "higher-is-better" | "lower-is-better",
): { abstained: boolean; triggered: string[] } {
  const triggered: string[] = [];
  for (const g of gates) {
    if (g.active === false) continue;
    const metric = metricForGate(g.kind, dist);
    const abstain = direction === "higher-is-better"
      ? metric < g.value
      : metric > g.value;
    if (abstain) triggered.push(gateLabel(g));
  }
  return { abstained: triggered.length > 0, triggered };
}

function metricForGate(
  kind: CalibrationGate["kind"],
  dist: {
    topScore: number;
    secondScore: number;
    scoreGap: number;
    scoreRatio: number;
  },
): number {
  switch (kind) {
    case "threshold":
    case "topScore":
      return dist.topScore;
    case "margin":
      return dist.scoreGap;
    case "ratio":
      return dist.scoreRatio;
  }
}

/** Stable human label for a gate. */
export function gateLabel(g: CalibrationGate): string {
  return g.label ?? `${g.kind}@${g.value}`;
}

// ---------------------------------------------------------------------------
// Per-query diagnostic builder
// ---------------------------------------------------------------------------

/**
 * Build a `CalibrationQueryDiagnostic` from a "no threshold"
 * rank and an abstention decision. The function is pure and
 * safe to call from tests.
 *
 * The optional `hybridSupport` block carries the per-source
 * RRF rank/score/contribution for the top-1 candidate and
 * the contributor-agreement count. It is present only on
 * the hybrid-dense (or future hybrid) calibration pass;
 * `undefined` on the single-variant traces. The block is
 * additive: existing fields and the per-query trace
 * contract are unchanged.
 */
export function buildQueryDiagnostic(
  queryId: string,
  family: string,
  isPositive: boolean,
  scored: ReadonlyArray<LexicalScoredCandidate>,
  gates: ReadonlyArray<CalibrationGate>,
  direction: "higher-is-better" | "lower-is-better",
  hybridSupport?: {
    contributors: ReadonlyArray<{
      source: "lexical" | "fts5" | "vector-dense";
      rank: number | null;
      score: number | null;
      contribution: number;
    }>;
    agreementCount: number;
  },
): CalibrationQueryDiagnostic {
  const dist = computeScoreDistribution(scored);
  const { abstained, triggered } = evaluateGates(dist, gates, direction);
  // The "correct" abstention decision: positive queries
  // should NOT abstain; no-answer queries SHOULD abstain.
  const abstentionWasCorrect = isPositive ? !abstained : abstained;
  const out: CalibrationQueryDiagnostic = {
    queryId,
    family,
    isPositive,
    topScore: dist.topScore,
    secondScore: dist.secondScore,
    scoreGap: dist.scoreGap,
    scoreRatio: dist.scoreRatio,
    originalTopIds: scored.map((s) => s.id),
    originalTopScores: scored.map((s) => s.score),
    abstained,
    abstainedByGate: triggered,
    abstentionWasCorrect,
    afterAbstainTopIds: abstained ? [] : scored.map((s) => s.id),
    naturallyAbstained: scored.length === 0,
  };
  if (hybridSupport !== undefined) {
    // The hybrid-aware diagnostic fields are ADDITIVE: the
    // per-query trace's existing fields are unchanged. We
    // attach the block as `readonly` to match the public
    // type's contract.
    (out as { contributorSupport?: ReadonlyArray<{ source: "lexical" | "fts5" | "vector-dense"; rank: number | null; score: number | null; contribution: number }> }).contributorSupport =
      hybridSupport.contributors;
    (out as { contributorAgreementCount?: number }).contributorAgreementCount =
      hybridSupport.agreementCount;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trade-off metrics
// ---------------------------------------------------------------------------

/**
 * Compute the trade-off metrics for a set of diagnostics.
 *
 * The function is intentionally narrow: it consumes the
 * per-query diagnostics and returns the headline
 * trade-off numbers. It does NOT call the ranker or read
 * from the corpus — those are the caller's responsibility.
 *
 * The numbers match the existing `BenchmarkMetrics` shape so
 * a reviewer can compare the calibration row against the
 * regular benchmark row by row.
 */
export function computeTradeoff(
  diagnostics: ReadonlyArray<CalibrationQueryDiagnostic>,
  evals: ReadonlyArray<QueryEval>,
): CalibrationVariantResult["metrics"] {
  // Build a lookup from queryId -> QueryEval so we can
  // re-derive the per-query hit / rank1 / currentTruthAt1
  // numbers against the AFTER-ABSTAIN top-K. The
  // diagnostics carry the original top-ids, so we use those
  // (and the after-abstain id list) to recompute the
  // trade-off metrics. We do not re-run the ranker.
  const evalsById = new Map<string, QueryEval>();
  for (const e of evals) evalsById.set(e.queryId, e);

  let hitAt5 = 0;
  let rank1 = 0;
  let currentTruthAt1 = 0;
  let positiveTotal = 0;
  let noAnswerCorrect = 0;
  let noAnswerTotal = 0;
  let multiHopAny = 0;
  let multiHopComplete = 0;
  let multiHopTotal = 0;
  let orientationRecallAt5 = 0;
  let orientationSlotCoverageHit = 0;
  let orientationSlotCoverageTotal = 0;
  let orientationTotal = 0;
  for (const d of diagnostics) {
    const e = evalsById.get(d.queryId);
    if (!e) continue;
    if (e.expectedIds.length === 0) {
      noAnswerTotal += 1;
      // "Correct" no-answer = after-abstain top-K empty.
      if (d.afterAbstainTopIds.length === 0) noAnswerCorrect += 1;
      continue;
    }
    positiveTotal += 1;
    const expected = new Set(e.expectedIds);
    const top0 = d.afterAbstainTopIds[0];
    if (top0 !== undefined && expected.has(top0)) rank1 += 1;
    if (top0 !== undefined && new Set(e.currentTruthIds).has(top0)) {
      currentTruthAt1 += 1;
    }
    const top5 = d.afterAbstainTopIds.slice(0, 5);
    if (top5.some((id) => expected.has(id))) hitAt5 += 1;
    if (e.family === "multi-hop") {
      multiHopTotal += 1;
      if (top5.some((id) => expected.has(id))) multiHopAny += 1;
      if (e.expectedIds.every((id) => top5.includes(id))) {
        multiHopComplete += 1;
      }
    }
    if (e.family === "orientation") {
      orientationTotal += 1;
      if (top5.some((id) => expected.has(id))) orientationRecallAt5 += 1;
      // Slot coverage: a query may declare multiple
      // expected ids. Sum the slots hit / expected.
      for (const id of e.expectedIds) {
        orientationSlotCoverageTotal += 1;
        if (top5.includes(id)) orientationSlotCoverageHit += 1;
      }
    }
  }
  return {
    hitAt5,
    rank1,
    currentTruthAt1,
    noAnswerCorrect,
    positiveTotal,
    noAnswerTotal,
    multiHopAny,
    multiHopTotal,
    multiHopComplete,
    orientationRecallAt5,
    orientationSlotCoverageAt5:
      orientationSlotCoverageTotal > 0
        ? orientationSlotCoverageHit / orientationSlotCoverageTotal
        : 0,
    orientationTotal,
  };
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * Compute the per-query regression counts from a diagnostic
 * set. Returns the three numbers the brief asks for:
 *   - positiveRegressions: positive queries forced to abstain
 *   - noAnswerFixed: no-answer queries fixed by abstention
 *   - noAnswerRemainingFp: no-answer queries that still pass
 */
export function computeRegressionCounts(
  diagnostics: ReadonlyArray<CalibrationQueryDiagnostic>,
): {
  positiveRegressions: number;
  noAnswerFixed: number;
  noAnswerRemainingFp: number;
} {
  let positiveRegressions = 0;
  let noAnswerFixed = 0;
  let noAnswerRemainingFp = 0;
  for (const d of diagnostics) {
    if (d.isPositive) {
      if (d.abstained) positiveRegressions += 1;
    } else {
      // No-answer family: the gold label is "should abstain".
      // The fix count is "the gate made the ranker abstain
      // when the natural ranker would have answered".
      if (d.abstained && !d.naturallyAbstained) noAnswerFixed += 1;
      if (!d.abstained) noAnswerRemainingFp += 1;
    }
  }
  return { positiveRegressions, noAnswerFixed, noAnswerRemainingFp };
}

// ---------------------------------------------------------------------------
// Sweep builder
// ---------------------------------------------------------------------------

/**
 * Build the full sweep rows for a single variant from a
 * "no threshold" per-query score trace and a sweep config.
 *
 * The function emits:
 *   - one "baseline" row (no extra gate),
 *   - one row per (gate kind, candidate value) in the sweep.
 *
 * The function does NOT know the ranker. The caller passes in
 * the per-query "no threshold" score trace (the `scored` list
 * for every query) and the original `QueryEval` list (for
 * the per-family metrics).
 *
 * The `variant` argument accepts the dense variants
 * (`vector-dense`, `hybrid-dense`) in addition to the three
 * sync variants. The function uses `variant` purely as a
 * label on the result rows; the gate math is the same for
 * all five variants (the public `LexicalScoredCandidate.score`
 * field is "higher is better" for every supported
 * variant — see the score-semantics block at the top of
 * this file).
 *
 * The optional `perQueryHybridSupport` argument carries the
 * hybrid-aware per-source RRF trace for the top-1 candidate
 * on `hybrid-dense` (and future hybrid) passes. It is
 * `undefined` for single-variant passes. The block is
 * ADDITIVE — it is attached to each per-query diagnostic
 * and does not change the existing per-query fields.
 */
export function buildSweepForVariant(
  variant: "lexical" | "fts5" | "vector" | "vector-dense" | "hybrid-dense",
  baselineMetrics: BenchmarkMetrics,
  evals: ReadonlyArray<QueryEval>,
  perQueryScores: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    scored: LexicalScoredCandidate[];
    /**
     * Hybrid-aware per-source RRF trace for the top-1
     * candidate. Present only on `hybrid-dense` (and future
     * hybrid) passes; `undefined` for single-variant
     * passes. The block is threaded through to the
     * per-query diagnostic via `buildQueryDiagnostic`.
     */
    hybridSupport?: {
      contributors: ReadonlyArray<{
        source: "lexical" | "fts5" | "vector-dense";
        rank: number | null;
        score: number | null;
        contribution: number;
      }>;
      agreementCount: number;
    };
  }>,
  sweep: CalibrationConfig["sweep"],
  direction: "higher-is-better" | "lower-is-better",
): {
  baseline: CalibrationVariantResult;
  sweep: CalibrationVariantResult[];
} {
  // Baseline: no extra gate. The abstention decision is the
  // ranker's natural empty-top-K. This is the same number as
  // the existing single-variant benchmark's no-answer TNR.
  const baselineDiagnostics = perQueryScores.map((q) => {
    const gates: CalibrationGate[] = []; // empty: no extra gate
    return buildQueryDiagnostic(
      q.queryId,
      q.family,
      q.isPositive,
      q.scored,
      gates,
      direction,
      q.hybridSupport,
    );
  });
  const baselineCounts = computeRegressionCounts(baselineDiagnostics);
  const baseline: CalibrationVariantResult = {
    variant,
    gateLabel: "no-extra-gate",
    gateValue: null,
    gateKind: null,
    positiveRegressions: baselineCounts.positiveRegressions,
    noAnswerFixed: baselineCounts.noAnswerFixed,
    noAnswerRemainingFp: baselineCounts.noAnswerRemainingFp,
    metrics: computeTradeoff(baselineDiagnostics, evals),
    diagnostics: baselineDiagnostics,
  };
  // Reference the existing single-variant metrics so a
  // reviewer can sanity-check the baseline row. We do NOT
  // overwrite `metrics` from the existing aggregate because
  // `computeTradeoff` and `aggregateMetrics` count the same
  // things (no-answer TNR, hit@5, etc.). The reference is
  // reported via a `noAnswerCorrect` equality assertion in
  // the test, not stored on the row.
  void baselineMetrics;
  const rows: CalibrationVariantResult[] = [];
  for (const [kind, values] of Object.entries(sweep)) {
    if (!values) continue;
    for (const v of values) {
      const g: CalibrationGate = {
        kind: kind as CalibrationGate["kind"],
        value: v,
      };
      const diags = perQueryScores.map((q) =>
        buildQueryDiagnostic(
          q.queryId,
          q.family,
          q.isPositive,
          q.scored,
          [g],
          direction,
          q.hybridSupport,
        ),
      );
      const counts = computeRegressionCounts(diags);
      rows.push({
        variant,
        gateLabel: gateLabel(g),
        gateValue: v,
        gateKind: g.kind,
        positiveRegressions: counts.positiveRegressions,
        noAnswerFixed: counts.noAnswerFixed,
        noAnswerRemainingFp: counts.noAnswerRemainingFp,
        metrics: computeTradeoff(diags, evals),
        diagnostics: diags,
      });
    }
  }
  return { baseline, sweep: rows };
}

// ---------------------------------------------------------------------------
// "Best" pick
// ---------------------------------------------------------------------------

/**
 * Pick the "best" sweep row per variant. The rule is:
 *   1. Maximize the no-answer TNR delta over the baseline
 *      (`(noAnswerCorrect - baseline.noAnswerCorrect) /
 *      baseline.noAnswerTotal`).
 *   2. Tie-break on smallest positive-regression count.
 *   3. Tie-break on largest hit@5.
 *   4. Final tie-break: smallest gate value (so the most
 *      permissive gate wins among equals).
 *
 * The rule is intentionally simple and documented in the
 * report. A future calibration could swap in a weighted
 * objective.
 */
export function pickBestRow(
  baseline: CalibrationVariantResult,
  rows: ReadonlyArray<CalibrationVariantResult>,
): CalibrationVariantResult | null {
  if (rows.length === 0) return null;
  const baseTnr = baseline.metrics.noAnswerTotal > 0
    ? baseline.metrics.noAnswerCorrect / baseline.metrics.noAnswerTotal
    : 0;
  let best: CalibrationVariantResult | null = null;
  let bestDelta = -Infinity;
  for (const r of rows) {
    const tnr = r.metrics.noAnswerTotal > 0
      ? r.metrics.noAnswerCorrect / r.metrics.noAnswerTotal
      : 0;
    const delta = tnr - baseTnr;
    if (delta > bestDelta + 1e-12) {
      best = r;
      bestDelta = delta;
      continue;
    }
    if (Math.abs(delta - bestDelta) <= 1e-12) {
      if (!best) {
        best = r;
        continue;
      }
      if (r.positiveRegressions < best.positiveRegressions) {
        best = r;
        continue;
      }
      if (
        r.positiveRegressions === best.positiveRegressions &&
        r.metrics.hitAt5 > best.metrics.hitAt5
      ) {
        best = r;
        continue;
      }
      if (
        r.positiveRegressions === best.positiveRegressions &&
        r.metrics.hitAt5 === best.metrics.hitAt5 &&
        (r.gateValue ?? 0) < (best.gateValue ?? 0)
      ) {
        best = r;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hybrid-aware abstention diagnostics
// ---------------------------------------------------------------------------

/**
 * Compute the per-source RRF rank/score/contribution for
 * the top-1 candidate of a hybrid-dense (or future hybrid)
 * trace, plus the contributor-agreement count. The function
 * is pure: it takes a list of per-source RRF contributions
 * for the top-1 candidate and returns the shape the
 * per-query diagnostic's `contributorSupport` /
 * `contributorAgreementCount` fields expect.
 *
 * The agreement count is the number of contributors that
 * returned the candidate in their own ranking (`rank !== null`).
 * A value of 1 means only one source surfaced the
 * candidate; 3 (the maximum for the dense hybrid) means
 * every contributor agreed. A "1 of 3" agreement is the
 * weakest abstention signal; a "3 of 3" agreement is the
 * strongest.
 *
 * The function is exposed for tests and for the dense
 * calibration runner; the public `CalibrationConfig` /
 * `CalibrationReport` shapes use the result through the
 * `hybridSupport` block.
 */
export function computeContributorSupport(
  contributors: ReadonlyArray<{
    source: "lexical" | "fts5" | "vector-dense";
    rank: number | null;
    score: number | null;
    contribution: number;
  }>,
): {
  contributors: ReadonlyArray<{
    source: "lexical" | "fts5" | "vector-dense";
    rank: number | null;
    score: number | null;
    contribution: number;
  }>;
  agreementCount: number;
} {
  let agreementCount = 0;
  for (const c of contributors) {
    if (c.rank !== null) agreementCount += 1;
  }
  return { contributors, agreementCount };
}
