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
 * existing JSON reports under `.cortex/benchmark/`.
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
   */
  gatesByVariant: {
    lexical?: CalibrationGate[];
    fts5?: CalibrationGate[];
    vector?: CalibrationGate[];
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
}

/**
 * Per-variant calibration result. One row per (variant, gate
 * kind, candidate value) + the "no extra gate" baseline.
 */
export interface CalibrationVariantResult {
  variant: "lexical" | "fts5" | "vector";
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
   */
  bestByVariant: {
    lexical: CalibrationVariantResult | null;
    fts5: CalibrationVariantResult | null;
    vector: CalibrationVariantResult | null;
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
 */
export function buildQueryDiagnostic(
  queryId: string,
  family: string,
  isPositive: boolean,
  scored: ReadonlyArray<LexicalScoredCandidate>,
  gates: ReadonlyArray<CalibrationGate>,
  direction: "higher-is-better" | "lower-is-better",
): CalibrationQueryDiagnostic {
  const dist = computeScoreDistribution(scored);
  const { abstained, triggered } = evaluateGates(dist, gates, direction);
  // The "correct" abstention decision: positive queries
  // should NOT abstain; no-answer queries SHOULD abstain.
  const abstentionWasCorrect = isPositive ? !abstained : abstained;
  return {
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
 */
export function buildSweepForVariant(
  variant: "lexical" | "fts5" | "vector",
  baselineMetrics: BenchmarkMetrics,
  evals: ReadonlyArray<QueryEval>,
  perQueryScores: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    scored: LexicalScoredCandidate[];
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
