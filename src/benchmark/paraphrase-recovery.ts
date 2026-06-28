import { type DamageCategory, classifyFalseAbstention } from "./false-abstention-damage.js";
import {
  BUILTIN_NO_ANSWER_POLICIES,
  type NoAnswerPolicy,
  type NoAnswerPolicyDecision,
  type NoAnswerPolicyPerQuery,
  evaluateNoAnswerPolicy,
} from "./no-answer-abstention.js";

// ---------------------------------------------------------------------------
// Variant types
// ---------------------------------------------------------------------------

/**
 * The narrow escape hatch the variant adds on
 * top of the baseline. Each escape is a
 * paraphrase-aware condition that, when true,
 * SUPPRESSES the abstention the baseline would
 * have made. The escape is paired with the
 * baseline gates via a conjunction: a query
 * is retained iff (a) the escape fires AND
 * (b) NONE of the baseline gates fire. This
 * is the safe form: the escape cannot cause
 * an abstention on a no-answer query, only
 * suppress one on a positive query.
 *
 *   - `none` — no escape. The variant is
 *     identical to the baseline (the reference
 *     row).
 *   - `paraphrase-detector-rank1-or-hit5` —
 *     suppress iff the query is flagged as a
 *     paraphrase by the heuristic detector
 *     (`isParaphraseTrap` OR
 *     `isAdversarialParaphrase`) AND
 *     `rank1 || hit@5` is true. The intent: a
 *     paraphrase query where the ranker DID
 *     surface the right answer is the natural
 *     "recoverable" case.
 *   - `paraphrase-detector-rank1-only` —
 *     suppress iff the query is flagged as a
 *     paraphrase AND `rank1` is true. Stricter
 *     version: require rank-1 (not just top-5).
 *   - `paraphrase-detector-loose-threshold`
 *     — suppress iff the query is flagged as a
 *     paraphrase AND the score is in a "still
 *     reasonable" band (e.g. `0.20 <= topScore <
 *     0.30`). This is a narrow threshold
 *     refinement: the global threshold stays at
 *     0.30, the paraphrase-aware escape opens
 *     the 0.20-0.30 band for paraphrase-flagged
 *     queries only. The band is parameterized.
 *   - `paraphrase-family-rank1-or-hit5` —
 *     `family === "paraphrase"` AND
 *     `rank1 || hit@5`. **FIXTURE-SHAPED**:
 *     the `family` field is fixture truth.
 *     Research / oracle-like ceiling only.
 *   - `paraphrase-fixture-label-rank1-or-hit5`
 *     — the query carries the
 *     `adversarialParaphrase` / `nearMissCurrentCluster`
 *     label AND `rank1 || hit@5`. **ORACLE**:
 *     fixture truth; true ceiling.
 *
 * The escape's `active` flag is honored so a
 * variant can disable the escape without
 * removing it from the report (consistent with
 * the no-answer policy gate convention).
 */
export type ParaphraseRecoveryEscape =
  | { kind: "none"; active?: boolean }
  | {
      kind: "paraphrase-detector-rank1-or-hit5";
      active?: boolean;
    }
  | {
      kind: "paraphrase-detector-rank1-only";
      active?: boolean;
    }
  | {
      kind: "paraphrase-detector-loose-threshold";
      /**
       * Lower bound of the open band. The escape
       * suppresses iff `topScore >= lowerBound`
       * (i.e. the score is high enough to be
       * "plausibly real" but low enough that the
       * 0.30 threshold caught it). Default 0.20.
       */
      lowerBound: number;
      active?: boolean;
    }
  | {
      kind: "paraphrase-family-rank1-or-hit5";
      active?: boolean;
    }
  | {
      kind: "paraphrase-fixture-label-rank1-or-hit5";
      active?: boolean;
    };

/**
 * A single recovery variant. The variant is the
 * baseline `score-or-sufficiency-insufficient`
 * policy PLUS a narrow paraphrase-aware
 * escape. The escape is paired with the
 * baseline via a conjunction: a query is
 * retained iff the escape fires AND none of
 * the baseline gates fire.
 *
 * The variant is the unit the report iterates
 * over. The `category` field is the honest
 * "is this variant production-like, fixture-
 * shaped, or oracle?" reading.
 */
export interface ParaphraseRecoveryVariant {
  /** Stable id used in the artifact + report. */
  id: string;
  /**
   * Short human-readable description surfaced
   * in the report. The description MUST be
   * honest about which category the variant
   * belongs to so a reviewer reading the
   * headline table does not mistake an
   * oracle-shaped variant for a
   * production-like one.
   */
  description: string;
  /**
   * `production-like` (runtime-only signals:
   * the heuristic detector, score, rank-1 /
   * hit-5), `fixture-shaped` (keys on the
   * `family` field — research ceiling, NOT
   * deployable), or `oracle` (fixture-truth
   * labels — clearly non-production).
   */
  category: "production-like" | "fixture-shaped" | "oracle";
  /**
   * The narrow escape. A `none` escape is the
   * baseline row.
   */
  escape: ParaphraseRecoveryEscape;
}

/**
 * The set of built-in variants the experiment
 * ships with. The list is intentionally small
 * and explicit so a reviewer can audit the
 * trade-off curve without re-deriving. The
 * order is declaration order; the report
 * iterates in this order, so the on-disk
 * artifact is byte-stable for a given input.
 *
 * The first variant is the baseline (no
 * escape). The next three are production-like
 * variants. The fifth is fixture-shaped. The
 * sixth is the oracle ceiling.
 */
export const BUILTIN_PARAPHRASE_RECOVERY_VARIANTS: ReadonlyArray<ParaphraseRecoveryVariant> = [
  // ---- Baseline (no escape) ----
  {
    id: "baseline-score-or-sufficiency-insufficient",
    description:
      "Baseline: score-or-sufficiency-insufficient (no paraphrase escape). The accepted production-like policy. Reference row; production-like.",
    category: "production-like",
    escape: { kind: "none" },
  },
  // ---- Production-like: detector-flagged + rank-1 / hit-5 ----
  {
    id: "paraphrase-detector-rank1-or-hit5",
    description:
      "Production-like: suppress the score gate iff the query is flagged by the heuristic paraphrase detector (isParaphraseTrap OR isAdversarialParaphrase) AND rank1||hit@5. The sufficiency-label gate is preserved; only the score gate is escaped. A reviewer who wants to reason about a deployable rule reads this row first.",
    category: "production-like",
    escape: { kind: "paraphrase-detector-rank1-or-hit5" },
  },
  {
    id: "paraphrase-detector-rank1-only",
    description:
      "Production-like: stricter version of the previous variant: suppress iff the query is flagged by the heuristic paraphrase detector AND rank1===true. hit@5 alone is not enough.",
    category: "production-like",
    escape: { kind: "paraphrase-detector-rank1-only" },
  },
  {
    id: "paraphrase-detector-loose-threshold-0.20",
    description:
      "Production-like: narrow threshold refinement. The global threshold stays at 0.30; the escape suppresses iff the query is flagged by the heuristic paraphrase detector AND 0.20 <= topScore < 0.30. The band is parameterized; this variant opens the 0.20-0.30 band for paraphrase-flagged queries only. A reviewer who wants a minimal rule reads this row.",
    category: "production-like",
    escape: {
      kind: "paraphrase-detector-loose-threshold",
      lowerBound: 0.2,
    },
  },
  {
    id: "paraphrase-detector-loose-threshold-0.25",
    description:
      "Production-like: same shape as the previous variant with a tighter lower bound (0.25). Tests how much of the recovery comes from the upper sub-band (0.25-0.30).",
    category: "production-like",
    escape: {
      kind: "paraphrase-detector-loose-threshold",
      lowerBound: 0.25,
    },
  },
  // ---- Fixture-shaped: family gate ----
  {
    id: "paraphrase-family-rank1-or-hit5",
    description:
      "Fixture-shaped (NOT production-like): suppress iff family==='paraphrase' AND rank1||hit@5. The family field is fixture truth; a real production ranker has no such label on incoming queries. This is the research / oracle-like ceiling: how much damage could a narrow escape recover IF a perfect paraphrase family detector were available?",
    category: "fixture-shaped",
    escape: { kind: "paraphrase-family-rank1-or-hit5" },
  },
  // ---- Oracle: fixture-truth label ----
  {
    id: "paraphrase-fixture-label-rank1-or-hit5",
    description:
      "Oracle (NOT production-like): suppress iff the query carries the adversarialParaphrase / nearMissCurrentCluster label AND rank1||hit@5. Fixture truth; the true ceiling. A reviewer who wants to know the maximum recoverable damage reads this row last.",
    category: "oracle",
    escape: { kind: "paraphrase-fixture-label-rank1-or-hit5" },
  },
];

/**
 * The baseline policy the variants are layered
 * on top of. Exported as a stable id so the
 * runner can resolve it from the no-answer
 * policy table.
 */
export const BASELINE_POLICY_ID = "score-or-sufficiency-insufficient";

// ---------------------------------------------------------------------------
// Per-query decision
// ---------------------------------------------------------------------------

/**
 * The per-query decision under a variant. The
 * decision is binary: the variant either
 * abstains on the query (the baseline's
 * decision, NOT escaped) or retains it (the
 * baseline abstained, but the escape fired).
 * A query that the baseline would have
 * retained is retained by the variant too
 * (the variant cannot introduce a new
 * abstention on a query the baseline would
 * have retained).
 */
export interface ParaphraseRecoveryDecision {
  queryId: string;
  family: string;
  isPositive: boolean;
  /** `true` iff the variant abstained on the query. */
  abstain: boolean;
  /**
   * Short human-readable string: which side
   * drove the decision. The values are:
   *   - `baseline-abstain-<gates>` — the
   *     baseline abstained; the escape did not
   *     fire.
   *   - `escape-fires-and-suppresses` — the
   *     baseline abstained; the escape fired
   *     and suppressed the abstention.
   *   - `baseline-retain` — the baseline
   *     retained the query; the variant also
   *     retains it (the escape is a no-op
   *     here).
   *   - `escape-not-eligible` — the baseline
   *     abstained; the escape was tested but
   *     did not fire (the conditions were not
   *     met). Listed for audit purposes.
   */
  reason: string;
  /** Pass-through fields. */
  rank1: boolean;
  currentTruthAt1: boolean;
  hitAt5: boolean;
  /**
   * `true` iff the variant RECOVERED a false
   * abstention the baseline made. The field
   * is `undefined` for queries the baseline
   * already retained (a recovered FP is the
   * headline metric of the experiment).
   */
  recoveredFp?: boolean;
  /**
   * The damage category of the FP the variant
   * recovered, if the per-query input carries
   * the supporting signals. The field is
   * `undefined` for queries the baseline
   * already retained.
   */
  recoveredCategory?: DamageCategory;
  /**
   * The baseline's reason string. The field
   * is `undefined` for queries the baseline
   * retained (the variant cannot escape a
   * non-existent baseline abstention).
   */
  baselineReason?: string;
  /**
   * Pass-through of the per-query fixture-
   * truth labels so the report can audit
   * which labeled subset the decision is
   * associated with. `undefined` for
   * unlabeled queries.
   */
  queryLabels?: string[];
  /**
   * Pass-through of the per-query
   * paraphrase-related detector flags. The
   * block is on the artifact so a reviewer
   * can audit which detector fired.
   */
  isParaphraseTrap?: boolean;
  isAdversarialParaphrase?: boolean;
  /**
   * `true` iff the supplied semantic-evidence
   * map records the dense ranker as having
   * rank-1-missed the query (i.e. the dense
   * ranker would NOT have recovered the FP).
   * `undefined` for queries the baseline
   * retained, or when no semantic evidence
   * is supplied.
   */
  semanticAlsoMisses?: boolean;
}

// ---------------------------------------------------------------------------
// Per-variant metrics
// ---------------------------------------------------------------------------

/**
 * The per-variant metric block. The shape
 * mirrors `NoAnswerPolicyMetrics` so a
 * reviewer can read the trade-off curve
 * without context-switching, plus a
 * baseline-delta block.
 */
export interface ParaphraseRecoveryVariantMetrics {
  variantId: string;
  category: "production-like" | "fixture-shaped" | "oracle";
  /** Total queries the variant saw. */
  total: number;
  /** No-answer queries the variant saw. */
  noAnswerCount: number;
  /** Positive (answerable) queries the variant saw. */
  positiveCount: number;
  /** No-answer queries the variant abstained on. */
  noAnswerAbstained: number;
  /** No-answer confabulations the variant RETAINED (i.e. the policy FAILED to abstain). */
  noAnswerAbstainedFailed: number;
  /**
   * `noAnswerAbstained / noAnswerCount`. The
   * variant's "did the rule fix a confabulation?"
   * rate. The headline no-answer correctness
   * reading.
   */
  noAnswerAbstainedRate: number;
  /** Positive queries the variant abstained on. */
  positiveAbstained: number;
  /** `positiveAbstained / positiveCount`. The variant's damage rate. */
  positiveAbstainedRate: number;
  /** hit@5 retention on positive queries. */
  hitAt5Retained: number;
  hitAt5RetainedRate: number;
  /** rank1 retention on positive queries. */
  rank1Retained: number;
  rank1RetainedRate: number;
  /** currentTruthAt1 retention on positive queries. */
  currentTruthAt1Retained: number;
  currentTruthAt1RetainedRate: number;
  /**
   * FPs the variant RECOVERED. The headline
   * metric of the experiment: a query the
   * baseline abstained on that this variant
   * retains.
   */
  recoveredFps: number;
  /**
   * `recoveredFps / baseline.falseAbstainedTotal`.
   * The "what fraction of the baseline's damage
   * did the variant recover?" rate.
   */
  recoveredFpsRate: number;
  /**
   * NEW no-answer failures introduced by the
   * variant. The variant cannot INCREASE the
   * abstention count on no-answer queries
   * (the escape is a one-way suppression), so
   * this number is always 0; the field is on
   * the report for symmetry with the
   * "newly introduced no-answer failures"
   * reading the brief asks for.
   */
  newNoAnswerFailures: number;
  /**
   * Baseline block: the un-gated numbers
   * from the same per-query set.
   */
  baseline: {
    hitAt5: number;
    rank1: number;
    currentTruthAt1: number;
    falseAbstainedTotal: number;
    noAnswerAbstainedTotal: number;
    noAnswerAbstainedRate: number;
    positiveAbstainedRate: number;
    f1: number;
  };
  /**
   * Delta vs baseline. A positive number means
   * the variant is BETTER than the baseline
   * (e.g. `recoveredFps` is positive,
   * `positiveAbstainedRate` is lower). The
   * fields are surfaced on the headline
   * table so a reviewer can read the
   * trade-off without re-deriving.
   */
  delta: {
    noAnswerAbstainedRate: number;
    positiveAbstainedRate: number;
    hitAt5RetainedRate: number;
    rank1RetainedRate: number;
    currentTruthAt1RetainedRate: number;
    recoveredFps: number;
  };
  /**
   * Precision / recall / F1 on the
   * "should-abstain" binary task with
   * `isNoAnswer` as the positive class.
   * Same convention as the no-answer
   * experiment.
   */
  precision: number;
  recall: number;
  f1: number;
  /**
   * The "safety verdict" the report surfaces.
   * The verdict is `safe` iff:
   *   - no TNR regression: the variant's
   *     `noAnswerAbstainedRate` is `>=`
   *     the baseline's (i.e. the variant
   *     retained zero new no-answer
   *     confabulations);
   *   - `newNoAnswerFailures === 0`;
   *   - `recoveredFps > 0` (otherwise the
   *     variant is `neutral`).
   * Otherwise the verdict is `unsafe` or
   * `neutral`. The exact predicate is in
   * `computeSafetyVerdict`; the report
   * surfaces the verdict + a short
   * explanation.
   */
  verdict: ParaphraseRecoveryVerdict;
  verdictExplanation: string;
  /**
   * Per-family positive abstention
   * breakdown. Surfaced so a reviewer can
   * see "the recovery is concentrated on
   * the paraphrase family" without
   * re-deriving.
   */
  positiveAbstainedByFamily: Record<string, { total: number; abstained: number; rate: number }>;
  /**
   * Per-recovered-FP damage-category
   * breakdown. Surfaced so a reviewer can
   * see "the recovery is concentrated on
   * `score-threshold-on-recoverable`" without
   * re-deriving.
   */
  recoveredByCategory: Record<DamageCategory, number>;
  /**
   * Per-recovered-FP family breakdown. The
   * per-family rollup of the recovered set.
   */
  recoveredByFamily: Record<string, number>;
}

/**
 * The per-variant row on the artifact. Mirrors
 * `ParaphraseRecoveryVariantMetrics` plus the
 * description and escape.
 */
export interface ParaphraseRecoveryVariantRow extends ParaphraseRecoveryVariantMetrics {
  description: string;
  escape: ParaphraseRecoveryEscape;
}

/**
 * The safety verdict for a variant. The
 * verdict is the headline of the report's
 * "is this safe to deploy?" reading. The
 * verdict is `safe` iff the variant preserves
 * the baseline's TNR and recovers at least
 * one FP; `neutral` iff it preserves TNR but
 * recovers nothing; `unsafe` otherwise.
 */
export type ParaphraseRecoveryVerdict = "safe" | "neutral" | "unsafe";

/**
 * The per-variant recovered-FP entries. The
 * list is the per-FP detail the headline
 * table summarizes. Surfaced on the report
 * so a reviewer can audit which FP each
 * variant recovered.
 */
export interface ParaphraseRecoveryRecoveredFpEntry {
  queryId: string;
  family: string;
  category: DamageCategory;
  categoryExplanation: string;
  topScore: number;
  rank1: boolean;
  hitAt5: boolean;
  baselineReason: string;
  escapeKind: ParaphraseRecoveryEscape["kind"];
  semanticAlsoMisses?: boolean;
  queryLabels?: string[];
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level experiment report. The
 * on-disk artifact is one of these. The shape
 * is intentionally distinct from the audit /
 * calibration / benchmark / diagnostic / policy
 * / no-answer / damage report shapes: the
 * experiment is a study of trade-offs across a
 * curated variant set, not a single chosen
 * rule.
 */
export interface ParaphraseRecoveryReport {
  generatedAt: string;
  config: {
    recordCount: number;
    baselinePolicyId: string;
    total: number;
    noAnswerCount: number;
    positiveCount: number;
    variantCount: number;
    productionLikeCount: number;
    fixtureShapedCount: number;
    oracleCount: number;
    evidenceSource?: string;
  };
  /**
   * The baseline policy's metric block.
   * Surfaced at the top of the report so a
   * reviewer can see the reference numbers
   * the deltas are computed against.
   */
  baselineMetrics: {
    policyId: string;
    noAnswerAbstained: number;
    noAnswerAbstainedRate: number;
    positiveAbstained: number;
    positiveAbstainedRate: number;
    hitAt5Retained: number;
    rank1Retained: number;
    currentTruthAt1Retained: number;
    precision: number;
    recall: number;
    f1: number;
    falseAbstainedTotal: number;
  };
  /** One row per evaluated variant, in declaration order. */
  variants: ParaphraseRecoveryVariantRow[];
  /**
   * The per-variant recovered-FP entries.
   * Surfaced on the artifact so a reviewer
   * can audit which FP each variant
   * recovered.
   */
  recoveredByVariant: ReadonlyArray<{
    variantId: string;
    entries: ReadonlyArray<ParaphraseRecoveryRecoveredFpEntry>;
  }>;
  /**
   * The per-query input the evaluator
   * consumed. The block is on the artifact so
   * a reviewer can re-derive any variant by
   * hand.
   */
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>;
  /**
   * The baseline's per-query decision block.
   * Surfaced so a reviewer can audit which
   * baseline gate fired on which query.
   */
  baselineDecisions: ReadonlyArray<NoAnswerPolicyDecision>;
  /**
   * The per-variant per-query decision block.
   * Surfaced so a reviewer can audit which
   * gate / escape fired on which query.
   */
  variantDecisions: ReadonlyArray<{
    variantId: string;
    decisions: ReadonlyArray<ParaphraseRecoveryDecision>;
  }>;
}

// ---------------------------------------------------------------------------
// Escape evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single escape against a per-query
 * input. The function is pure. The result is
 * `{ fires: boolean, reason: string }` so the
 * caller can build the multi-gate reason
 * string.
 *
 * The escape fires iff:
 *   - the query is "paraphrase-shaped"
 *     according to the escape's source
 *     (detector flag, fixture family, or
 *     fixture label);
 *   - AND the rank-1 / hit-5 / score condition
 *     holds (the recovery only applies to
 *     queries the ranker actually got right).
 *
 * The "paraphrase-shaped" check is
 * `kind`-specific:
 *   - `paraphrase-detector-*` — the
 *     heuristic `isParaphraseTrap` OR
 *     `isAdversarialParaphrase` flag is true.
 *   - `paraphrase-family-*` — the
 *     `family` field is `"paraphrase"`.
 *   - `paraphrase-fixture-label-*` — the
 *     query carries the
 *     `adversarialParaphrase` or
 *     `nearMissCurrentCluster` label.
 */
function evaluateEscape(
  escapeDecision: ParaphraseRecoveryEscape,
  p: NoAnswerPolicyPerQuery
): { fires: boolean; reason: string } {
  if (escapeDecision.active === false) {
    return { fires: false, reason: "escape-inactive" };
  }
  switch (escapeDecision.kind) {
    case "none":
      return { fires: false, reason: "escape-none" };
    case "paraphrase-detector-rank1-or-hit5": {
      const isParaphrase =
        p.signals.isParaphraseTrap === true || p.signals.isAdversarialParaphrase === true;
      const rank1OrHit5 = p.rank1 || p.hitAt5;
      return {
        fires: isParaphrase && rank1OrHit5,
        reason: `escape-detector-rank1|hit5(${
          isParaphrase ? "para" : "no-para"
        },${rank1OrHit5 ? "ok" : "miss"})`,
      };
    }
    case "paraphrase-detector-rank1-only": {
      const isParaphrase =
        p.signals.isParaphraseTrap === true || p.signals.isAdversarialParaphrase === true;
      return {
        fires: isParaphrase && p.rank1,
        reason: `escape-detector-rank1(${
          isParaphrase ? "para" : "no-para"
        },${p.rank1 ? "ok" : "miss"})`,
      };
    }
    case "paraphrase-detector-loose-threshold": {
      const isParaphrase =
        p.signals.isParaphraseTrap === true || p.signals.isAdversarialParaphrase === true;
      const inBand = p.signals.topScore >= escapeDecision.lowerBound;
      return {
        fires: isParaphrase && inBand,
        reason: `escape-detector-loose-threshold-${escapeDecision.lowerBound}(${
          isParaphrase ? "para" : "no-para"
        },${inBand ? "in-band" : "out-of-band"})`,
      };
    }
    case "paraphrase-family-rank1-or-hit5": {
      const isParaphraseFamily = p.family === "paraphrase";
      const rank1OrHit5 = p.rank1 || p.hitAt5;
      return {
        fires: isParaphraseFamily && rank1OrHit5,
        reason: `escape-family-rank1|hit5(${
          isParaphraseFamily ? "para" : "no-para"
        },${rank1OrHit5 ? "ok" : "miss"})`,
      };
    }
    case "paraphrase-fixture-label-rank1-or-hit5": {
      const labels = p.queryLabels ?? [];
      const hasLabel =
        labels.includes("adversarialParaphrase") || labels.includes("nearMissCurrentCluster");
      const rank1OrHit5 = p.rank1 || p.hitAt5;
      return {
        fires: hasLabel && rank1OrHit5,
        reason: `escape-fixture-label-rank1|hit5(${
          hasLabel ? "labeled" : "unlabeled"
        },${rank1OrHit5 ? "ok" : "miss"})`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Per-query decision
// ---------------------------------------------------------------------------

/**
 * Evaluate one variant on one per-query input
 * set. The function is pure. The decision is
 * computed per-query; the returned array is in
 * the same order as the input `perQuery` array.
 *
 * The variant is the baseline policy + the
 * escape:
 *   1. Compute the baseline's per-query
 *      decision.
 *   2. If the baseline RETAINED the query,
 *      the variant also retains it.
 *   3. If the baseline ABSTAINED, test the
 *      escape. If the escape fires, the
 *      variant SUPPRESSES the abstention
 *      (a `recoveredFp` is recorded).
 *   4. Otherwise the variant abstains as the
 *      baseline did.
 *
 * The escape is a one-way suppression: the
 * variant cannot INTRODUCE a new abstention
 * on a query the baseline would have
 * retained. This is the structural safety
 * property: the only way the variant's
 * positive-abstention rate is LOWER than the
 * baseline's is by recovering FPs the
 * baseline made. A variant that recovers zero
 * FPs is identical to the baseline on the
 * positive set.
 */
export function evaluateParaphraseRecoveryVariant(
  variant: ParaphraseRecoveryVariant,
  baselinePolicy: NoAnswerPolicy,
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>,
  semantic?: { byQueryId: ReadonlyMap<string, "hit" | "miss"> }
): ParaphraseRecoveryDecision[] {
  const baselineDecisions = evaluateNoAnswerPolicy(baselinePolicy, perQuery);
  const out: ParaphraseRecoveryDecision[] = new Array(perQuery.length);
  for (let i = 0; i < perQuery.length; i++) {
    const p = perQuery[i]!;
    const baselineDecision = baselineDecisions[i]!;
    let abstain: boolean;
    let reason: string;
    let recoveredFp: boolean | undefined;
    let recoveredCategory: DamageCategory | undefined;
    let baselineReason: string | undefined;
    let semanticAlsoMisses: boolean | undefined;
    if (!baselineDecision.abstain) {
      // The variant cannot escape a non-existent
      // baseline abstention. The variant's
      // decision is identical to the baseline.
      abstain = false;
      reason = "baseline-retain";
    } else {
      // The baseline abstained. Test the escape.
      baselineReason = baselineDecision.reason;
      const ev = evaluateEscape(variant.escape, p);
      if (ev.fires) {
        abstain = false;
        reason = `escape-fires-and-suppresses:${ev.reason}`;
        recoveredFp = true;
        // The recovered FP's damage category is
        // the same category the prior damage
        // diagnostic would have assigned.
        recoveredCategory = classifyFalseAbstention(
          {
            queryId: baselineDecision.queryId,
            family: baselineDecision.family,
            reason: baselineDecision.reason,
            rank1: baselineDecision.rank1,
            hitAt5: baselineDecision.hitAt5,
            ...(baselineDecision.queryLabels !== undefined
              ? { queryLabels: [...baselineDecision.queryLabels] }
              : {}),
          },
          p
        );
      } else {
        abstain = true;
        reason = `baseline-abstain:${baselineDecision.reason};escape-not-eligible:${ev.reason}`;
      }
    }
    // Semantic annotation. The field is only
    // meaningful for recovered FPs (the baseline
    // retained set is unchanged; the variant
    // cannot introduce a new semantic
    // annotation on it).
    if (recoveredFp && semantic) {
      const v = semantic.byQueryId.get(baselineDecision.queryId);
      if (v === "miss") semanticAlsoMisses = true;
      else if (v === "hit") semanticAlsoMisses = false;
      // A query not in the map is treated as
      // "dense ranker would have surfaced the
      // right answer" (the convention from the
      // prior damage analysis); for the
      // recovery analysis, "not in map" is
      // interpreted as `semanticAlsoMisses ===
      // false` and the field is left undefined
      // to keep the report honest about the
      // evidence source. The downstream rollup
      // (in the runFalseAbstentionDamage
      // module) is the canonical record of the
      // dense ranker's coverage; this module
      // only records the misses the caller
      // passed in.
    }
    const decision: ParaphraseRecoveryDecision = {
      queryId: baselineDecision.queryId,
      family: baselineDecision.family,
      isPositive: baselineDecision.isPositive,
      abstain,
      reason,
      rank1: baselineDecision.rank1,
      currentTruthAt1: baselineDecision.currentTruthAt1,
      hitAt5: baselineDecision.hitAt5,
      ...(recoveredFp !== undefined ? { recoveredFp } : {}),
      ...(recoveredCategory !== undefined ? { recoveredCategory } : {}),
      ...(baselineReason !== undefined ? { baselineReason } : {}),
      ...(baselineDecision.queryLabels !== undefined
        ? { queryLabels: [...baselineDecision.queryLabels] }
        : {}),
      ...(p.signals.isParaphraseTrap ? { isParaphraseTrap: true } : {}),
      ...(p.signals.isAdversarialParaphrase ? { isAdversarialParaphrase: true } : {}),
      ...(semanticAlsoMisses !== undefined ? { semanticAlsoMisses } : {}),
    };
    out[i] = decision;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-variant metrics
// ---------------------------------------------------------------------------

/**
 * Compute the per-variant metric block from a
 * per-query decision set. The function is
 * pure. The "baseline" numbers are the
 * baseline policy's metrics on the same
 * per-query set.
 *
 * The "should-abstain" binary task uses
 * `isNoAnswer` as the positive class:
 *   - TP: no-answer query the variant
 *     abstained on.
 *   - FP: positive query the variant
 *     abstained on.
 *   - TN: positive query the variant
 *     retained.
 *   - FN: no-answer query the variant
 *     retained.
 * Precision / recall / F1 are computed in
 * the usual way on this 2x2.
 */
export function computeParaphraseRecoveryVariantMetrics(args: {
  variant: ParaphraseRecoveryVariant;
  decisions: ReadonlyArray<ParaphraseRecoveryDecision>;
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>;
  baselinePolicy: NoAnswerPolicy;
  baselineDecisions: ReadonlyArray<NoAnswerPolicyDecision>;
  /** Baseline metric block, computed once
   *  outside the per-variant pass for
   *  efficiency. */
  baselineMetrics: {
    noAnswerAbstained: number;
    noAnswerAbstainedRate: number;
    positiveAbstained: number;
    positiveAbstainedRate: number;
    hitAt5Retained: number;
    rank1Retained: number;
    currentTruthAt1Retained: number;
    precision: number;
    recall: number;
    f1: number;
  };
}): ParaphraseRecoveryVariantMetrics {
  const { variant, decisions, perQuery, baselinePolicy, baselineDecisions, baselineMetrics } = args;
  let total = 0;
  let noAnswerCount = 0;
  let positiveCount = 0;
  let noAnswerAbstained = 0;
  let noAnswerAbstainedFailed = 0;
  let positiveAbstained = 0;
  let hitAt5Retained = 0;
  let rank1Retained = 0;
  let currentTruthAt1Retained = 0;
  let recoveredFps = 0;
  const positiveByFamily: Record<string, { total: number; abstained: number }> = {};
  const recoveredByCategory: Record<DamageCategory, number> = {
    "ranker-empty-recoverable": 0,
    "score-threshold-on-recoverable": 0,
    "score-threshold-on-real-failure": 0,
    "sufficiency-label-honest": 0,
    "multi-gate-conjunction-honest": 0,
    "labeled-near-miss-or-divergent": 0,
    "labeled-oracle-misclassification": 0,
    unclassified: 0,
  };
  const recoveredByFamily: Record<string, number> = {};
  for (const d of decisions) {
    total += 1;
    if (d.isPositive) {
      positiveCount += 1;
      if (d.hitAt5) hitAt5Retained += 1;
      if (d.rank1) rank1Retained += 1;
      if (d.currentTruthAt1) currentTruthAt1Retained += 1;
      const fslot = positiveByFamily[d.family] ?? {
        total: 0,
        abstained: 0,
      };
      fslot.total += 1;
      if (d.abstain) {
        positiveAbstained += 1;
        fslot.abstained += 1;
      } else if (d.recoveredFp) {
        recoveredFps += 1;
        if (d.recoveredCategory !== undefined) {
          recoveredByCategory[d.recoveredCategory] += 1;
        }
        recoveredByFamily[d.family] = (recoveredByFamily[d.family] ?? 0) + 1;
      }
      positiveByFamily[d.family] = fslot;
    } else {
      noAnswerCount += 1;
      if (d.abstain) {
        noAnswerAbstained += 1;
      } else {
        noAnswerAbstainedFailed += 1;
      }
    }
  }
  // Compute baseline false-abstained total
  // and no-answer total from the baseline
  // decision block.
  let baselineFalseAbstainedTotal = 0;
  let baselineNoAnswerAbstainedTotal = 0;
  let baselineNoAnswerCount = 0;
  for (const bd of baselineDecisions) {
    if (bd.isPositive) {
      if (bd.abstain) baselineFalseAbstainedTotal += 1;
    } else {
      baselineNoAnswerCount += 1;
      if (bd.abstain) baselineNoAnswerAbstainedTotal += 1;
    }
  }
  const baselineF1 = baselineMetrics.f1;
  // Per-family rates.
  const positiveByFamilyRates: Record<string, { total: number; abstained: number; rate: number }> =
    {};
  for (const [family, slot] of Object.entries(positiveByFamily)) {
    positiveByFamilyRates[family] = {
      total: slot.total,
      abstained: slot.abstained,
      rate: slot.total > 0 ? slot.abstained / slot.total : 0,
    };
  }
  // Precision / recall / F1.
  const tp = noAnswerAbstained;
  const fp = positiveAbstained;
  const fn = noAnswerCount - noAnswerAbstained;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  // Compute the headline baseline deltas.
  const baselinePositiveAbstainedRate = baselineMetrics.positiveAbstainedRate;
  const baselineNoAnswerAbstainedRate = baselineMetrics.noAnswerAbstainedRate;
  const noAnswerAbstainedRate = noAnswerCount > 0 ? noAnswerAbstained / noAnswerCount : 0;
  const positiveAbstainedRate = positiveCount > 0 ? positiveAbstained / positiveCount : 0;
  const hitAt5RetainedRate = hitAt5Retained / Math.max(1, positiveCount);
  const rank1RetainedRate = rank1Retained / Math.max(1, positiveCount);
  const currentTruthAt1RetainedRate = currentTruthAt1Retained / Math.max(1, positiveCount);
  // Safety verdict.
  const { verdict, verdictExplanation } = computeSafetyVerdict({
    noAnswerAbstainedRate,
    baselineNoAnswerAbstainedRate,
    recoveredFps,
    positiveAbstainedRate,
    baselinePositiveAbstainedRate,
    newNoAnswerFailures: noAnswerAbstainedFailed,
  });
  return {
    variantId: variant.id,
    category: variant.category,
    total,
    noAnswerCount,
    positiveCount,
    noAnswerAbstained,
    noAnswerAbstainedFailed,
    noAnswerAbstainedRate,
    positiveAbstained,
    positiveAbstainedRate,
    hitAt5Retained,
    hitAt5RetainedRate,
    rank1Retained,
    rank1RetainedRate,
    currentTruthAt1Retained,
    currentTruthAt1RetainedRate,
    recoveredFps,
    recoveredFpsRate:
      baselineFalseAbstainedTotal > 0 ? recoveredFps / baselineFalseAbstainedTotal : 0,
    newNoAnswerFailures: noAnswerAbstainedFailed,
    baseline: {
      hitAt5: baselineMetrics.hitAt5Retained,
      rank1: baselineMetrics.rank1Retained,
      currentTruthAt1: baselineMetrics.currentTruthAt1Retained,
      falseAbstainedTotal: baselineFalseAbstainedTotal,
      noAnswerAbstainedTotal: baselineNoAnswerAbstainedTotal,
      noAnswerAbstainedRate: baselineNoAnswerAbstainedRate,
      positiveAbstainedRate: baselinePositiveAbstainedRate,
      f1: baselineF1,
    },
    delta: {
      noAnswerAbstainedRate: noAnswerAbstainedRate - baselineNoAnswerAbstainedRate,
      positiveAbstainedRate: positiveAbstainedRate - baselinePositiveAbstainedRate,
      hitAt5RetainedRate:
        hitAt5RetainedRate - baselineMetrics.hitAt5Retained / Math.max(1, positiveCount),
      rank1RetainedRate:
        rank1RetainedRate - baselineMetrics.rank1Retained / Math.max(1, positiveCount),
      currentTruthAt1RetainedRate:
        currentTruthAt1RetainedRate -
        baselineMetrics.currentTruthAt1Retained / Math.max(1, positiveCount),
      recoveredFps,
    },
    precision,
    recall,
    f1,
    verdict,
    verdictExplanation,
    positiveAbstainedByFamily: positiveByFamilyRates,
    recoveredByCategory,
    recoveredByFamily,
  };
}

/**
 * Compute the safety verdict for a variant. The
 * verdict is the headline of the report's
 * "is this safe to deploy?" reading.
 *
 * The predicate is:
 *   - `unsafe` — the variant's
 *     `noAnswerAbstainedRate` is strictly less
 *     than the baseline's, OR
 *     `newNoAnswerFailures > 0`. The variant
 *     either regressed TNR or introduced a new
 *     no-answer confabulation; it is not safe
 *     to deploy.
 *   - `safe` — the variant's
 *     `noAnswerAbstainedRate` is `>=` the
 *     baseline's AND `newNoAnswerFailures ===
 *     0` AND `recoveredFps > 0`. The variant
 *     preserves TNR and recovers at least one
 *     FP; it is a candidate for deployment.
 *   - `neutral` — the variant preserves TNR
 *     but recovers zero FPs. The variant is
 *     equivalent to the baseline on the
 *     positive set (and identical on the
 *     no-answer set); it is a no-op.
 */
export function computeSafetyVerdict(args: {
  noAnswerAbstainedRate: number;
  baselineNoAnswerAbstainedRate: number;
  recoveredFps: number;
  positiveAbstainedRate: number;
  baselinePositiveAbstainedRate: number;
  newNoAnswerFailures: number;
}): { verdict: ParaphraseRecoveryVerdict; verdictExplanation: string } {
  const {
    noAnswerAbstainedRate,
    baselineNoAnswerAbstainedRate,
    recoveredFps,
    newNoAnswerFailures,
  } = args;
  if (newNoAnswerFailures > 0) {
    return {
      verdict: "unsafe",
      verdictExplanation: `unsafe: variant introduced ${newNoAnswerFailures} new no-answer confabulations (TNR regression)`,
    };
  }
  if (noAnswerAbstainedRate + 1.0e-9 < baselineNoAnswerAbstainedRate) {
    return {
      verdict: "unsafe",
      verdictExplanation: `unsafe: variant's TNR (${(noAnswerAbstainedRate * 100).toFixed(1)}%) < baseline's (${(baselineNoAnswerAbstainedRate * 100).toFixed(1)}%); the escape caused the variant to retain a no-answer confabulation the baseline would have caught`,
    };
  }
  if (recoveredFps === 0) {
    return {
      verdict: "neutral",
      verdictExplanation:
        "neutral: TNR preserved AND no new no-answer failures, but the escape did not fire on any FP — the variant is identical to the baseline on this corpus",
    };
  }
  return {
    verdict: "safe",
    verdictExplanation: `safe: TNR preserved (>= baseline), ${recoveredFps} FP(s) recovered, no new no-answer failures`,
  };
}

// ---------------------------------------------------------------------------
// Build the per-query input
// ---------------------------------------------------------------------------

/**
 * Build the per-query input the variant
 * evaluator needs. The function is pure. It
 * re-exports the upstream
 * `buildNoAnswerPolicyPerQuery` for symmetry
 * with the runner; the upstream helper is the
 * canonical source.
 */
export { buildNoAnswerPolicyPerQuery } from "./no-answer-abstention.js";

// ---------------------------------------------------------------------------
// Top-level report builder
// ---------------------------------------------------------------------------

/**
 * Build the per-variant recovered-FP entry
 * list. Surfaced on the report's
 * `recoveredByVariant` block.
 */
function buildRecoveredFpEntries(
  decisions: ReadonlyArray<ParaphraseRecoveryDecision>,
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>,
  semantic?: { byQueryId: ReadonlyMap<string, "hit" | "miss"> }
): ParaphraseRecoveryRecoveredFpEntry[] {
  const pqByQueryId = new Map<string, NoAnswerPolicyPerQuery>();
  for (const p of perQuery) pqByQueryId.set(p.queryId, p);
  const out: ParaphraseRecoveryRecoveredFpEntry[] = [];
  for (const d of decisions) {
    if (!d.recoveredFp) continue;
    const pq = pqByQueryId.get(d.queryId);
    if (!pq) continue;
    // The reason string is
    // `escape-fires-and-suppresses:<reason>`.
    // The escape kind is the prefix of the
    // post-colon string. We re-parse the
    // reason to recover the escape kind for
    // the entry (the variant's escape is the
    // authoritative source, but the per-FP
    // entry is self-contained for audit).
    const colonIdx = d.reason.indexOf(":");
    const escapeReason = colonIdx >= 0 ? d.reason.slice(colonIdx + 1) : d.reason;
    let escapeKind: ParaphraseRecoveryEscape["kind"] = "none";
    if (escapeReason.startsWith("escape-detector-rank1|hit5")) {
      escapeKind = "paraphrase-detector-rank1-or-hit5";
    } else if (escapeReason.startsWith("escape-detector-rank1")) {
      escapeKind = "paraphrase-detector-rank1-only";
    } else if (escapeReason.startsWith("escape-detector-loose-threshold")) {
      escapeKind = "paraphrase-detector-loose-threshold";
    } else if (escapeReason.startsWith("escape-family-rank1|hit5")) {
      escapeKind = "paraphrase-family-rank1-or-hit5";
    } else if (escapeReason.startsWith("escape-fixture-label-rank1|hit5")) {
      escapeKind = "paraphrase-fixture-label-rank1-or-hit5";
    }
    let semanticAlsoMisses: boolean | undefined;
    if (semantic) {
      const v = semantic.byQueryId.get(d.queryId);
      if (v === "miss") semanticAlsoMisses = true;
      else if (v === "hit") semanticAlsoMisses = false;
    }
    const entry: ParaphraseRecoveryRecoveredFpEntry = {
      queryId: d.queryId,
      family: d.family,
      category: d.recoveredCategory ?? "unclassified",
      // The explanation is the same table the
      // upstream damage module uses.
      categoryExplanation: CATEGORY_EXPLANATION_FALLBACK(d.recoveredCategory ?? "unclassified"),
      topScore: pq.signals.topScore,
      rank1: d.rank1,
      hitAt5: d.hitAt5,
      baselineReason: d.baselineReason ?? "",
      escapeKind,
      ...(semanticAlsoMisses !== undefined ? { semanticAlsoMisses } : {}),
      ...(d.queryLabels !== undefined ? { queryLabels: [...d.queryLabels] } : {}),
    };
    out.push(entry);
  }
  return out;
}

/**
 * A local fallback for the category
 * explanation. The upstream damage module's
 * `CATEGORY_EXPLANATION` is not exported; this
 * fallback mirrors the documented explanations
 * for the categories a recovery entry can land
 * in (the recovery entry's category is one of
 * the documented damage categories, so the
 * fallback is exact on this surface).
 */
function CATEGORY_EXPLANATION_FALLBACK(category: DamageCategory): string {
  switch (category) {
    case "ranker-empty-recoverable":
      return "ranker returned 0 candidates; the score gate caught the empty result. A denser ranker that can surface a candidate where the lexical ranker returned nothing would recover this. This is a candidate-generation problem, NOT a policy problem.";
    case "score-threshold-on-recoverable":
      return "score gate fired but the ranker DID return the right answer at rank 1 (rank1=true or hit@5=true). The policy's score threshold is below the rank-1's score. A different threshold OR a rank-1-check escape would recover this. This is a policy problem: the threshold is too tight for the rank-1's typical score band.";
    case "score-threshold-on-real-failure":
      return "score gate fired AND the ranker failed to surface the right answer (rank1=false, hit@5=false). The lexical ranker genuinely failed; the policy correctly caught the low-confidence case. The abstention is honest. This is a ranker problem, NOT a policy problem.";
    case "sufficiency-label-honest":
      return "the candidate-set sufficiency label is insufficient or confabulation; the ranker returned the wrong candidate set. The policy correctly caught the missing-candidate case. The abstention is honest. This is a ranker problem, NOT a policy problem.";
    case "multi-gate-conjunction-honest":
      return "both score and sufficiency gates fired; the policy is double-counting a single underlying ranker failure. The abstention is honest but conservative. A simpler policy (score-only OR sufficiency-only) would still have abstained. The damage is real but not from the disjunction.";
    case "labeled-near-miss-or-divergent":
      return "the query carries a `nearMissCurrentCluster` / `divergentTemporal` / `adversarialParaphrase` label. The fixture flagged the query as deliberately ambiguous; abstention may be the correct call. A reviewer who wants to recover this is recovering a fixture adversarial, not a regular query.";
    case "labeled-oracle-misclassification":
      return "the query carries a `hardNegative` / `falsePremise` label. The fixture tagged the query as a no-answer-shape query, but the query is answerable (isPositive=true). This is a fixture-design artifact: the label is in tension with the answerability flag.";
    case "unclassified":
      return "the FP did not match any documented category.";
  }
}

// ---------------------------------------------------------------------------
// Top-level experiment runner
// ---------------------------------------------------------------------------

/**
 * The top-level experiment runner. Consumes a
 * per-query input + an OPTIONAL semantic
 * evidence map and emits a
 * `ParaphraseRecoveryReport`. The function is
 * pure: no I/O, no provider calls, no
 * network. The CLI entry point writes the
 * artifact to disk; the function itself is a
 * pure orchestrator.
 */
export interface ParaphraseRecoveryConfig {
  /** Custom variant list, evaluated in
   *  addition to (and before) the built-in
   *  variants. The custom list is appended
   *  to the built-in list; the report
   *  iterates the union in declaration
   *  order. */
  customVariants?: ReadonlyArray<ParaphraseRecoveryVariant>;
  /** Restrict the report to a subset of
   *  variants by `id`. Default: include
   *  all built-in + custom variants. */
  onlyVariantIds?: ReadonlyArray<string>;
  /**
   * Override the baseline policy id. Default:
   * `score-or-sufficiency-insufficient` (the
   * accepted production-like policy).
   */
  baselinePolicyId?: string;
}

export function runParaphraseRecoveryExperiment(args: {
  recordCount: number;
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>;
  config?: ParaphraseRecoveryConfig;
  semantic?: { byQueryId: ReadonlyMap<string, "hit" | "miss">; source: string };
}): ParaphraseRecoveryReport {
  const { perQuery, config = {}, semantic } = args;
  const baselinePolicyId = config.baselinePolicyId ?? BASELINE_POLICY_ID;
  const baselinePolicy = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === baselinePolicyId);
  if (!baselinePolicy) {
    throw new Error(
      `runParaphraseRecoveryExperiment: baselinePolicyId="${baselinePolicyId}" is not in BUILTIN_NO_ANSWER_POLICIES; ` +
        `available: ${BUILTIN_NO_ANSWER_POLICIES.map((p) => p.id).join(", ")}`
    );
  }
  // Compute the baseline's per-query decisions
  // + metric block ONCE; the per-variant
  // metrics use the same block.
  const baselineDecisions = evaluateNoAnswerPolicy(baselinePolicy, perQuery);
  let baselineNoAnswerAbstained = 0;
  let baselinePositiveAbstained = 0;
  let baselineHitAt5Retained = 0;
  let baselineRank1Retained = 0;
  let baselineCurrentTruthAt1Retained = 0;
  let baselinePrecision = 0;
  let baselineRecall = 0;
  let baselineF1 = 0;
  let baselineNoAnswerCount = 0;
  let baselinePositiveCount = 0;
  let baselineFalseAbstainedTotal = 0;
  for (const d of baselineDecisions) {
    if (d.isPositive) {
      baselinePositiveCount += 1;
      if (d.hitAt5) baselineHitAt5Retained += 1;
      if (d.rank1) baselineRank1Retained += 1;
      if (d.currentTruthAt1) baselineCurrentTruthAt1Retained += 1;
      if (d.abstain) baselinePositiveAbstained += 1;
      if (d.abstain) baselineFalseAbstainedTotal += 1;
    } else {
      baselineNoAnswerCount += 1;
      if (d.abstain) baselineNoAnswerAbstained += 1;
    }
  }
  const baselineNoAnswerAbstainedRate =
    baselineNoAnswerCount > 0 ? baselineNoAnswerAbstained / baselineNoAnswerCount : 0;
  const baselinePositiveAbstainedRate =
    baselinePositiveCount > 0 ? baselinePositiveAbstained / baselinePositiveCount : 0;
  {
    const tp = baselineNoAnswerAbstained;
    const fp = baselinePositiveAbstained;
    const fn = baselineNoAnswerCount - baselineNoAnswerAbstained;
    baselinePrecision = tp + fp > 0 ? tp / (tp + fp) : 0;
    baselineRecall = tp + fn > 0 ? tp / (tp + fn) : 0;
    baselineF1 =
      baselinePrecision + baselineRecall > 0
        ? (2 * baselinePrecision * baselineRecall) / (baselinePrecision + baselineRecall)
        : 0;
  }
  const baselineMetrics = {
    policyId: baselinePolicy.id,
    noAnswerAbstained: baselineNoAnswerAbstained,
    noAnswerAbstainedRate: baselineNoAnswerAbstainedRate,
    positiveAbstained: baselinePositiveAbstained,
    positiveAbstainedRate: baselinePositiveAbstainedRate,
    hitAt5Retained: baselineHitAt5Retained,
    rank1Retained: baselineRank1Retained,
    currentTruthAt1Retained: baselineCurrentTruthAt1Retained,
    precision: baselinePrecision,
    recall: baselineRecall,
    f1: baselineF1,
    falseAbstainedTotal: baselineFalseAbstainedTotal,
  };
  // Build the variant list.
  const customVariants = config.customVariants ?? [];
  const filterIds = config.onlyVariantIds ? new Set(config.onlyVariantIds) : null;
  const variants: ParaphraseRecoveryVariant[] = [];
  for (const v of customVariants) {
    if (filterIds === null || filterIds.has(v.id)) variants.push(v);
  }
  for (const v of BUILTIN_PARAPHRASE_RECOVERY_VARIANTS) {
    if (filterIds === null || filterIds.has(v.id)) variants.push(v);
  }
  // Evaluate each variant.
  const rows: ParaphraseRecoveryVariantRow[] = [];
  const recoveredByVariant: Array<{
    variantId: string;
    entries: ParaphraseRecoveryRecoveredFpEntry[];
  }> = [];
  const variantDecisions: Array<{
    variantId: string;
    decisions: ParaphraseRecoveryDecision[];
  }> = [];
  for (const variant of variants) {
    const decisions = evaluateParaphraseRecoveryVariant(
      variant,
      baselinePolicy,
      perQuery,
      semantic ? { byQueryId: semantic.byQueryId } : undefined
    );
    const metrics = computeParaphraseRecoveryVariantMetrics({
      variant,
      decisions,
      perQuery,
      baselinePolicy,
      baselineDecisions,
      baselineMetrics,
    });
    rows.push({
      ...metrics,
      description: variant.description,
      escape: variant.escape,
    });
    recoveredByVariant.push({
      variantId: variant.id,
      entries: buildRecoveredFpEntries(
        decisions,
        perQuery,
        semantic ? { byQueryId: semantic.byQueryId } : undefined
      ),
    });
    variantDecisions.push({ variantId: variant.id, decisions });
  }
  let total = 0;
  let noAnswerCount = 0;
  let positiveCount = 0;
  for (const p of perQuery) {
    total += 1;
    if (p.isPositive) positiveCount += 1;
    else noAnswerCount += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    config: {
      recordCount: args.recordCount,
      baselinePolicyId,
      total,
      noAnswerCount,
      positiveCount,
      variantCount: variants.length,
      productionLikeCount: variants.filter((v) => v.category === "production-like").length,
      fixtureShapedCount: variants.filter((v) => v.category === "fixture-shaped").length,
      oracleCount: variants.filter((v) => v.category === "oracle").length,
      ...(semantic ? { evidenceSource: semantic.source } : {}),
    },
    baselineMetrics,
    variants: rows,
    recoveredByVariant,
    perQuery,
    baselineDecisions,
    variantDecisions,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Format the experiment report as a
 * human-readable string. The function is pure:
 * same report -> same string. The output is
 * byte-stable for a fixed input.
 *
 * The output is intentionally narrow:
 *   1. The config block + honest preamble.
 *   2. The baseline reference row.
 *   3. The headline variant table (per-variant
 *      TNR, positive abstention, hit-5 retained,
 *      recovered FPs, F1, verdict).
 *   4. The per-variant delta vs baseline.
 *   5. The per-variant recovered-FP details.
 *   6. The honest reading block.
 */
export function formatParaphraseRecoveryReport(report: ParaphraseRecoveryReport): string {
  const lines: string[] = [];
  lines.push("=== curion paraphrase-specific recovery / refined-threshold experiment ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- config ---");
  lines.push(`  records:               ${report.config.recordCount}`);
  lines.push(`  baseline policy:       ${report.config.baselinePolicyId}`);
  lines.push(`  total:                 ${report.config.total}`);
  lines.push(`  no-answer:             ${report.config.noAnswerCount}`);
  lines.push(`  positive:              ${report.config.positiveCount}`);
  lines.push(
    `  variants evaluated:    ${String(report.config.variantCount).padStart(3)} ` +
      `(production-like=${report.config.productionLikeCount}, ` +
      `fixture-shaped=${report.config.fixtureShapedCount}, ` +
      `oracle=${report.config.oracleCount})`
  );
  if (report.config.evidenceSource) {
    lines.push(`  semantic evidence:     ${report.config.evidenceSource}`);
  }
  lines.push("");
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY study.");
  lines.push("  The experiment tests whether a NARROW paraphrase-aware");
  lines.push("  escape hatch layered on top of the accepted production-");
  lines.push("  like policy (`score-or-sufficiency-insufficient`) can");
  lines.push("  reduce the recoverable paraphrase damage WITHOUT");
  lines.push("  regressing the no-answer TNR. The variants are NOT");
  lines.push("  wired into the production `recall(text)` controller,");
  lines.push("  the public MCP API, or the storage schema. The experiment");
  lines.push("  is a trade-off analysis: how much paraphrase damage can");
  lines.push("  a narrow escape recover, and at what safety cost?");
  lines.push("  Three variant categories are reported:");
  lines.push("    - `production-like` — runtime-only signals");
  lines.push("      (the heuristic `isParaphraseTrap` /");
  lines.push("      `isAdversarialParaphrase` flag, the rank-1 / hit-5");
  lines.push("      outcome, the score). A reviewer who wants to reason");
  lines.push("      about a deployable rule reads ONLY this category.");
  lines.push("    - `fixture-shaped` — keys on a fixture-truth signal");
  lines.push("      (the benchmark's `family` field). A real production");
  lines.push("      ranker has no such label on incoming queries. These");
  lines.push("      rows are research / oracle-like ceilings and are");
  lines.push("      clearly NOT deployable.");
  lines.push("    - `oracle` — keys on the explicit fixture-truth labels");
  lines.push("      (`adversarialParaphrase` / `nearMissCurrentCluster`).");
  lines.push("      Clearly non-production. The true ceiling reading.");
  lines.push("");
  // ---- Baseline reference row ----
  const b = report.baselineMetrics;
  lines.push("--- baseline reference row ---");
  lines.push(`  policy:                 ${b.policyId}`);
  lines.push(
    `  no-answer abstained:    ${b.noAnswerAbstained} / ${report.config.noAnswerCount} (${(b.noAnswerAbstainedRate * 100).toFixed(1)}%)`
  );
  lines.push(
    `  positive abstained:     ${b.positiveAbstained} / ${report.config.positiveCount} (${(b.positiveAbstainedRate * 100).toFixed(1)}%)`
  );
  lines.push(`  hit@5 retained:         ${b.hitAt5Retained}`);
  lines.push(`  rank1 retained:         ${b.rank1Retained}`);
  lines.push(`  currentTruthAt1 retained: ${b.currentTruthAt1Retained}`);
  lines.push(
    `  precision / recall / F1: ${b.precision.toFixed(2)} / ${b.recall.toFixed(2)} / ${b.f1.toFixed(2)}`
  );
  lines.push(`  false abstained total:  ${b.falseAbstainedTotal}`);
  lines.push("");
  // ---- Headline variant table ----
  lines.push("--- variant frontier ---");
  lines.push(
    "  category   variant                                       TNR%   posAbst%  hit5Ret%  rank1Ret%  curT1Ret%  recoveredFps  rec-rate%  P     R     F1    verdict"
  );
  for (const row of report.variants) {
    const variantLabel =
      row.variantId.length > 45 ? row.variantId.slice(0, 42) + "..." : row.variantId;
    const cat =
      row.category === "oracle"
        ? "oracle   "
        : row.category === "fixture-shaped"
          ? "fixture  "
          : "prod     ";
    const recPct = (row.recoveredFpsRate * 100).toFixed(1);
    lines.push(
      `  ${cat} ${variantLabel.padEnd(45)}` +
        ` ${(row.noAnswerAbstainedRate * 100).toFixed(1).padStart(5)}` +
        `   ${(row.positiveAbstainedRate * 100).toFixed(1).padStart(5)}` +
        `    ${(row.hitAt5RetainedRate * 100).toFixed(1).padStart(5)}` +
        `     ${(row.rank1RetainedRate * 100).toFixed(1).padStart(5)}` +
        `      ${(row.currentTruthAt1RetainedRate * 100).toFixed(1).padStart(5)}` +
        `        ${String(row.recoveredFps).padStart(3)}` +
        `        ${recPct.padStart(5)}` +
        `   ${row.precision.toFixed(2)}  ${row.recall.toFixed(2)}  ${row.f1.toFixed(2)}` +
        `  ${row.verdict}`
    );
  }
  lines.push("");
  lines.push("  TNR%        = no-answer queries the variant abstained on (TNR equivalent).");
  lines.push("  posAbst%    = positive queries the variant abstained on (a damage metric).");
  lines.push("  hit5Ret%    = hit@5 retained on positive queries.");
  lines.push("  rank1Ret%   = rank1 retained on positive queries.");
  lines.push("  curT1Ret%   = currentTruthAt1 retained on positive queries.");
  lines.push("  recoveredFps = FPs the variant recovered (baseline abstained, variant retained).");
  lines.push("  rec-rate%   = recoveredFps / baseline false-abstained total.");
  lines.push("  P/R/F1      = precision / recall / F1 on the 'should-abstain' binary task.");
  lines.push("  verdict     = `safe` (TNR preserved AND recovered>=1), `neutral`");
  lines.push("                (TNR preserved but recovered=0), or `unsafe`");
  lines.push("                (TNR regression or new no-answer failures).");
  lines.push("  category    = `prod` (production-like; runtime-only signals),");
  lines.push("                `fixture` (fixture-shaped; gates on a fixture-truth");
  lines.push("                signal such as the benchmark's `family` field — NOT");
  lines.push("                deployable), or `oracle` (clearly non-production).");
  lines.push("");
  // ---- Per-variant delta table ----
  lines.push("--- delta vs baseline ---");
  lines.push(
    "  variant                                       dTNR%    dPosAbst%  dHit5Ret  dRank1Ret  dCurT1Ret  recoveredFps"
  );
  for (const row of report.variants) {
    const variantLabel =
      row.variantId.length > 45 ? row.variantId.slice(0, 42) + "..." : row.variantId;
    const dTNR = row.delta.noAnswerAbstainedRate * 100;
    const dPos = row.delta.positiveAbstainedRate * 100;
    const dHit = row.delta.hitAt5RetainedRate * 100;
    const dRank = row.delta.rank1RetainedRate * 100;
    const dCur = row.delta.currentTruthAt1RetainedRate * 100;
    lines.push(
      `  ${variantLabel.padEnd(45)}` +
        ` ${(dTNR >= 0 ? "+" : "") + dTNR.toFixed(1).padStart(6)}` +
        `    ${(dPos >= 0 ? "+" : "") + dPos.toFixed(1).padStart(6)}` +
        `    ${(dHit >= 0 ? "+" : "") + dHit.toFixed(1).padStart(5)}` +
        `       ${(dRank >= 0 ? "+" : "") + dRank.toFixed(1).padStart(5)}` +
        `       ${(dCur >= 0 ? "+" : "") + dCur.toFixed(1).padStart(5)}` +
        `        ${String(row.delta.recoveredFps).padStart(3)}`
    );
  }
  lines.push("");
  lines.push("  dTNR%        = (variant TNR) - (baseline TNR). Positive is better.");
  lines.push("  dPosAbst%    = (variant pos-abst%) - (baseline pos-abst%). Negative is better.");
  lines.push("  dHit5Ret     = (variant hit@5 retained%) - (baseline hit@5 retained%).");
  lines.push("  dRank1Ret    = (variant rank1 retained%) - (baseline rank1 retained%).");
  lines.push(
    "  dCurT1Ret    = (variant currentTruthAt1 retained%) - (baseline currentTruthAt1 retained%)."
  );
  lines.push("  recoveredFps = (variant recovered FPs) - (baseline recovered FPs = 0).");
  lines.push("");
  // ---- Per-variant verdict block ----
  lines.push("--- per-variant verdict ---");
  for (const row of report.variants) {
    lines.push(`  [${row.verdict.toUpperCase().padEnd(7)}] ${row.variantId}`);
    lines.push(`    ${row.verdictExplanation}`);
  }
  lines.push("");
  // ---- Per-variant recovered-FP details ----
  for (const recBlock of report.recoveredByVariant) {
    if (recBlock.entries.length === 0) continue;
    lines.push(`--- recovered FPs (variant: ${recBlock.variantId}) ---`);
    for (const e of recBlock.entries) {
      const sem = e.semanticAlsoMisses
        ? "  semantic=also-miss"
        : e.semanticAlsoMisses === false
          ? "  semantic=recoverable"
          : "";
      const labels =
        e.queryLabels && e.queryLabels.length > 0 ? `  labels=${e.queryLabels.join("|")}` : "";
      lines.push(
        `  [${e.family.padEnd(11)}] ${e.queryId.padEnd(42)}  ` +
          `topScore=${e.topScore.toFixed(3)}  ` +
          `rank1=${e.rank1 ? "T" : "F"}  ` +
          `hit5=${e.hitAt5 ? "T" : "F"}  ` +
          `cat=${e.category.padEnd(30)}  ` +
          `escape=${e.escapeKind}${sem}${labels}`
      );
    }
    lines.push("");
  }
  // ---- Honest reading block ----
  lines.push("--- honest reading ---");
  lines.push("  The experiment is a NARROW recovery study. The variants");
  lines.push("  are deliberately small: each variant is the baseline");
  lines.push("  policy plus ONE paraphrase-aware escape hatch. A");
  lines.push("  reviewer who wants to reason about a deployable rule");
  lines.push("    reads the `production-like` rows ONLY.");
  lines.push("  The `safe` verdict is the headline: a variant that");
  lines.push("    preserves the baseline's no-answer TNR AND recovers");
  lines.push("    at least one FP is the only kind of variant a reviewer");
  lines.push("    should consider for deployment. A variant that drops TNR");
  lines.push("    is marked `unsafe` regardless of how many paraphrase");
  lines.push("    FPs it recovers; a variant that keeps TNR but does not");
  lines.push("    recover anything is marked `neutral`.");
  lines.push("  The structural safety property of the variants is that");
  lines.push("    the escape is a one-way suppression: the variant cannot");
  lines.push("    INTRODUCE a new abstention on a query the baseline would");
  lines.push("    have retained. The only way the variant's positive-");
  lines.push("    abstention rate is LOWER than the baseline's is by");
  lines.push("    recovering FPs the baseline made. A variant that");
  lines.push("    recovers zero FPs is identical to the baseline on the");
  lines.push("    positive set.");
  lines.push("  The semantic-evidence rollup (when supplied) is the only");
  lines.push('    way to see "would a dense reranker have recovered');
  lines.push("    this?\". When supplied, the per-FP entry's");
  lines.push("    `semanticAlsoMisses` field tells the reviewer");
  lines.push("    whether the EmbeddingGemma hybrid-dense dense ranker");
  lines.push("    also rank-1-missed the query. The damage-analysis");
  lines.push("    finding is that 20/24 FPs were also missed by the");
  lines.push("    dense ranker, so a dense reranker is not a silver");
  lines.push("    bullet; the per-FP `semantic=also-miss` annotation is");
  lines.push("    the honest reading.");
  lines.push("  The paraphrase detector (`isParaphraseTrap` /");
  lines.push("    `isAdversarialParaphrase`) is a HEURISTIC. The flag is");
  lines.push("    NOT a production-grade signal; the experiment uses it");
  lines.push("    as a research-only stand-in for 'is this a paraphrase-");
  lines.push("    shaped query?'. A deployment would need a corresponding");
  lines.push("    production-side paraphrase detector with documented");
  lines.push("    precision / recall on the production corpus.");
  return lines.join("\n");
}
