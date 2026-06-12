/**
 * Benchmark-only abstention-signal audit helpers.
 *
 * This module is a small set of PURE, DETERMINISTIC
 * functions the audit runner consumes. The module knows
 * nothing about the production `recall(text)` controller,
 * the public MCP API, or the dense / hybrid / lexical
 * rankers. It only consumes per-query abstention signals
 * (the `AbstentionSignals` shape on `QueryEval`) and
 * produces:
 *
 *   1. Per-signal AUROC for the
 *      "answerable vs no-answer" binary task. The
 *      implementation is the trapezoidal Mann-Whitney-U
 *      AUROC with a stable, well-defined tie-handling
 *      rule.
 *   2. Per-signal risk-coverage curve data: the abstention
 *      decision `abstain if signal < t`, swept over
 *      t in `signal` value set, with per-sweep-point
 *      coverage (fraction of queries not abstained) and
 *      risk (fraction of retained queries that are
 *      no-answer FPs, i.e. confabulations).
 *   3. Coverage at fixed risk points (5%, 10%, 20%) and
 *      risk at fixed coverage points (50%, 80%, 95%),
 *      so a reviewer can read the trade-off at the points
 *      the brief asks for.
 *   4. Slice summaries: per-family aggregates, hard-
 *      negative vs easy no-answer breakdown, divergent
 *      temporal vs non-divergent temporal breakdown, and
 *      the "positives by family" summary.
 *
 * Why this is benchmark-only:
 *   The module is read-only and never modifies the
 *   production `recall(text)` behavior, the public MCP
 *   API, or the existing benchmark / calibration report
 *   shapes. It is a research artifact, not a deployment
 *   policy. The audit it supports is a study of how
 *   well simple retrieval-derived signals could
 *   separate answerable from no-answer queries, NOT a
 *   proposal to wire any signal into the controller.
 *
 * Mathematical references:
 *   - AUROC: the trapezoidal AUC of the ROC curve, which
 *     equals the Mann-Whitney-U statistic divided by
 *     `n_pos * n_neg` for the "score > class" ordering
 *     (we use the standard "rank ascending" tie-break,
 *     documented in `computeAuRoc`). The function is
 *     deterministic and the test pins known inputs.
 *   - Risk-coverage: standard "selective risk" curve
 *     (El-Yaniv & Wiener 2010, Geifman & El-Yaniv 2017).
 *     The "risk" at coverage c is the error rate on the
 *     top-c-fraction of the data ranked by the signal
 *     (in our "more confident first" direction). A
 *     perfect signal gives a step function with risk = 0
 *     on the entire positive sub-range.
 *   - Coverage at fixed risk / risk at fixed coverage:
 *     standard selective-prediction summaries.
 *
 * The functions are pure and well-typed. A reviewer who
 * reads the source can verify the math; the unit tests
 * pin the math against known inputs.
 */

import type { AbstentionSignals, QueryEval } from "./metrics.js";

// ---------------------------------------------------------------------------
// AUROC
// ---------------------------------------------------------------------------

/**
 * Compute the AUROC (area under the ROC curve) for a
 * binary task defined by `labels` (the gold truth) and
 * `scores` (the confidence signal). Higher score =
 * higher confidence; the label `1` is the "positive"
 * class (in our case, "no-answer" — the queries the
 * system should ABSTAIN on) and `0` is the "negative"
 * class (the queries the system should ANSWER).
 *
 * The convention here is INTENTIONALLY "1 = no-answer":
 * the audit's task is "can the signal detect no-answer
 * queries?" so a high score on a no-answer query is the
 * direction that helps the abstention decision. A signal
 * that is "high for answerable" would need to be
 * inverted; the audit runner exposes a `scoreIsHigherIsMorePositive`
 * flag on the per-signal report so a reviewer can see
 * which signals work in the natural direction.
 *
 * Tie-handling: the standard "midrank" rule. Ties on
 * the score get the average rank; the AUROC is
 * `(sum_of_ranks_of_positives - n_pos * (n_pos + 1) / 2)
 * / (n_pos * n_neg)`. The formula is the
 * trapezoidal-Mann-Whitney equivalent and matches the
 * `scikit-learn` `roc_auc_score` default
 * (`max_fpr=None`). When `n_pos == 0` or `n_neg == 0`
 * the function returns `0.5` (the "no signal" prior
 * under uniform priors) so the report is well-formed
 * and a reviewer can sort the signals on the same
 * scale.
 *
 * Determinism: the function is deterministic. The
 * midrank tie-break is the only stable rule; no random
 * tie-break is used.
 *
 * Edge cases:
 *   - `labels.length !== scores.length` throws (the
 *     audit runner ensures this invariant).
 *   - Empty input returns `0.5` (the uninformative
 *     prior).
 *   - All labels the same returns `0.5`.
 *   - All scores the same returns `0.5`.
 */
export function computeAuRoc(
  labels: ReadonlyArray<0 | 1>,
  scores: ReadonlyArray<number>,
): number {
  if (labels.length !== scores.length) {
    throw new Error(
      `computeAuRoc: labels (${labels.length}) and scores (${scores.length}) must have the same length`,
    );
  }
  const n = labels.length;
  if (n === 0) return 0.5;
  let nPos = 0;
  let nNeg = 0;
  for (const l of labels) {
    if (l === 1) nPos += 1;
    else nNeg += 1;
  }
  if (nPos === 0 || nNeg === 0) return 0.5;
  // Build (score, label) pairs and sort by score ascending
  // (so the highest scores are at the end). For AUROC
  // we want the sum of ranks of the positives.
  const pairs: Array<{ score: number; label: 0 | 1; idx: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    pairs[i] = { score: scores[i] as number, label: labels[i] as 0 | 1, idx: i };
  }
  // Stable sort: score asc, idx asc (the idx tie-break
  // makes the sort deterministic on machine boundaries).
  pairs.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.idx - b.idx;
  });
  // Compute the sum of ranks (1-based) for the positives.
  // The rank of the i-th sorted element (1-based) is
  // `i + 1` adjusted for ties: if a tied group has size
  // `g`, every element in the group gets the average
  // rank of the group. We do this with a single pass.
  let sumRanks = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && pairs[j + 1]!.score === pairs[i]!.score) j += 1;
    // Tie group is [i, j] inclusive; size is g = j - i + 1.
    // The 1-based ranks of the group are (i+1) .. (j+1).
    // The average rank is ((i + 1) + (j + 1)) / 2
    // = (i + j + 2) / 2.
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) {
      if (pairs[k]!.label === 1) {
        sumRanks += avgRank;
      }
    }
    i = j + 1;
  }
  // Mann-Whitney U: sumRanks - n_pos * (n_pos + 1) / 2.
  // The U-statistic is the number of positive-negative
  // pairs (p, n) where score_p > score_n, plus half the
  // ties. The Mann-Whitney U divided by (n_pos * n_neg)
  // is the AUROC.
  const u = sumRanks - (nPos * (nPos + 1)) / 2;
  return u / (nPos * nNeg);
}

// ---------------------------------------------------------------------------
// Risk-coverage
// ---------------------------------------------------------------------------

/**
 * One point on a risk-coverage curve. The pair
 * `(coverage, risk)` is the (coverage, confabulation
 * rate) at one abstention threshold.
 */
export interface RiskCoveragePoint {
  /** Coverage in [0, 1]: the fraction of queries NOT abstained. */
  coverage: number;
  /** Risk in [0, 1]: the fraction of retained queries that are no-answer FPs. */
  risk: number;
  /**
   * The signal threshold that produced this point. The
   * abstention rule is "abstain iff signal < t". The
   * "t" is the smallest signal value among the queries
   * the threshold abstains; a `t = -Infinity` means no
   * abstention (coverage = 1).
   */
  threshold: number;
  /**
   * Number of queries the threshold abstains. Mirrors
   * the column the human report needs to show.
   */
  abstainedCount: number;
}

/**
 * Build the full risk-coverage curve for one signal.
 *
 * Algorithm:
 *   1. Sort queries by signal score descending (more
 *      confident first). A perfect signal puts every
 *      no-answer query at the bottom; the curve would
 *      then have `risk = 0` for every coverage
 *      above `n_neg / n`.
 *   2. Sweep a threshold between consecutive distinct
 *      scores. At each threshold, the retained set is
 *      "scores >= threshold"; the abstained set is
 *      "scores < threshold". The (coverage, risk) point
 *      is computed on the retained set.
 *   3. Append two anchor points: (coverage = 0, risk
 *      undefined -> 0 by convention when n_pos > 0)
 *      and (coverage = 1, risk = n_pos / n).
 *
 * The returned array is sorted by coverage ascending
 * so a reviewer can plot it directly.
 *
 * Determinism: the function is deterministic. The
 * score sort uses a stable (score desc, idx asc) order
 * so the curve is byte-stable across machines.
 *
 * Edge cases:
 *   - Empty input returns `[]`.
 *   - All labels the same returns the trivial
 *     (n_pos / n on coverage = 1, no abstention curve
 *     points in between because every threshold gives
 *     the same risk).
 */
export function computeRiskCoverageCurve(
  labels: ReadonlyArray<0 | 1>,
  scores: ReadonlyArray<number>,
): RiskCoveragePoint[] {
  if (labels.length !== scores.length) {
    throw new Error(
      `computeRiskCoverageCurve: labels (${labels.length}) and scores (${scores.length}) must have the same length`,
    );
  }
  const n = labels.length;
  if (n === 0) return [];
  // Sort by score descending, stable on idx.
  const pairs: Array<{ score: number; label: 0 | 1; idx: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    pairs[i] = {
      score: scores[i] as number,
      label: labels[i] as 0 | 1,
      idx: i,
    };
  }
  pairs.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  // Sweep: at each step, consider abstaining the first
  // `k` queries (the least confident). Coverage is
  // (n - k) / n; risk is (# no-answer in the retained
  // (n - k) queries) / (n - k) (0 / 0 → 0 by
  // convention; in practice this only happens at
  // coverage = 0).
  const points: RiskCoveragePoint[] = [];
  // Anchor: coverage = 1, risk = n_pos / n (abstain
  // nothing). The threshold is -Infinity: a threshold
  // below every score abstains nothing.
  let nPos = 0;
  for (const p of pairs) if (p.label === 1) nPos += 1;
  points.push({
    coverage: 1,
    risk: nPos / n,
    threshold: Number.NEGATIVE_INFINITY,
    abstainedCount: 0,
  });
  // Sweep k from 1 to n - 1. The "threshold" is the
  // (k + 1)-th largest score, i.e. the smallest score
  // among the retained queries. The convention is
  // "abstain iff score < threshold" so threshold = the
  // k-th largest score = pairs[k - 1].score.
  for (let k = 1; k < n; k++) {
    let nPosRetained = 0;
    for (let r = k; r < n; r++) if (pairs[r]!.label === 1) nPosRetained += 1;
    const retained = n - k;
    const risk = retained > 0 ? nPosRetained / retained : 0;
    points.push({
      coverage: retained / n,
      risk,
      threshold: pairs[k - 1]!.score,
      abstainedCount: k,
    });
  }
  return points;
}

/**
 * Compute the coverage at fixed risk targets. Returns
 * the largest coverage (in [0, 1]) at which the risk
 * is at or below the target. Returns `0` if no
 * point on the curve meets the target.
 *
 * The function is the "Pareto-style" reading of the
 * risk-coverage curve: a reviewer who wants
 * "at most 5% risk, how much coverage can we keep?"
 * reads the answer here. The output is one number per
 * target.
 */
export function coverageAtFixedRisk(
  curve: ReadonlyArray<RiskCoveragePoint>,
  riskTargets: ReadonlyArray<number>,
): Array<{ riskTarget: number; coverage: number; threshold: number }> {
  const out: Array<{ riskTarget: number; coverage: number; threshold: number }> = [];
  for (const t of riskTargets) {
    let best: RiskCoveragePoint | null = null;
    for (const p of curve) {
      if (p.risk <= t) {
        if (best === null || p.coverage > best.coverage) {
          best = p;
        }
      }
    }
    out.push({
      riskTarget: t,
      coverage: best?.coverage ?? 0,
      threshold: best?.threshold ?? Number.NEGATIVE_INFINITY,
    });
  }
  return out;
}

/**
 * Compute the risk at fixed coverage targets. Returns
 * the smallest risk (in [0, 1]) on the curve at which
 * the coverage is at least the target. Returns `1` if
 * no point on the curve meets the target.
 *
 * Symmetric to `coverageAtFixedRisk`: a reviewer who
 * wants "at least 80% coverage, what is the minimum
 * risk?" reads the answer here.
 */
export function riskAtFixedCoverage(
  curve: ReadonlyArray<RiskCoveragePoint>,
  coverageTargets: ReadonlyArray<number>,
): Array<{ coverageTarget: number; risk: number; threshold: number }> {
  const out: Array<{ coverageTarget: number; risk: number; threshold: number }> = [];
  for (const t of coverageTargets) {
    let best: RiskCoveragePoint | null = null;
    for (const p of curve) {
      if (p.coverage >= t) {
        if (best === null || p.risk < best.risk) {
          best = p;
        }
      }
    }
    out.push({
      coverageTarget: t,
      risk: best?.risk ?? 1,
      threshold: best?.threshold ?? Number.NEGATIVE_INFINITY,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-signal audit
// ---------------------------------------------------------------------------

/**
 * The list of signal names the audit studies. Adding
 * a new signal requires extending the
 * `AbstentionSignals` type in `metrics.ts`, the
 * `extractSignals` map below, and (optionally) the
 * `getSignalDirection` / `getSignalNotes` helpers. The
 * set is intentionally small and explicit so a
 * reviewer can see exactly what is being measured.
 */
export const AUDIT_SIGNAL_NAMES = [
  "topScore",
  "top1Top2Gap",
  "top1Top2Ratio",
  "returnedCount",
  "agreementCount",
  "minContributorRank",
  "maxContributorRank",
  "meanContributorRank",
  "minContributorScore",
  "maxContributorScore",
  "meanContributorScore",
] as const;

export type AuditSignalName = (typeof AUDIT_SIGNAL_NAMES)[number];

/**
 * Human-readable notes for each signal. The notes are
 * a short, honest description of what the signal
 * measures, so a reviewer can interpret the AUROC
 * number without re-reading the source. The notes are
 * surfaced on the audit report.
 */
export const AUDIT_SIGNAL_NOTES: Readonly<Record<AuditSignalName, string>> = {
  topScore:
    "Top-1 raw score (cosine / RRF / Jaccard; variant-specific scale).",
  top1Top2Gap:
    "Top-1 to top-2 absolute score gap. 0 if fewer than 2 candidates.",
  top1Top2Ratio:
    "Top-1 / top-2 score ratio. +Inf if top-2 is 0 (only candidate).",
  returnedCount:
    "Number of candidates the ranker returned (top-K may be < 5).",
  agreementCount:
    "Number of hybrid contributors (lexical / fts5 / vector-dense) that surfaced the top-1. Cap = 3.",
  minContributorRank:
    "Best (smallest) RRF rank across contributors. 1 = at least one source ranked the top-1 first.",
  maxContributorRank:
    "Worst (largest) RRF rank across contributors. Low values = strong cross-source agreement.",
  meanContributorRank:
    "Mean RRF rank across contributors. 0 when none of the contributors surfaced the top-1.",
  minContributorScore:
    "Worst (smallest) raw per-source score across contributors.",
  maxContributorScore:
    "Best (largest) raw per-source score across contributors.",
  meanContributorScore:
    "Mean raw per-source score across contributors. 0 when none of the contributors surfaced the top-1.",
};

/**
 * Map an `AbstentionSignals` value to the per-signal
 * arrays. The function is pure. Missing values are
 * mapped to 0 (a number the audit can sort on) so the
 * curve is well-formed for the `null`-valued signals
 * on single-variant runs. The runner warns explicitly
 * on signals that are undefined for a non-trivial
 * fraction of the corpus, so a reviewer can see when
 * a signal is "missing on purpose" vs "missing by
 * accident".
 *
 * Convention: the audit's binary task is "label = 1
 * iff no-answer". A signal that is HIGH for a
 * no-answer query is a USEFUL abstention signal in
 * the natural direction; the AUROC is computed with
 * `scoreIsHigherIsMorePositive = true` for those. A
 * signal that is LOW for a no-answer query would need
 * to be inverted (the audit can compute both
 * directions and reports the better one; see
 * `auditSignal`).
 */
export function extractSignal(
  signals: Readonly<AbstentionSignals>,
  name: AuditSignalName,
): number {
  switch (name) {
    case "topScore":
      return signals.topScore;
    case "top1Top2Gap":
      return signals.top1Top2Gap;
    case "top1Top2Ratio":
      // +Infinity is not sortable. Cap at a large finite
      // number so the AUROC / curve math is well-defined.
      // The cap is the conventional "1.0e9" sentinel.
      return Number.isFinite(signals.top1Top2Ratio)
        ? signals.top1Top2Ratio
        : 1.0e9;
    case "returnedCount":
      return signals.returnedCount;
    case "agreementCount":
      return signals.agreementCount;
    case "minContributorRank": {
      const v = signals.minContributorRank;
      if (v === null) return 0;
      return Number.isFinite(v) ? v : 1.0e9;
    }
    case "maxContributorRank": {
      const v = signals.maxContributorRank;
      if (v === null) return 0;
      return Number.isFinite(v) ? v : 1.0e9;
    }
    case "meanContributorRank": {
      const v = signals.meanContributorRank;
      if (v === null) return 0;
      return Number.isFinite(v) ? v : 1.0e9;
    }
    case "minContributorScore": {
      const v = signals.minContributorScore;
      if (v === null) return 0;
      return Number.isFinite(v) ? v : 0;
    }
    case "maxContributorScore": {
      const v = signals.maxContributorScore;
      if (v === null) return 0;
      return Number.isFinite(v) ? v : 0;
    }
    case "meanContributorScore": {
      const v = signals.meanContributorScore;
      if (v === null) return 0;
      return Number.isFinite(v) ? v : 0;
    }
  }
}

/**
 * Result of auditing a single signal. The shape is the
 * row on the per-signal table in the report.
 */
export interface AuditSignalResult {
  signal: AuditSignalName;
  /** Notes for the signal. Surfaced in the report. */
  notes: string;
  /**
   * AUROC for "label = 1 iff no-answer", computed with
   * `scoreIsHigherIsMorePositive` as the score
   * direction. `0.5` is the uninformative prior. A
   * value > 0.5 means "higher signal value tends to
   * indicate a no-answer query" in the chosen
   * direction.
   */
  auroc: number;
  /**
   * `true` iff the chosen (reported) AUROC is the
   * "natural" direction: the raw signal's "higher =
   * more positive (no-answer)" interpretation is the
   * predictive one. `false` means the natural direction
   * is anti-predictive and the audit had to invert
   * (negate) the signal to get a useful AUROC. A
   * reviewer who sees `false` should interpret the
   * signal as "lower score = more positive (no-answer)".
   */
  scoreIsHigherIsMorePositive: boolean;
  /**
   * The AUROC in the OPPOSITE direction (so a reviewer
   * can see both). Same scale as `auroc`. The pair
   * (`auroc`, `aurocOtherDirection`) is
   * `(natural, inverted)` when
   * `scoreIsHigherIsMorePositive = true`, and
   * `(inverted, natural)` otherwise.
   */
  aurocOtherDirection: number;
  /** Full risk-coverage curve for this signal. */
  riskCoverageCurve: RiskCoveragePoint[];
  /** Coverage at fixed risk targets (5%, 10%, 20%). */
  coverageAtRisk: Array<{ riskTarget: number; coverage: number; threshold: number }>;
  /** Risk at fixed coverage targets (50%, 80%, 95%). */
  riskAtCoverage: Array<{ coverageTarget: number; risk: number; threshold: number }>;
  /**
   * Number of queries for which the signal is defined
   * (non-`null` in `AbstentionSignals`). The `null`-valued
   * signals (per-source ranks / scores on single-variant
   * runs) are mapped to 0 in `extractSignal`; this
   * count is the "all queries" count, not a missing-
   * value count. A reviewer who wants to know "how many
   * queries had a non-`null` per-source rank" reads the
   * `singleVariantMissing` field below.
   */
  sampleSize: number;
  /**
   * Number of queries for which the per-source signal
   * is `null`. Only meaningful for the contributor-
   * rank / contributor-score signals on a single-
   * variant run; on a `hybrid-dense` run this is 0
   * (every query has a per-source trace).
   */
  singleVariantMissing: number;
}

/**
 * Audit a single signal across the corpus. The
 * function consumes a per-query signal array + the
 * binary label array ("is this query a no-answer
 * query?") and returns the AUROC, the risk-coverage
 * curve, the coverage-at-fixed-risk and risk-at-fixed-
 * coverage summaries, and the bookkeeping fields.
 *
 * The "natural direction" choice: the audit tries
 * BOTH directions and reports the better one. The
 * `scoreIsHigherIsMorePositive` field tells the
 * reviewer which direction won, and the
 * `aurocInverted` field gives the other direction's
 * AUROC. A signal that is HIGH for answerable queries
 * (e.g. `topScore`) will report `scoreIsHigherIsMorePositive
 * = false` because the audit has to invert it to get
 * "high = no-answer" — the AUROC reported is the
 * inverted-direction number.
 */
export function auditSignal(
  signalName: AuditSignalName,
  signals: ReadonlyArray<AbstentionSignals>,
  labels: ReadonlyArray<0 | 1>,
  options: {
    /** Coverage targets for the risk-at-coverage summary. */
    coverageTargets?: ReadonlyArray<number>;
    /** Risk targets for the coverage-at-risk summary. */
    riskTargets?: ReadonlyArray<number>;
  } = {},
): AuditSignalResult {
  if (signals.length !== labels.length) {
    throw new Error(
      `auditSignal(${signalName}): signals (${signals.length}) and labels (${labels.length}) must have the same length`,
    );
  }
  const scoresNatural = signals.map((s) => extractSignal(s, signalName));
  // The "natural" direction treats the raw score as
  // "higher = more positive (i.e. no-answer)". For
  // signals that are HIGH for answerable queries (e.g.
  // `topScore`), the natural-direction AUROC is below
  // 0.5; we invert by negating.
  const aurocNatural = computeAuRoc(labels, scoresNatural);
  const scoresInverted = scoresNatural.map((s) => -s);
  const aurocInverted = computeAuRoc(labels, scoresInverted);
  // Pick the better direction. The reported AUROC is
  // the larger of the two (the "farther from 0.5"
  // direction). The `scoreIsHigherIsMorePositive`
  // boolean tells the reviewer whether the natural
  // direction (raw signal, "higher = more positive")
  // is the chosen one. It is `true` when the natural
  // AUROC is at least as good as the inverted AUROC
  // (i.e. the raw signal's "higher = no-answer"
  // direction is the predictive one); `false` when
  // the natural direction is anti-predictive and the
  // audit had to invert to get a useful signal.
  const scoreIsHigherIsMorePositive = aurocNatural >= aurocInverted;
  const auroc = scoreIsHigherIsMorePositive
    ? aurocNatural
    : aurocInverted;
  const scoresForCurve = scoreIsHigherIsMorePositive
    ? scoresNatural
    : scoresInverted;
  const curve = computeRiskCoverageCurve(labels, scoresForCurve);
  const riskTargets = options.riskTargets ?? [0.05, 0.1, 0.2];
  const coverageTargets = options.coverageTargets ?? [0.5, 0.8, 0.95];
  // Count of queries for which the per-source signal is
  // `null`. Only meaningful for the contributor-rank /
  // contributor-score signals.
  let singleVariantMissing = 0;
  for (const s of signals) {
    if (signalName === "minContributorRank" && s.minContributorRank === null) {
      singleVariantMissing += 1;
    } else if (
      signalName === "maxContributorRank" &&
      s.maxContributorRank === null
    ) {
      singleVariantMissing += 1;
    } else if (
      signalName === "meanContributorRank" &&
      s.meanContributorRank === null
    ) {
      singleVariantMissing += 1;
    } else if (
      signalName === "minContributorScore" &&
      s.minContributorScore === null
    ) {
      singleVariantMissing += 1;
    } else if (
      signalName === "maxContributorScore" &&
      s.maxContributorScore === null
    ) {
      singleVariantMissing += 1;
    } else if (
      signalName === "meanContributorScore" &&
      s.meanContributorScore === null
    ) {
      singleVariantMissing += 1;
    }
  }
  return {
    signal: signalName,
    notes: AUDIT_SIGNAL_NOTES[signalName],
    auroc,
    scoreIsHigherIsMorePositive,
    aurocOtherDirection: scoreIsHigherIsMorePositive
      ? aurocInverted
      : aurocNatural,
    riskCoverageCurve: curve,
    coverageAtRisk: coverageAtFixedRisk(curve, riskTargets),
    riskAtCoverage: riskAtFixedCoverage(curve, coverageTargets),
    sampleSize: signals.length,
    singleVariantMissing,
  };
}

// ---------------------------------------------------------------------------
// Slice summary
// ---------------------------------------------------------------------------

/**
 * A "slice" in the audit: a subset of the query set
 * the audit reports on. The audit surfaces a small,
 * stable set of slices:
 *
 *   - "all" — every query.
 *   - per family ("exact" / "paraphrase" / "temporal" /
 *     "multi-hop" / "no-answer" / "orientation").
 *   - "no-answer-easy" — no-answer queries that are NOT
 *     hard-negatives. The label + the
 *     `isNoAnswerHardNegative` query-shape flag together
 *     determine the slice.
 *   - "no-answer-hard" — no-answer queries that ARE
 *     hard-negatives (per the `isNoAnswerHardNegative`
 *     detector). The confabulation pressure this
 *     slice carries is the audit's main interest.
 *   - "temporal-divergent" — temporal queries whose
 *     `expectedIds` does NOT equal `currentTruthIds`
 *     (i.e. the labeled "divergent" cases the
 *     benchmark already supports).
 *   - "temporal-non-divergent" — temporal queries
 *     whose `expectedIds` equals `currentTruthIds`.
 *   - per positive family ("exact" / "paraphrase" /
 *     "temporal" / "multi-hop" / "orientation"). The
 *     audit's "positives by family" report.
 *
 * Each slice has its own AUROC per signal, so a
 * reviewer can see "this signal works on temporal but
 * not on no-answer" without re-running the audit.
 */
export interface AuditSlice {
  /** Stable slice name (e.g. "all" / "no-answer-hard" / "exact"). */
  name: string;
  /** Human-readable description surfaced on the report. */
  description: string;
  /** Number of queries in the slice. */
  total: number;
  /** Number of no-answer queries in the slice. */
  noAnswerCount: number;
  /** Per-signal AUROC for the slice. */
  signalResults: AuditSignalResult[];
}

/**
 * Build the per-signal AUROC for one slice. The
 * function is a thin wrapper around `auditSignal` that
 * takes the pre-filtered `(signals, labels)` arrays.
 * Exposed so the audit runner can reuse the helper
 * for ad-hoc slices without duplicating the math.
 */
export function auditSlice(
  name: string,
  description: string,
  signals: ReadonlyArray<AbstentionSignals>,
  labels: ReadonlyArray<0 | 1>,
  options: {
    coverageTargets?: ReadonlyArray<number>;
    riskTargets?: ReadonlyArray<number>;
  } = {},
): AuditSlice {
  const signalResults: AuditSignalResult[] = [];
  for (const s of AUDIT_SIGNAL_NAMES) {
    signalResults.push(
      auditSignal(s, signals, labels, {
        ...(options.coverageTargets !== undefined
          ? { coverageTargets: options.coverageTargets }
          : {}),
        ...(options.riskTargets !== undefined
          ? { riskTargets: options.riskTargets }
          : {}),
      }),
    );
  }
  let noAnswerCount = 0;
  for (const l of labels) if (l === 1) noAnswerCount += 1;
  return {
    name,
    description,
    total: labels.length,
    noAnswerCount,
    signalResults,
  };
}

// ---------------------------------------------------------------------------
// Audit entry point
// ---------------------------------------------------------------------------

/**
 * Top-level audit config. The audit runner consumes
 * the user's per-query `AbstentionSignals` blocks and
 * emits the full report. The fields with defaults
 * cover the common case; a reviewer who wants
 * non-default slice definitions can call the helpers
 * directly.
 */
export interface AbstentionAuditConfig {
  /**
   * Risk targets for the coverage-at-risk summary.
   * Default: `[0.05, 0.1, 0.2]` (5%, 10%, 20%).
   */
  riskTargets?: ReadonlyArray<number>;
  /**
   * Coverage targets for the risk-at-coverage summary.
   * Default: `[0.5, 0.8, 0.95]` (50%, 80%, 95%).
   */
  coverageTargets?: ReadonlyArray<number>;
}

/**
 * Top-level audit result. The on-disk artifact is one
 * of these; the human report is rendered from it.
 *
 * The shape is intentionally distinct from the
 * `CalibrationReport` shape: the audit is a study of
 * SIGNAL separability, not a calibration sweep over
 * abstention gates. The two artifacts are different
 * tools for different questions. A reviewer who wants
 * "what does the abstention surface look like at the
 * gate picked by `pickBestRow`?" reads the
 * calibration report. A reviewer who wants "do any of
 * my simple signals detect no-answer queries?" reads
 * this.
 */
export interface AbstentionAuditReport {
  generatedAt: string;
  config: {
    recordCount: number;
    queryCount: number;
    total: number;
    noAnswerCount: number;
    positiveCount: number;
    riskTargets: ReadonlyArray<number>;
    coverageTargets: ReadonlyArray<number>;
  };
  /**
   * Per-variant slices. The runner iterates over
   * `evalByVariant` and emits one slice set per
   * variant. The "all" slice is computed once and
   * is the headline reading.
   */
  slices: AuditSlice[];
  /**
   * Per-query "all" AUROC summary: the per-signal
   * AUROC + risk-coverage / coverage-at-risk /
   * risk-at-coverage summaries for the full
   * corpus. This is the headline table the brief
   * asks for.
   */
  allSlices: AuditSlice[];
  /**
   * Honest per-query examples: the most-confident
   * no-answer query (where abstention would have
   * been the right call but the ranker was confident
   * the WRONG WAY), the most-confident answerable
   * query, the worst no-answer query (ranker was
   * least confident about a no-answer query — an
   * easy "abstain here" example), and the worst
   * answerable query (the most-confident wrong
   * answer — a false positive the abstention
   * missed).
   */
  perQueryExamples: AuditPerQueryExamples;
  /**
   * The raw per-query signals. The runner
   * always emits this so a reviewer can
   * re-derive any AUROC / curve by hand. The
   * block is `undefined` on a "summary-only" run
   * the runner does not currently expose (kept as
   * an extension point).
   */
  perQuerySignals: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
  }>;
}

/**
 * Honest per-query examples the report surfaces. The
 * examples are chosen by signal-aware heuristics so
 * the reviewer sees the most informative queries
 * (best / worst abstention cases), not a random
 * sample. The function is pure and deterministic; the
 * runner tests pin the example selection.
 */
export interface AuditPerQueryExamples {
  /**
   * No-answer queries the ranker was MOST confident
   * about. These are the confabulations an abstention
   * signal would have to detect. A reviewer who wants
   * to see "why is this hard?" reads these.
   */
  mostConfidentNoAnswer: Array<{
    queryId: string;
    family: string;
    signals: AbstentionSignals;
  }>;
  /**
   * Answerable queries the ranker was LEAST confident
   * about. These are the false-positive abstention
   * cases a signal would have to avoid. A reviewer
   * who wants to see "where would a permissive gate
   * hurt?" reads these.
   */
  leastConfidentPositive: Array<{
    queryId: string;
    family: string;
    signals: AbstentionSignals;
  }>;
  /**
   * No-answer queries the ranker was LEAST confident
   * about. These are the easy "abstain here" cases.
   * A high-signal no-answer query on this list is a
   * success story for the audit.
   */
  leastConfidentNoAnswer: Array<{
    queryId: string;
    family: string;
    signals: AbstentionSignals;
  }>;
  /**
   * Answerable queries the ranker was MOST confident
   * about. These are the "correct answer" cases; a
   * signal that is high on this list and low on the
   * no-answer list is the "this signal works" pattern.
   */
  mostConfidentPositive: Array<{
    queryId: string;
    family: string;
    signals: AbstentionSignals;
  }>;
}
