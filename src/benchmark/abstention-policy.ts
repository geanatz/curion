/**
 * Benchmark-only multi-signal abstention policy evaluator.
 *
 * This module is a small set of PURE, DETERMINISTIC
 * functions that take the per-query abstention signal
 * block the existing audit runner produces, and a small
 * list of policy descriptors, and emit:
 *
 *   1. A binary "abstain / retain" decision for every
 *      query under every policy.
 *   2. Per-policy metrics on the audit's "all" slice:
 *        - no-answer abstention rate (TNR equivalent)
 *        - positive abstention count and rate
 *        - hit@5 retained / lost vs the un-gated baseline
 *        - rank1 retained / lost vs the baseline
 *        - currentTruthAt1 retained / lost vs the baseline
 *        - precision / recall equivalents on the
 *          audit's "all" slice (positive = no-answer
 *          abstain as a TP, retain a no-answer as a
 *          confabulation FP, etc.)
 *   3. Per-family positive abstention breakdown so a
 *      reviewer can see "the score gate is more
 *      aggressive on paraphrase than on exact".
 *   4. The per-query FP / FN lists (false-positives =
 *      positive queries wrongly abstained; false-
 *      negatives = no-answer queries wrongly
 *      retained).
 *
 * The policies are intentionally simple. They are
 * rule-based, NOT learned. The score gates and the
 * query-shape flag combinations are exactly the four
 * the architect advisory calls out (flag-only,
 * low-damage, recommended, aggressive) plus the
 * ablation grid the brief asks for.
 *
 * Determinism: every function is pure. The same policy
 * descriptor + the same per-query signals -> the same
 * decisions. The order of policy iteration is fixed
 * (declaration order in `BUILTIN_POLICIES`) so the
 * on-disk artifact is byte-stable for a given input.
 *
 * Scope (benchmark-only):
 *   This module is read-only and never modifies the
 *   production `recall(text)` behavior, the public MCP
 *   API, or the existing audit / calibration report
 *   shapes. It consumes the per-query `AbstentionSignals`
 *   block the audit runner already produces and emits
 *   a SEPARATE artifact. The auditor is wired into the
 *   benchmark runner; the auditor is NOT wired into
 *   the production controller. The brief is explicit
 *   about this: research-only, fixture-dependent.
 *
 * Honest per-family damage:
 *   The recommended policy is recommended because it
 *   catches most no-answer queries at a low hit@5
 *   cost, BUT the recommended policy's gains rely
 *   partly on the `isFalsePremiseLike` query-shape
 *   flag, which is fixture-correlated (it fires on
 *   queries that mention a missing tool — the corpus
 *   is fixed, so the flag is fixed). A reviewer who
 *   generalises the policy beyond the current fixture
 *   corpus should re-evaluate the per-family damage
 *   on a new corpus; the policy evaluator here does
 *   not promise generalization.
 */

import type { AbstentionSignals, QueryEval } from "./metrics.js";

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

/**
 * A binary "abstain if any of these conditions are
 * true" policy. The conditions are evaluated as a
 * disjunction; the policy abstains on a query iff at
 * least one of the conditions fires.
 *
 * Conventions:
 *   - `scoreThreshold` is a non-negative number; the
 *     policy abstains on a query when
 *     `meanContributorScore < scoreThreshold`. The
 *     "less-than" convention is consistent with the
 *     audit's "abstain if low-confidence" reading of
 *     the contributor-score signal (the audit's
 *     `lower=positive` direction). When
 *     `meanContributorScore` is `null` (the single-
 *     variant case), the policy treats the score as
 *     `0` and abstains on every query that lacks a
 *     higher-priority flag.
 *   - `agreementCountMax` is a non-negative integer;
 *     the policy abstains on a query when
 *     `agreementCount <= agreementCountMax`. The
 *     "less-than-or-equal" convention means
 *     `agreementCountMax = 0` abstains on every
 *     query with no contributor agreement, and
 *     `agreementCountMax = 2` abstains on queries
 *     with two or fewer contributors.
 *   - The query-shape flags are explicit booleans.
 *     The policy abstains on a query when
 *     `signals.<flag> === true`.
 *
 * The policy descriptor is plain data. A reviewer who
 * wants to add a custom policy can construct one in
 * a Node script; the CLI does not need to know about
 * it.
 */
export interface AbstentionPolicy {
  /** Stable id used in the artifact + human report. */
  id: string;
  /** Short human-readable description. */
  description: string;
  /** "primary" policies the architect advisory calls out
   *  as the four primary policy variants. */
  category: "primary" | "ablation";
  /**
   * Score gate. `null` = no score gate. When set, the
   * policy abstains on a query when
   * `meanContributorScore < scoreThreshold`.
   */
  scoreThreshold: number | null;
  /**
   * Agreement-count gate. `null` = no agreement gate.
   * When set, the policy abstains on a query when
   * `agreementCount <= agreementCountMax`.
   */
  agreementCountMax: number | null;
  /** `true` iff the policy abstains on hard-negatives. */
  useHardNegativeFlag: boolean;
  /** `true` iff the policy abstains on false-premise-like
   *  queries. */
  useFalsePremiseFlag: boolean;
}

/**
 * The per-query decision under a policy. The function
 * `evaluatePolicy` returns one of these per query. The
 * decision is binary: the policy either abstains on
 * the query (and the system emits nothing / a refusal)
 * or retains it (and the ranker's top-K is surfaced).
 */
export interface PolicyDecision {
  queryId: string;
  family: string;
  isPositive: boolean;
  /** `true` iff the policy abstained. */
  abstain: boolean;
  /**
   * Short human-readable string: which gate fired.
   * "none" means the policy retained the query.
   * Multiple reasons may be combined with `+` (e.g.
   * `"score+hardNeg"`). The reason is on the
   * artifact so a reviewer can audit which gate
   * drove each abstention.
   */
  reason: string;
  /** Pass-through of the per-query retrieval outcome so
   *  the report can compute hit@5 / rank1 / currentTruthAt1
   *  retained / lost deltas without re-deriving them. */
  rank1: boolean;
  currentTruthAt1: boolean;
  hitAt5: boolean;
  /**
   * Optional, additive: the query's explicit adversarial
   * labels (the fixture truth, NOT derived from the
   * detector). A reviewer who wants to audit which
   * labels a per-query decision is associated with
   * reads this field. The field is `undefined` for
   * queries that have no explicit labels (the
   * backward-compatible default). The
   * adversarial-expansion checkpoint sets this on
   * queries with `labels` defined in the corpus.
   */
  queryLabels?: string[];
}

/**
 * The metric block for one policy on the audit's "all"
 * slice. The metrics are computed by
 * `computePolicyMetrics` from the per-query
 * `PolicyDecision` array.
 */
export interface PolicyMetrics {
  policyId: string;
  /** Total queries the policy saw. */
  total: number;
  /** No-answer queries the policy saw. */
  noAnswerCount: number;
  /** Positive queries the policy saw. */
  positiveCount: number;
  /** Number / rate of no-answer queries the policy
   *  abstained on. TNR equivalent. */
  noAnswerAbstained: number;
  noAnswerAbstainedRate: number;
  /** Number / rate of positive queries the policy
   *  abstained on. A higher number = more damage
   *  on answerable queries. */
  positiveAbstained: number;
  positiveAbstainedRate: number;
  /** Per-family positive abstention breakdown. */
  positiveAbstainedByFamily: Record<
    string,
    { total: number; abstained: number; rate: number }
  >;
  /** hit@5 retention on positive queries
   *  (the audit's "all" slice positive set). */
  hitAt5Retained: number;
  hitAt5Lost: number;
  hitAt5RetainedRate: number;
  /** rank1 retention on positive queries. */
  rank1Retained: number;
  rank1Lost: number;
  rank1RetainedRate: number;
  /** currentTruthAt1 retention on positive queries. */
  currentTruthAt1Retained: number;
  currentTruthAt1Lost: number;
  currentTruthAt1RetainedRate: number;
  /** Baseline numbers (re-computed from the same
   *  per-query set so the delta is meaningful). */
  baseline: {
    hitAt5: number;
    rank1: number;
    currentTruthAt1: number;
  };
  /** Per-query lists (FP = positive query wrongly
   *  abstained; FN = no-answer query wrongly
   *  retained). Surfaced on the report so a
   *  reviewer can see the per-query damage. */
  falsePositives: ReadonlyArray<{ queryId: string; family: string; reason: string }>;
  falseNegatives: ReadonlyArray<{ queryId: string; family: string; reason: string }>;
  /** Precision / recall / F1 on the binary
   *  "should-abstain" task with `isNoAnswer` as the
   *  positive class. These are the headline
   *  classification numbers; a `0 / 0` rate is
   *  reported as 0 by convention. */
  precision: number;
  recall: number;
  f1: number;
  /** Number of queries that triggered each gate. */
  gateCounts: {
    score: number;
    agreement: number;
    hardNeg: number;
    falsePrem: number;
  };
}

// ---------------------------------------------------------------------------
// Built-in policies
// ---------------------------------------------------------------------------

/**
 * The four primary policies the architect advisory
 * calls out, plus the ablation grid the brief asks
 * for. The order is declaration order; the report
 * iterates in this order, so the on-disk artifact is
 * byte-stable for a given input.
 */
export const BUILTIN_POLICIES: ReadonlyArray<AbstentionPolicy> = [
  // ---- Primary policies ----
  {
    id: "flag-only-zero-hit-cost",
    description:
      "Flag-only zero-hit-cost baseline. Abstain iff isNoAnswerHardNegative OR isFalsePremiseLike. No score gate.",
    category: "primary",
    scoreThreshold: null,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: true,
  },
  {
    id: "low-damage-score-0.30",
    description:
      "Low-damage score+shape policy. meanContributorScore<0.30 OR isNoAnswerHardNegative OR isFalsePremiseLike.",
    category: "primary",
    scoreThreshold: 0.3,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: true,
  },
  {
    id: "moderate-score-0.40",
    description:
      "Recommended moderate policy. meanContributorScore<0.40 OR isNoAnswerHardNegative OR isFalsePremiseLike. (Gains rely partly on fixture-correlated isFalsePremiseLike; research-only.)",
    category: "primary",
    scoreThreshold: 0.4,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: true,
  },
  {
    id: "aggressive-score-0.50-no-fp",
    description:
      "Aggressive full-catch policy. meanContributorScore<0.50 OR isNoAnswerHardNegative. Drops the false-premise flag to expose the per-family damage from the score gate alone.",
    category: "primary",
    scoreThreshold: 0.5,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: false,
  },
  // ---- Ablations ----
  {
    id: "ablation-score-0.30-only",
    description: "Score gate only at 0.30 (no flag).",
    category: "ablation",
    scoreThreshold: 0.3,
    agreementCountMax: null,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-score-0.35-only",
    description: "Score gate only at 0.35.",
    category: "ablation",
    scoreThreshold: 0.35,
    agreementCountMax: null,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-score-0.40-only",
    description: "Score gate only at 0.40.",
    category: "ablation",
    scoreThreshold: 0.4,
    agreementCountMax: null,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-score-0.45-only",
    description: "Score gate only at 0.45.",
    category: "ablation",
    scoreThreshold: 0.45,
    agreementCountMax: null,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-score-0.50-only",
    description: "Score gate only at 0.50.",
    category: "ablation",
    scoreThreshold: 0.5,
    agreementCountMax: null,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-hardneg-only",
    description: "Hard-negative flag only.",
    category: "ablation",
    scoreThreshold: null,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-false-premise-only",
    description: "False-premise flag only.",
    category: "ablation",
    scoreThreshold: null,
    agreementCountMax: null,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: true,
  },
  {
    id: "ablation-hardneg-or-fp",
    description: "Hard-negative OR false-premise flags (no score).",
    category: "ablation",
    scoreThreshold: null,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: true,
  },
  {
    id: "ablation-score-0.40-or-hardneg",
    description: "Score<0.40 OR hard-negative flag (no false-premise).",
    category: "ablation",
    scoreThreshold: 0.4,
    agreementCountMax: null,
    useHardNegativeFlag: true,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-agreement-le1-or-score-0.40",
    description: "agreementCount<=1 OR score<0.40 (no flags).",
    category: "ablation",
    scoreThreshold: 0.4,
    agreementCountMax: 1,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
  {
    id: "ablation-agreement-le2-and-score-0.40",
    description: "agreementCount<=2 AND score<0.40 (AND-gate, no flags).",
    category: "ablation",
    scoreThreshold: 0.4,
    agreementCountMax: 2,
    useHardNegativeFlag: false,
    useFalsePremiseFlag: false,
  },
];

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one policy on one per-query signal set.
 * The function is pure. The decision is computed
 * per-query; the returned array is in the same
 * order as the input `perQuery` array.
 */
export function evaluatePolicy(
  policy: AbstentionPolicy,
  perQuery: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
    rank1: boolean;
    currentTruthAt1: boolean;
    hitAt5: boolean;
    /**
     * Optional, additive: the query's explicit
     * adversarial labels. The field flows through to
     * the per-decision `queryLabels` so a reviewer
     * can audit which labeled subset a decision is
     * associated with. The field is `undefined` for
     * queries without explicit labels (the
     * backward-compatible default).
     */
    queryLabels?: string[];
  }>,
): PolicyDecision[] {
  const out: PolicyDecision[] = new Array(perQuery.length);
  for (let i = 0; i < perQuery.length; i++) {
    const p = perQuery[i]!;
    const reasons: string[] = [];
    if (policy.scoreThreshold !== null) {
      // Treat `null` meanContributorScore as 0 so the
      // policy abstains on single-variant runs that
      // lack the contributor signal. The audit runner
      // reports this as "the policy is uninformative
      // on a single-variant run" because every query
      // gets a 0 score, so a non-trivial threshold
      // abstains on everything.
      const score = p.signals.meanContributorScore ?? 0;
      if (score < policy.scoreThreshold) reasons.push("score");
    }
    if (policy.agreementCountMax !== null) {
      // The agreement gate is a "negative" /
      // "weak-signal" ablation: a high agreement count
      // is a confidence signal, so a low agreement
      // count is a reason to abstain. The
      // `agreementCountMax` is the "abstain if
      // agreementCount <= max" rule; the policy
      // abstains when the ranker was NOT corroborated
      // by at least `max + 1` contributors.
      if (p.signals.agreementCount <= policy.agreementCountMax) {
        reasons.push("agreement");
      }
    }
    if (policy.useHardNegativeFlag && p.signals.isNoAnswerHardNegative) {
      reasons.push("hardNeg");
    }
    if (policy.useFalsePremiseFlag && p.signals.isFalsePremiseLike) {
      reasons.push("falsePrem");
    }
    const abstain = reasons.length > 0;
    out[i] = {
      queryId: p.queryId,
      family: p.family,
      isPositive: p.isPositive,
      abstain,
      reason: abstain ? reasons.join("+") : "none",
      rank1: p.rank1,
      currentTruthAt1: p.currentTruthAt1,
      hitAt5: p.hitAt5,
      ...(p.queryLabels !== undefined
        ? { queryLabels: [...p.queryLabels] }
        : {}),
    };
  }
  return out;
}

/**
 * Compute the metric block for one policy on one
 * per-query decision set. The function is pure. The
 * "baseline" numbers are computed from the same
 * per-query set (i.e. from the un-gated run), so the
 * deltas are meaningful: a policy that abstains on
 * no queries would have `hitAt5Retained === baseline.hitAt5`.
 *
 * The "should-abstain" binary task: `isPositive ===
 * false` (a no-answer query) is the positive class;
 * the policy's `abstain` is the prediction. So:
 *   - TP: no-answer query the policy abstained on.
 *   - FP: positive query the policy abstained on.
 *   - TN: positive query the policy retained.
 *   - FN: no-answer query the policy retained.
 * Precision / recall / F1 are computed in the usual
 * way on this 2x2.
 */
export function computePolicyMetrics(
  policy: AbstentionPolicy,
  decisions: ReadonlyArray<PolicyDecision>,
): PolicyMetrics {
  let total = 0;
  let noAnswerCount = 0;
  let positiveCount = 0;
  let noAnswerAbstained = 0;
  let positiveAbstained = 0;
  let hitAt5Retained = 0;
  let hitAt5Lost = 0;
  let rank1Retained = 0;
  let rank1Lost = 0;
  let currentTruthAt1Retained = 0;
  let currentTruthAt1Lost = 0;
  let baselineHitAt5 = 0;
  let baselineRank1 = 0;
  let baselineCurrentTruthAt1 = 0;
  let gateScore = 0;
  let gateAgreement = 0;
  let gateHardNeg = 0;
  let gateFalsePrem = 0;
  const positiveAbstainedByFamily: Record<
    string,
    { total: number; abstained: number }
  > = {};
  const falsePositives: Array<{ queryId: string; family: string; reason: string }> = [];
  const falseNegatives: Array<{ queryId: string; family: string; reason: string }> = [];
  for (const d of decisions) {
    total += 1;
    if (d.isPositive) {
      positiveCount += 1;
      if (d.hitAt5) baselineHitAt5 += 1;
      if (d.rank1) baselineRank1 += 1;
      if (d.currentTruthAt1) baselineCurrentTruthAt1 += 1;
      const familySlot = positiveAbstainedByFamily[d.family] ?? {
        total: 0,
        abstained: 0,
      };
      familySlot.total += 1;
      if (d.abstain) {
        positiveAbstained += 1;
        familySlot.abstained += 1;
        falsePositives.push({
          queryId: d.queryId,
          family: d.family,
          reason: d.reason,
        });
        if (d.hitAt5) hitAt5Lost += 1;
        if (d.rank1) rank1Lost += 1;
        if (d.currentTruthAt1) currentTruthAt1Lost += 1;
      } else {
        if (d.hitAt5) hitAt5Retained += 1;
        if (d.rank1) rank1Retained += 1;
        if (d.currentTruthAt1) currentTruthAt1Retained += 1;
      }
      positiveAbstainedByFamily[d.family] = familySlot;
    } else {
      noAnswerCount += 1;
      if (d.abstain) {
        noAnswerAbstained += 1;
      } else {
        falseNegatives.push({
          queryId: d.queryId,
          family: d.family,
          reason: d.reason,
        });
      }
    }
    // Gate counts are per-query-event. A query that
    // triggered two gates contributes to both buckets.
    if (d.abstain) {
      if (d.reason.includes("score")) gateScore += 1;
      if (d.reason.includes("agreement")) gateAgreement += 1;
      if (d.reason.includes("hardNeg")) gateHardNeg += 1;
      if (d.reason.includes("falsePrem")) gateFalsePrem += 1;
    }
  }
  const positiveAbstainedByFamilyRates: Record<
    string,
    { total: number; abstained: number; rate: number }
  > = {};
  for (const [family, slot] of Object.entries(positiveAbstainedByFamily)) {
    positiveAbstainedByFamilyRates[family] = {
      total: slot.total,
      abstained: slot.abstained,
      rate: slot.total > 0 ? slot.abstained / slot.total : 0,
    };
  }
  // Precision / recall / F1 on the should-abstain
  // binary task. Positive class = no-answer.
  //   TP = no-answer, abstain     (noAnswerAbstained)
  //   FP = positive, abstain     (positiveAbstained)
  //   FN = no-answer, retain     (noAnswerCount - noAnswerAbstained)
  //   TN = positive, retain      (positiveCount - positiveAbstained)
  const tp = noAnswerAbstained;
  const fp = positiveAbstained;
  const fn = noAnswerCount - noAnswerAbstained;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    policyId: policy.id,
    total,
    noAnswerCount,
    positiveCount,
    noAnswerAbstained,
    noAnswerAbstainedRate: noAnswerCount > 0 ? noAnswerAbstained / noAnswerCount : 0,
    positiveAbstained,
    positiveAbstainedRate: positiveCount > 0 ? positiveAbstained / positiveCount : 0,
    positiveAbstainedByFamily: positiveAbstainedByFamilyRates,
    hitAt5Retained,
    hitAt5Lost,
    hitAt5RetainedRate: baselineHitAt5 > 0 ? hitAt5Retained / baselineHitAt5 : 0,
    rank1Retained,
    rank1Lost,
    rank1RetainedRate: baselineRank1 > 0 ? rank1Retained / baselineRank1 : 0,
    currentTruthAt1Retained,
    currentTruthAt1Lost,
    currentTruthAt1RetainedRate:
      baselineCurrentTruthAt1 > 0
        ? currentTruthAt1Retained / baselineCurrentTruthAt1
        : 0,
    baseline: {
      hitAt5: baselineHitAt5,
      rank1: baselineRank1,
      currentTruthAt1: baselineCurrentTruthAt1,
    },
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    gateCounts: {
      score: gateScore,
      agreement: gateAgreement,
      hardNeg: gateHardNeg,
      falsePrem: gateFalsePrem,
    },
  };
}

// ---------------------------------------------------------------------------
// Build per-query input from a benchmark report
// ---------------------------------------------------------------------------

/**
 * Build the per-query input the policy evaluator
 * needs from a benchmark `QueryEval[]`. The function
 * is pure. The signals block is optional: the
 * evaluator treats `null` / `undefined` as a missing
 * signal (zero on the score / agreement counts, all
 * flags false). A reviewer who wants a richer input
 * can build the per-query array by hand and call
 * `evaluatePolicy` directly.
 *
 * The `hitAt5` field is computed from the per-query
 * `expectedIds` and `topIds` arrays; the policy
 * evaluator does NOT depend on the `passed` flag
 * because `passed` is a binary "the system passed
 * this query under the run's hit@5 contract" flag
 * that the audit's "all" slice treats the same as
 * "an expected id is in the top-5".
 */
export function buildPolicyPerQuery(
  evals: ReadonlyArray<QueryEval>,
  signalsByQueryId: ReadonlyMap<string, AbstentionSignals> = new Map(),
  /**
   * Optional, additive: an explicit
   * `queryId -> labels[]` map. The fields flow
   * through to the per-decision `queryLabels`
   * so a reviewer can audit which labeled
   * subset a per-query decision is associated
   * with. The map is empty by default (the
   * backward-compatible default). The
   * adversarial-expansion corpus uses this to
   * surface the labeled adversarial property
   * subsets on the policy artifact.
   */
  labelsByQueryId: ReadonlyMap<string, string[]> = new Map(),
): Array<{
  queryId: string;
  family: string;
  isPositive: boolean;
  signals: AbstentionSignals;
  rank1: boolean;
  currentTruthAt1: boolean;
  hitAt5: boolean;
  queryLabels?: string[];
}> {
  const out: Array<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
    rank1: boolean;
    currentTruthAt1: boolean;
    hitAt5: boolean;
    queryLabels?: string[];
  }> = [];
  for (const e of evals) {
    // Use the provided signals if available; otherwise
    // synthesize a "no signal" block. The synthesized
    // block has all-zero scores (so a non-trivial
    // score gate abstains on every query), all flags
    // false (so a flag-only policy abstains on no
    // query), and an empty source presence. The
    // evaluator's per-policy gate counts will reflect
    // the absence of the signal block.
    const signals =
      signalsByQueryId.get(e.queryId) ??
      emptyAbstentionSignals();
    // Compute hit@5 from the eval (the contract the
    // audit's "all" slice uses). A no-answer query has
    // `expectedIds.length === 0` and `topIds.length ===
    // 0` iff the system abstained; treat that as
    // `hitAt5 = true` for the positive set's purposes
    // (a no-answer query is never a positive hit).
    let hitAt5: boolean;
    if (e.expectedIds.length === 0) {
      // No-answer query: a "hit" is the system
      // returning nothing. The policy evaluator
      // computes hit@5 on the positive set only, so
      // this branch is irrelevant for the metric;
      // we set `false` so any downstream positive-set
      // aggregator skips the no-answer query.
      hitAt5 = false;
    } else {
      const expected = new Set(e.expectedIds);
      hitAt5 = e.topIds.slice(0, 5).some((id) => expected.has(id));
    }
    const labels = labelsByQueryId.get(e.queryId);
    out.push({
      queryId: e.queryId,
      family: e.family,
      isPositive: e.expectedIds.length > 0,
      signals,
      rank1: e.rank1,
      currentTruthAt1: e.currentTruthAt1,
      hitAt5,
      ...(labels !== undefined ? { queryLabels: [...labels] } : {}),
    });
  }
  return out;
}

/**
 * Build an "empty" `AbstentionSignals` block. The
 * function exists so the policy evaluator can run
 * without the audit's per-query signal block (e.g.
 * on a regular benchmark report that does not carry
 * the audit's signals). The block is a typed no-op:
 * all numeric signals are 0, all flags are false,
 * the source presence is `"___"`.
 */
export function emptyAbstentionSignals(): AbstentionSignals {
  return {
    topScore: 0,
    top1Top2Gap: 0,
    top1Top2Ratio: 1,
    returnedCount: 0,
    agreementCount: 0,
    minContributorRank: null,
    maxContributorRank: null,
    meanContributorRank: null,
    minContributorScore: null,
    maxContributorScore: null,
    meanContributorScore: null,
    sourcePresence: "___",
    isNoAnswerHardNegative: false,
    isTemporalCurrent: false,
    isNegationLike: false,
    isOodEntityLike: false,
    isParaphraseTrap: false,
    isFalsePremiseLike: false,
    isAdversarialParaphrase: false,
    isDivergentTemporal: false,
    isNearMissCurrentCluster: false,
  };
}
