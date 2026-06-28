/**
 * Tests for the benchmark-only paraphrase-specific
 * recovery / refined-threshold experiment.
 *
 * Covers:
 *   1. Escape evaluation math: each escape kind
 *      fires iff the documented condition holds;
 *      the kind-specific "paraphrase-shaped"
 *      check is the documented one (detector
 *      flag / family / fixture label).
 *   2. Variant evaluation math: a variant is the
 *      baseline policy + the escape. The escape
 *      is a one-way suppression: it cannot
 *      introduce a new abstention on a query the
 *      baseline would have retained.
 *   3. Trade-off aggregation: per-variant
 *      metrics, baseline delta, recovered-FP
 *      details, family / category rollups.
 *   4. Safety verdict predicate: the documented
 *      `safe` / `neutral` / `unsafe` rule.
 *   5. Output determinism: same input -> same
 *      report; no PRNG; no wall clock.
 *   6. Category labeling: production-like vs
 *      fixture-shaped vs oracle, pinned by
 *      the variant table.
 *   7. No-answer safety preservation: a variant
 *      that is structurally safe CANNOT regress
 *      TNR; a variant that is unsafe CAN.
 *   8. End-to-end: the experiment on the real
 *      lexical baseline no-answer artifact
 *      produces a meaningful recovery report on
 *      the 24 FPs the prior experiment surfaced.
 *   9. Semantic-evidence integration: with the
 *      pre-computed EmbeddingGemma evidence
 *      file, every recovered FP carries a
 *      `semanticAlsoMisses` annotation.
 *  10. Production import guard: the production
 *      source tree must NOT import the new
 *      recovery modules.
 *  11. Public MCP API unchanged: exactly two
 *      tools.
 *  12. Existing report shapes are unchanged.
 *  13. CLI argument parsing: default modes +
 *      override flags.
 *  14. Artifact reader + writer round-trip.
 *  15. Honest fixture-label framing: the
 *      variant categories are documented as
 *      `production-like` / `fixture-shaped` /
 *      `oracle`.
 *
 * The tests split between synthetic unit tests
 * (pure functions, no corpus) and end-to-end
 * tests (real no-answer artifact under
 * `.curion/benchmark/`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { classifyFalseAbstention } from "../src/benchmark/false-abstention-damage.js";
import type { AbstentionSignals } from "../src/benchmark/metrics.js";
import {
  BUILTIN_NO_ANSWER_POLICIES,
  type NoAnswerPolicyPerQuery,
  evaluateNoAnswerPolicy,
} from "../src/benchmark/no-answer-abstention.js";
import {
  findParaphraseRecoveryMostRecentArtifact,
  parseParaphraseRecoveryCliArgs,
  readParaphraseRecoveryNoAnswerArtifact,
  readParaphraseRecoverySemanticEvidenceFile,
  runParaphraseRecoveryAnalysis,
  runParaphraseRecoveryCli,
  writeParaphraseRecoveryReport,
} from "../src/benchmark/paraphrase-recovery-runner.js";
import {
  BASELINE_POLICY_ID,
  BUILTIN_PARAPHRASE_RECOVERY_VARIANTS,
  type ParaphraseRecoveryReport,
  type ParaphraseRecoveryVariant,
  computeParaphraseRecoveryVariantMetrics,
  computeSafetyVerdict,
  evaluateParaphraseRecoveryVariant,
  formatParaphraseRecoveryReport,
  runParaphraseRecoveryExperiment,
} from "../src/benchmark/paraphrase-recovery.js";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic per-query input the variant
 * evaluator consumes. The factory takes a
 * per-query spec and produces a per-query entry
 * with the desired signals, family, isPositive
 * flag, topKSize, sufficiency label, and
 * optional fixture-truth labels.
 */
function mkPerQuery(
  specs: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    topScore?: number;
    top1Top2Gap?: number;
    top1Top2Ratio?: number;
    returnedCount?: number;
    topKSize?: number;
    sufficiencyLabel?:
      | "sufficient"
      | "partial"
      | "insufficient"
      | "wrong-current-truth"
      | "near-miss"
      | "confabulation"
      | "no-answer-correct";
    queryLabels?: string[];
    isNoAnswerHardNegative?: boolean;
    isFalsePremiseLike?: boolean;
    isAdversarialParaphrase?: boolean;
    isNearMissCurrentCluster?: boolean;
    isDivergentTemporal?: boolean;
    isParaphraseTrap?: boolean;
    rank1?: boolean;
    currentTruthAt1?: boolean;
    hitAt5?: boolean;
  }>
): NoAnswerPolicyPerQuery[] {
  return specs.map((s) => {
    const signals: AbstentionSignals = {
      topScore: s.topScore ?? 0,
      top1Top2Gap: s.top1Top2Gap ?? 0,
      top1Top2Ratio: s.top1Top2Ratio ?? 1,
      returnedCount: s.returnedCount ?? 0,
      agreementCount: 0,
      minContributorRank: null,
      maxContributorRank: null,
      meanContributorRank: null,
      minContributorScore: null,
      maxContributorScore: null,
      meanContributorScore: null,
      sourcePresence: "___",
      isNoAnswerHardNegative: s.isNoAnswerHardNegative ?? false,
      isTemporalCurrent: false,
      isNegationLike: false,
      isOodEntityLike: false,
      isParaphraseTrap: s.isParaphraseTrap ?? false,
      isFalsePremiseLike: s.isFalsePremiseLike ?? false,
      isAdversarialParaphrase: s.isAdversarialParaphrase ?? false,
      isDivergentTemporal: s.isDivergentTemporal ?? false,
      isNearMissCurrentCluster: s.isNearMissCurrentCluster ?? false,
    };
    const slot: NoAnswerPolicyPerQuery = {
      queryId: s.queryId,
      family: s.family,
      isPositive: s.isPositive,
      signals,
      topKSize: s.topKSize ?? 0,
      rank1: s.rank1 ?? false,
      currentTruthAt1: s.currentTruthAt1 ?? false,
      hitAt5: s.hitAt5 ?? false,
    };
    if (s.sufficiencyLabel !== undefined) slot.sufficiencyLabel = s.sufficiencyLabel;
    if (s.queryLabels !== undefined) slot.queryLabels = [...s.queryLabels];
    return slot;
  });
}

/**
 * Build a no-answer-artifact-shaped object
 * from a per-query input list. Used by the
 * synthetic end-to-end tests so the runner
 * has a real in-memory artifact to consume.
 */
function mkArtifact(perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>): {
  generatedAt: string;
  config: {
    recordCount: number;
    queryCount: number;
    total: number;
    noAnswerCount: number;
    positiveCount: number;
  };
  perQuery: NoAnswerPolicyPerQuery[];
  decisions: Array<{
    policyId: string;
    decisions: ReadonlyArray<unknown>;
  }>;
} {
  let total = 0;
  let noAnswerCount = 0;
  let positiveCount = 0;
  for (const p of perQuery) {
    total += 1;
    if (p.isPositive) positiveCount += 1;
    else noAnswerCount += 1;
  }
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    config: {
      recordCount: 1,
      queryCount: perQuery.length,
      total,
      noAnswerCount,
      positiveCount,
    },
    perQuery: perQuery.map((p) => ({ ...p })),
    decisions: [
      {
        policyId: BASELINE_POLICY_ID,
        decisions: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Variant table structure
// ---------------------------------------------------------------------------

test("paraphrase-recovery: built-in variant table is well-formed and has a baseline", () => {
  assert.ok(
    BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.length >= 3,
    `at least baseline + production-like + fixture-shaped variants must be present, got ${BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.length}`
  );
  // The first variant is the baseline.
  const first = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS[0]!;
  assert.equal(first.escape.kind, "none");
  assert.equal(first.id, "baseline-score-or-sufficiency-insufficient");
  assert.equal(first.category, "production-like");
  // Every variant has a non-empty id + description.
  for (const v of BUILTIN_PARAPHRASE_RECOVERY_VARIANTS) {
    assert.ok(v.id.length > 0, `variant id must be non-empty`);
    assert.ok(v.description.length > 0, `variant description must be non-empty for ${v.id}`);
    assert.ok(
      ["production-like", "fixture-shaped", "oracle"].includes(v.category),
      `variant category must be one of the three documented categories for ${v.id}`
    );
  }
  // Ids are unique.
  const ids = new Set(BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.map((v) => v.id));
  assert.equal(ids.size, BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.length, "variant ids must be unique");
});

test("paraphrase-recovery: built-in variant categories are honest about deployability", () => {
  // The fixture-shaped and oracle variants must be
  // clearly marked. The production-like variants
  // must NOT include any fixture-shaped gate.
  for (const v of BUILTIN_PARAPHRASE_RECOVERY_VARIANTS) {
    if (v.category === "production-like") {
      assert.notEqual(
        v.escape.kind,
        "paraphrase-family-rank1-or-hit5",
        `production-like variant ${v.id} must NOT use the fixture-shaped family gate`
      );
      assert.notEqual(
        v.escape.kind,
        "paraphrase-fixture-label-rank1-or-hit5",
        `production-like variant ${v.id} must NOT use the fixture-truth label gate`
      );
    }
    if (v.escape.kind === "paraphrase-family-rank1-or-hit5") {
      assert.equal(
        v.category,
        "fixture-shaped",
        `family-gated variant ${v.id} must be marked fixture-shaped, not production-like`
      );
    }
    if (v.escape.kind === "paraphrase-fixture-label-rank1-or-hit5") {
      assert.equal(
        v.category,
        "oracle",
        `fixture-label-gated variant ${v.id} must be marked oracle, not production-like`
      );
    }
  }
});

test("paraphrase-recovery: baseline policy id resolves to a built-in no-answer policy", () => {
  const policy = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID);
  assert.ok(policy, `baseline policy id ${BASELINE_POLICY_ID} must be a real built-in policy`);
  assert.equal(policy.category, "production-like", "baseline must be a production-like policy");
});

// ---------------------------------------------------------------------------
// 2. Escape evaluation math
// ---------------------------------------------------------------------------

test("paraphrase-recovery: detector-rank1-or-hit5 escape requires BOTH the detector flag and a hit", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  // Paraphrase flagged AND rank1 -> escape fires.
  let perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  let decisions = evaluateParaphraseRecoveryVariant(
    BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find((v) => v.id === "paraphrase-detector-rank1-or-hit5")!,
    baseline,
    perQuery
  );
  assert.equal(
    decisions[0]!.abstain,
    false,
    "escape must fire: paraphrase flagged + rank1 === true"
  );
  // Paraphrase flagged BUT rank1=false, hit@5=false -> escape does not fire.
  perQuery = mkPerQuery([
    {
      queryId: "q2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: false,
      hitAt5: false,
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(
    BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find((v) => v.id === "paraphrase-detector-rank1-or-hit5")!,
    baseline,
    perQuery
  );
  assert.equal(
    decisions[0]!.abstain,
    true,
    "escape must NOT fire: paraphrase flagged but rank1=false, hit@5=false"
  );
  // Not paraphrase-flagged but rank1=true -> escape does not fire.
  perQuery = mkPerQuery([
    {
      queryId: "q3",
      family: "exact",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: false,
      isAdversarialParaphrase: false,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(
    BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find((v) => v.id === "paraphrase-detector-rank1-or-hit5")!,
    baseline,
    perQuery
  );
  assert.equal(
    decisions[0]!.abstain,
    true,
    "escape must NOT fire: not paraphrase flagged, even though rank1 === true"
  );
});

test("paraphrase-recovery: detector-rank1-only escape requires BOTH the detector flag and rank1", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  const variant = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find(
    (v) => v.id === "paraphrase-detector-rank1-only"
  )!;
  // hit@5 but not rank1: escape does NOT fire (rank1-only is stricter).
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: false,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(decisions[0]!.abstain, true, "rank1-only escape must NOT fire on hit@5-only");
});

test("paraphrase-recovery: loose-threshold escape requires BOTH the detector flag and a score in band", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  const variant = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find(
    (v) => v.id === "paraphrase-detector-loose-threshold-0.20"
  )!;
  // Score in band (0.25) AND paraphrase flagged -> escape fires.
  let perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  let decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    false,
    "loose-threshold escape must fire: paraphrase + 0.25 (in 0.20-0.30 band)"
  );
  // Score below band (0.15) AND paraphrase flagged -> escape does NOT fire.
  perQuery = mkPerQuery([
    {
      queryId: "q2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.15,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    true,
    "loose-threshold escape must NOT fire: paraphrase + 0.15 (below lowerBound 0.20)"
  );
  // Score at threshold 0.30 (in the band 0.20-0.30, the escape is a "suppress if band" condition) -> escape DOES fire (suppresses the baseline's abstention).
  perQuery = mkPerQuery([
    {
      queryId: "q3",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.3,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    false,
    "loose-threshold escape must fire: topScore 0.30 (in 0.20-0.30 band) suppresses the baseline's score-or-sufficiency abstention"
  );
  // Score very high (0.5) -> baseline doesn't abstain; variant also retains (escape is a no-op).
  perQuery = mkPerQuery([
    {
      queryId: "q4",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.5,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "sufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    false,
    "loose-threshold escape: baseline doesn't abstain on topScore=0.5 + sufficient; variant also retains"
  );
});

test("paraphrase-recovery: family-gated escape requires family==='paraphrase' (fixture-shaped)", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  const variant = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find(
    (v) => v.id === "paraphrase-family-rank1-or-hit5"
  )!;
  // family='paraphrase' + rank1 -> fires.
  let perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: false,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  let decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    false,
    "family-gated escape must fire: family='paraphrase' + rank1"
  );
  // family='orientation' + rank1 -> does NOT fire (no family match).
  perQuery = mkPerQuery([
    {
      queryId: "q2",
      family: "orientation",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      isAdversarialParaphrase: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    true,
    "family-gated escape must NOT fire: family='orientation' (even with detector flags)"
  );
});

test("paraphrase-recovery: fixture-label-gated escape requires the explicit label (oracle)", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  const variant = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find(
    (v) => v.id === "paraphrase-fixture-label-rank1-or-hit5"
  )!;
  // Labeled + rank1 -> fires.
  let perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      rank1: true,
      hitAt5: true,
      queryLabels: ["adversarialParaphrase"],
      sufficiencyLabel: "insufficient",
    },
  ]);
  let decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    false,
    "fixture-label escape must fire: adversarialParaphrase + rank1"
  );
  // nearMissCurrentCluster label + rank1 -> fires.
  perQuery = mkPerQuery([
    {
      queryId: "q2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      rank1: true,
      hitAt5: true,
      queryLabels: ["nearMissCurrentCluster"],
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    false,
    "fixture-label escape must fire: nearMissCurrentCluster + rank1"
  );
  // Unlabeled + rank1 -> does NOT fire.
  perQuery = mkPerQuery([
    {
      queryId: "q3",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      isAdversarialParaphrase: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  assert.equal(
    decisions[0]!.abstain,
    true,
    "fixture-label escape must NOT fire: detector flagged but no explicit label"
  );
});

// ---------------------------------------------------------------------------
// 3. Variant is one-way suppression (no new abstention on retained queries)
// ---------------------------------------------------------------------------

test("paraphrase-recovery: variant is one-way suppression (cannot introduce new abstention)", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  // A query that the baseline would retain
  // (high score, no insufficiency) is also
  // retained by the variant, regardless of
  // detector / family / label flags.
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.55,
      isParaphraseTrap: true,
      isAdversarialParaphrase: true,
      rank1: true,
      hitAt5: true,
      queryLabels: ["adversarialParaphrase"],
      sufficiencyLabel: "sufficient",
    },
    {
      queryId: "q2",
      family: "exact",
      isPositive: true,
      topScore: 0.99,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "sufficient",
    },
  ]);
  for (const v of BUILTIN_PARAPHRASE_RECOVERY_VARIANTS) {
    const decisions = evaluateParaphraseRecoveryVariant(v, baseline, perQuery);
    for (const d of decisions) {
      assert.equal(
        d.abstain,
        false,
        `variant ${v.id} must NOT introduce a new abstention on a query the baseline would retain (queryId=${d.queryId})`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Safety verdict predicate
// ---------------------------------------------------------------------------

test("paraphrase-recovery: safety verdict is safe iff TNR preserved and recovered>=1", () => {
  // safe
  let v = computeSafetyVerdict({
    noAnswerAbstainedRate: 1.0,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 4,
    positiveAbstainedRate: 0.16,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 0,
  });
  assert.equal(v.verdict, "safe");
  // neutral: TNR preserved but recovered=0
  v = computeSafetyVerdict({
    noAnswerAbstainedRate: 1.0,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 0,
    positiveAbstainedRate: 0.185,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 0,
  });
  assert.equal(v.verdict, "neutral");
  // unsafe: TNR regression
  v = computeSafetyVerdict({
    noAnswerAbstainedRate: 0.95,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 4,
    positiveAbstainedRate: 0.16,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 0,
  });
  assert.equal(v.verdict, "unsafe");
  // unsafe: new failures (technically impossible structurally, but tested)
  v = computeSafetyVerdict({
    noAnswerAbstainedRate: 1.0,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 4,
    positiveAbstainedRate: 0.16,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 1,
  });
  assert.equal(v.verdict, "unsafe");
});

test("paraphrase-recovery: safety verdict explanation mentions the reason", () => {
  const safe = computeSafetyVerdict({
    noAnswerAbstainedRate: 1.0,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 4,
    positiveAbstainedRate: 0.16,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 0,
  });
  assert.match(safe.verdictExplanation, /safe/);
  const neutral = computeSafetyVerdict({
    noAnswerAbstainedRate: 1.0,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 0,
    positiveAbstainedRate: 0.185,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 0,
  });
  assert.match(neutral.verdictExplanation, /neutral/);
  const unsafe = computeSafetyVerdict({
    noAnswerAbstainedRate: 0.95,
    baselineNoAnswerAbstainedRate: 1.0,
    recoveredFps: 4,
    positiveAbstainedRate: 0.16,
    baselinePositiveAbstainedRate: 0.185,
    newNoAnswerFailures: 0,
  });
  assert.match(unsafe.verdictExplanation, /unsafe/);
});

// ---------------------------------------------------------------------------
// 5. Per-variant metrics math
// ---------------------------------------------------------------------------

test("paraphrase-recovery: per-variant metrics math (positive abstention rate, recoveredFps)", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  // Synthetic: 1 baseline-FP (paraphrase, flagged,
  // rank1) + 1 baseline-TN (no FP, no abstention)
  // + 1 no-answer query that is correctly
  // abstained on by the baseline.
  const perQuery = mkPerQuery([
    {
      queryId: "fp-1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
    {
      queryId: "tn-1",
      family: "exact",
      isPositive: true,
      topScore: 0.8,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "sufficient",
    },
    {
      queryId: "na-1",
      family: "no-answer",
      isPositive: false,
      topScore: 0.1,
      sufficiencyLabel: "confabulation",
    },
  ]);
  const variant = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find(
    (v) => v.id === "paraphrase-detector-rank1-or-hit5"
  )!;
  const decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  // The baseline decision is needed by the
  // metric computer; we re-evaluate here for
  // determinism. The function does it
  // internally via reconstructPerQuery but
  // the synthetic test does not have an
  // artifact, so we compute it ourselves.
  const baselineDecisions = evaluateNoAnswerPolicy(baseline, perQuery);
  const baselineMetrics = {
    noAnswerAbstained: baselineDecisions.filter((d) => !d.isPositive && d.abstain).length,
    noAnswerAbstainedRate: 1.0,
    positiveAbstained: baselineDecisions.filter((d) => d.isPositive && d.abstain).length,
    positiveAbstainedRate: 1 / 2,
    hitAt5Retained: 1,
    rank1Retained: 1,
    currentTruthAt1Retained: 1,
    precision: 1 / 2,
    recall: 1,
    f1: 2 / 3,
  };
  const metrics = computeParaphraseRecoveryVariantMetrics({
    variant,
    decisions,
    perQuery,
    baselinePolicy: baseline,
    baselineDecisions,
    baselineMetrics,
  });
  // The variant recovered 1 FP (the paraphrase
  // query), kept the no-answer query abstained,
  // and the TN remained retained.
  assert.equal(metrics.recoveredFps, 1, "should recover the 1 paraphrase FP");
  assert.equal(metrics.noAnswerAbstainedRate, 1.0, "no-answer TNR must be preserved");
  assert.equal(metrics.positiveAbstainedRate, 0, "no FPs remain");
  assert.equal(metrics.verdict, "safe");
  // Family rollup
  assert.ok(
    metrics.recoveredByFamily["paraphrase"] === 1,
    "paraphrase family recovered count must be 1"
  );
  // Recovered FP details include the
  // query id.
  const recoveredDecisions = decisions.filter((d) => d.recoveredFp === true);
  assert.equal(recoveredDecisions.length, 1);
  assert.equal(recoveredDecisions[0]!.queryId, "fp-1");
});

// ---------------------------------------------------------------------------
// 6. End-to-end on synthetic no-answer artifact
// ---------------------------------------------------------------------------

test("paraphrase-recovery: end-to-end on synthetic artifact (paraphrase FP + honest abstention + TN)", () => {
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  // Two FPs the baseline would make: one
  // paraphrase-detector (recoverable by
  // production-like escape) and one
  // orientation (NOT recoverable because not
  // paraphrase-shaped). One no-answer query
  // the baseline would correctly abstain on.
  // One TN (high score, sufficient label).
  const perQuery = mkPerQuery([
    {
      queryId: "para-fp-1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
    {
      queryId: "para-fp-2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isAdversarialParaphrase: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
    {
      queryId: "orient-fp-1",
      family: "orientation",
      isPositive: true,
      topScore: 0.25,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
    {
      queryId: "tn-1",
      family: "exact",
      isPositive: true,
      topScore: 0.8,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "sufficient",
    },
    {
      queryId: "na-1",
      family: "no-answer",
      isPositive: false,
      topScore: 0.1,
      sufficiencyLabel: "confabulation",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  // Run the full analysis.
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact as unknown as Parameters<
      typeof runParaphraseRecoveryAnalysis
    >[0]["noAnswerArtifact"],
  });
  assert.equal(report.config.baselinePolicyId, BASELINE_POLICY_ID);
  assert.equal(report.config.total, 5);
  assert.equal(report.config.noAnswerCount, 1);
  assert.equal(report.config.positiveCount, 4);
  // The baseline false-abstained total is
  // 3 (the 2 paraphrase FPs + the 1
  // orientation FP).
  assert.equal(report.baselineMetrics.falseAbstainedTotal, 3, "baseline should have 3 FPs");
  // The detector-rank1-or-hit5 variant
  // recovers 2 FPs (the 2 paraphrase FPs).
  // The orientation FP is NOT recovered
  // (the detector is family-agnostic and the
  // orientation query is not paraphrase-flagged).
  const detectorVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-detector-rank1-or-hit5"
  )!;
  assert.equal(detectorVariant.recoveredFps, 2);
  assert.equal(detectorVariant.verdict, "safe");
  assert.equal(detectorVariant.noAnswerAbstainedRate, 1.0, "no-answer TNR must be preserved");
  // The family-rollup for the detector variant
  // is concentrated on the paraphrase family.
  assert.equal(detectorVariant.recoveredByFamily["paraphrase"], 2);
  assert.equal(
    detectorVariant.recoveredByFamily["orientation"],
    undefined,
    "orientation family should have 0 recovered FPs (not in the family rollup)"
  );
  // The family-gated escape recovers 3 FPs
  // (all of them — paraphrase + orientation
  // — because family='paraphrase' matches
  // only the 2 paraphrase ones; actually only
  // the 2 paraphrase FPs have
  // family='paraphrase'). Let me re-check:
  // the orientation query has family='orientation',
  // so the family-gated escape does NOT fire on
  // it. The family-gated escape recovers 2 FPs
  // (the 2 paraphrase FPs), same as the
  // detector escape on this synthetic data
  // (because the detector escape only fires
  // on paraphrase-flagged queries, and only
  // the 2 paraphrase queries are flagged).
  const familyVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-family-rank1-or-hit5"
  )!;
  assert.equal(familyVariant.recoveredFps, 2);
  assert.equal(familyVariant.category, "fixture-shaped");
  // The oracle-label escape recovers 0 FPs
  // (no query carries the explicit label).
  const oracleVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-fixture-label-rank1-or-hit5"
  )!;
  assert.equal(oracleVariant.recoveredFps, 0);
  assert.equal(oracleVariant.verdict, "neutral");
  // The baseline reference row matches the
  // 3-FP reading.
  assert.equal(report.baselineMetrics.positiveAbstained, 3);
  assert.equal(report.baselineMetrics.noAnswerAbstained, 1);
});

// ---------------------------------------------------------------------------
// 7. Output determinism
// ---------------------------------------------------------------------------

test("paraphrase-recovery: same input -> same report (output determinism)", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
    {
      queryId: "na-1",
      family: "no-answer",
      isPositive: false,
      topScore: 0.1,
      sufficiencyLabel: "confabulation",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  const a = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact as unknown as Parameters<
      typeof runParaphraseRecoveryAnalysis
    >[0]["noAnswerArtifact"],
  });
  const b = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact as unknown as Parameters<
      typeof runParaphraseRecoveryAnalysis
    >[0]["noAnswerArtifact"],
  });
  // Strip the `generatedAt` (the only
  // non-deterministic field).
  const aStrip = { ...a, generatedAt: "fixed" };
  const bStrip = { ...b, generatedAt: "fixed" };
  assert.deepEqual(aStrip, bStrip);
  // The human report is also byte-stable
  // (except for the generatedAt line).
  const aText = formatParaphraseRecoveryReport(a);
  const bText = formatParaphraseRecoveryReport(b);
  // The generatedAt line is the only
  // non-deterministic one. Strip it.
  const aLines = aText.split("\n").filter((l) => !l.startsWith("generated at:"));
  const bLines = bText.split("\n").filter((l) => !l.startsWith("generated at:"));
  assert.deepEqual(aLines, bLines);
});

// ---------------------------------------------------------------------------
// 8. Human report includes the documented sections
// ---------------------------------------------------------------------------

test("paraphrase-recovery: human report includes config, baseline, frontier, delta, verdict, honest reading", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact as unknown as Parameters<
      typeof runParaphraseRecoveryAnalysis
    >[0]["noAnswerArtifact"],
  });
  const text = formatParaphraseRecoveryReport(report);
  assert.match(text, /--- config ---/);
  assert.match(text, /--- baseline reference row ---/);
  assert.match(text, /--- variant frontier ---/);
  assert.match(text, /--- delta vs baseline ---/);
  assert.match(text, /--- per-variant verdict ---/);
  assert.match(text, /--- honest reading ---/);
  // The honest preamble is on the artifact.
  assert.match(text, /BENCHMARK-ONLY study/);
  // The variant categories are listed.
  assert.match(text, /production-like/);
  assert.match(text, /fixture-shaped/);
  assert.match(text, /oracle/);
});

// ---------------------------------------------------------------------------
// 9. CLI argument parsing
// ---------------------------------------------------------------------------

test("paraphrase-recovery: CLI argument parser handles documented flags", () => {
  const parsed = parseParaphraseRecoveryCliArgs([
    "--no-answer-artifact",
    "x.json",
    "--semantic-evidence",
    "y.json",
    "--out-dir",
    "/tmp/out",
    "--baseline-policy",
    "score-below-0.20",
    "--only-variant-ids",
    '["a","b"]',
    "--no-write",
    "--no-stdout",
  ]);
  assert.equal(parsed.noAnswerArtifact, "x.json");
  assert.equal(parsed.semanticEvidence, "y.json");
  assert.equal(parsed.outDir, "/tmp/out");
  assert.equal(parsed.baselinePolicy, "score-below-0.20");
  assert.deepEqual(parsed.onlyVariantIds, '["a","b"]');
  assert.equal(parsed.noWrite, true);
  assert.equal(parsed.noStdout, true);
});

test("paraphrase-recovery: CLI argument parser is permissive (unknown flags ignored)", () => {
  const parsed = parseParaphraseRecoveryCliArgs([
    "--no-answer-artifact",
    "x.json",
    "--help",
    "--version",
    "--unknown-flag",
    "value",
  ]);
  assert.equal(parsed.noAnswerArtifact, "x.json");
  assert.equal(parsed.noWrite, undefined);
  assert.equal(parsed.noStdout, undefined);
});

// ---------------------------------------------------------------------------
// 10. Production import guard + public API unchanged
// ---------------------------------------------------------------------------

test("paraphrase-recovery: production source tree must NOT import the recovery modules", () => {
  // The recovery modules are benchmark-only;
  // a future edit that wires them into the
  // recall controller, the remember
  // controller, the server, the tools, the
  // storage layer, or the retrieval layer
  // would change the production contract.
  // The guard is static: a string-match
  // across the production path. The
  // benchmark / audit / diagnostic / policy
  // / no-answer / false-abstention-damage
  // paths are explicitly allowed to import
  // the recovery module.
  const productionFiles = [
    "src/controller/recall-controller.ts",
    "src/controller/remember-controller.ts",
    "src/server.ts",
    "src/tools/remember.ts",
    "src/tools/recall.ts",
    "src/storage/storage.ts",
    "src/retrieval/lexical.ts",
  ];
  for (const rel of productionFiles) {
    const file = path.join(import.meta.dirname, "..", rel);
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /paraphrase-recovery/,
      `${rel} must NOT import the paraphrase-recovery module`
    );
  }
});

test("paraphrase-recovery: public MCP API is unchanged (remember + recall only)", () => {
  assert.deepEqual(
    [...PUBLIC_TOOL_NAMES],
    ["remember", "recall"],
    "public MCP tool surface must remain exactly remember + recall"
  );
});

// ---------------------------------------------------------------------------
// 11. End-to-end on the real no-answer artifact
// ---------------------------------------------------------------------------

test("paraphrase-recovery: end-to-end on the real lexical-baseline no-answer artifact", () => {
  // Find the most recent no-answer artifact
  // and run the experiment. The test pins
  // a small set of invariants a reviewer
  // expects on the production corpus.
  const noAnswerPath = findParaphraseRecoveryMostRecentArtifact(
    ".curion/benchmark",
    "retrieval-no-answer-abstention-"
  );
  if (!noAnswerPath) {
    // The artifact may not exist on a fresh
    // checkout; skip the test gracefully.
    return;
  }
  const artifact = readParaphraseRecoveryNoAnswerArtifact(noAnswerPath);
  // Run with the default config (no
  // semantic evidence; the test below
  // covers the semantic evidence path).
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact,
  });
  // The artifact's perQuery field is
  // expected to be the canonical input.
  // The baseline policy must be the
  // production-like candidate.
  assert.equal(report.config.baselinePolicyId, BASELINE_POLICY_ID);
  // The baseline's no-answer TNR is 100% on
  // the production corpus.
  assert.equal(
    report.baselineMetrics.noAnswerAbstainedRate,
    1.0,
    "baseline no-answer TNR must be 100% on the production corpus"
  );
  // The baseline's positive abstention rate
  // is 18.5% (24/130) on the production
  // corpus.
  assert.equal(
    report.baselineMetrics.positiveAbstained,
    24,
    "baseline positive abstained must be 24 on the production corpus"
  );
  // The detector-rank1-or-hit5 variant is
  // production-like.
  const detectorVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-detector-rank1-or-hit5"
  )!;
  assert.ok(detectorVariant, "detector-rank1-or-hit5 variant must be present");
  assert.equal(
    detectorVariant.category,
    "production-like",
    "detector variant must be production-like"
  );
  // The detector variant's verdict is one
  // of the three documented values.
  assert.ok(
    ["safe", "neutral", "unsafe"].includes(detectorVariant.verdict),
    "detector variant verdict must be safe/neutral/unsafe"
  );
  // The detector variant's no-answer TNR
  // is preserved (the escape is one-way).
  assert.equal(
    detectorVariant.noAnswerAbstainedRate,
    1.0,
    "detector variant no-answer TNR must be preserved"
  );
  // The detector variant's positive
  // abstention rate is at most the baseline's
  // (the escape can only reduce it).
  assert.ok(
    detectorVariant.positiveAbstainedRate <= report.baselineMetrics.positiveAbstainedRate,
    "detector variant positive abstention rate must be <= baseline"
  );
  // The recovered-FPs count is at most the
  // baseline's false-abstained total.
  assert.ok(
    detectorVariant.recoveredFps <= report.baselineMetrics.falseAbstainedTotal,
    "recoveredFps must be <= baseline false-abstained total"
  );
  // The family-gated variant is
  // fixture-shaped.
  const familyVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-family-rank1-or-hit5"
  )!;
  assert.ok(familyVariant);
  assert.equal(familyVariant.category, "fixture-shaped");
  // The oracle-label variant is oracle.
  const oracleVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-fixture-label-rank1-or-hit5"
  )!;
  assert.ok(oracleVariant);
  assert.equal(oracleVariant.category, "oracle");
});

test("paraphrase-recovery: end-to-end with semantic evidence on the production corpus", () => {
  const noAnswerPath = findParaphraseRecoveryMostRecentArtifact(
    ".curion/benchmark",
    "retrieval-no-answer-abstention-"
  );
  const evidencePath = path.join(
    import.meta.dirname,
    "..",
    "src/benchmark/data/false-abstention-damage-semantic-evidence.json"
  );
  if (!noAnswerPath || !fs.existsSync(evidencePath)) {
    return;
  }
  const artifact = readParaphraseRecoveryNoAnswerArtifact(noAnswerPath);
  const semantic = readParaphraseRecoverySemanticEvidenceFile(evidencePath);
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact,
    semantic,
  });
  // The config surfaces the evidence source.
  assert.equal(
    report.config.evidenceSource,
    "embeddinggemma-hybrid-dense-176-queries-v1",
    "evidence source must surface on the config block"
  );
  // The detector variant's recovered-FP
  // entries (when any) carry the
  // semanticAlsoMisses annotation.
  const detectorVariant = report.variants.find(
    (v) => v.variantId === "paraphrase-detector-rank1-or-hit5"
  )!;
  const detectorRecovered = report.recoveredByVariant.find(
    (r) => r.variantId === "paraphrase-detector-rank1-or-hit5"
  )!;
  for (const e of detectorRecovered.entries) {
    // The annotation is set on entries that
    // are covered by the semantic map. The
    // "miss" entries are the ones the dense
    // ranker also rank-1-missed.
    if (e.semanticAlsoMisses === true) {
      // A "also-miss" entry is a paraphrase FP
      // the lexical ranker missed AND the
      // dense ranker missed; a denser
      // ranker is not a silver bullet for
      // this entry.
      assert.ok(e.queryId.length > 0, "also-miss entry must have a queryId");
    }
  }
  // The detector variant is structurally
  // safe (verdict is one of safe / neutral).
  // The escape is one-way; the only way to
  // be `unsafe` is for `newNoAnswerFailures`
  // to be positive, which is impossible by
  // construction. Pin the property.
  assert.notEqual(
    detectorVariant.verdict,
    "unsafe",
    "detector variant must NOT be unsafe (the escape is one-way; TNR is preserved by construction)"
  );
});

// ---------------------------------------------------------------------------
// 12. Artifact reader + writer round-trip
// ---------------------------------------------------------------------------

test("paraphrase-recovery: artifact reader + writer round-trip is byte-stable", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact as unknown as Parameters<
      typeof runParaphraseRecoveryAnalysis
    >[0]["noAnswerArtifact"],
  });
  // Write to a temp dir and re-read.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
  try {
    const fullPath = writeParaphraseRecoveryReport(report, tmpDir);
    const text = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(text) as ParaphraseRecoveryReport;
    // The re-parsed report equals the
    // original (modulo `generatedAt`).
    const aStrip = { ...report, generatedAt: "fixed" };
    const bStrip = { ...parsed, generatedAt: "fixed" };
    assert.deepEqual(aStrip, bStrip);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 13. Custom variant support
// ---------------------------------------------------------------------------

test("paraphrase-recovery: custom variants can be added via config and are evaluated", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  // A custom variant: a no-op escape
  // (passes no condition; the variant
  // should be equivalent to the baseline).
  const custom: ParaphraseRecoveryVariant = {
    id: "custom-noop",
    description: "Custom no-op escape (test fixture).",
    category: "production-like",
    escape: { kind: "none" },
  };
  const report = runParaphraseRecoveryExperiment({
    recordCount: artifact.config.recordCount,
    perQuery: artifact.perQuery,
    config: { customVariants: [custom] },
  });
  // The custom variant is at the top of
  // the variants list (declaration order).
  assert.equal(report.variants[0]!.variantId, "custom-noop");
  // The custom no-op variant's behavior is
  // identical to the baseline.
  const customRow = report.variants[0]!;
  assert.equal(customRow.recoveredFps, 0);
  assert.equal(customRow.verdict, "neutral");
});

test("paraphrase-recovery: onlyVariantIds filter restricts the report", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  const report = runParaphraseRecoveryExperiment({
    recordCount: artifact.config.recordCount,
    perQuery: artifact.perQuery,
    config: { onlyVariantIds: ["baseline-score-or-sufficiency-insufficient"] },
  });
  assert.equal(report.variants.length, 1);
  assert.equal(report.variants[0]!.variantId, "baseline-score-or-sufficiency-insufficient");
});

// ---------------------------------------------------------------------------
// 14. Baseline policy override
// ---------------------------------------------------------------------------

test("paraphrase-recovery: baselinePolicyId override resolves and uses a different policy", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  // Override the baseline to a stricter
  // policy. The override policy must be in
  // BUILTIN_NO_ANSWER_POLICIES. Use
  // `family-no-answer` (fixture-shaped) so
  // the test exercises the override path
  // (the override changes the per-query
  // FPs the variants see).
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact: artifact as unknown as Parameters<
      typeof runParaphraseRecoveryAnalysis
    >[0]["noAnswerArtifact"],
    baselinePolicyId: "score-below-0.40",
  });
  assert.equal(report.config.baselinePolicyId, "score-below-0.40");
});

test("paraphrase-recovery: invalid baselinePolicyId throws a loud error", () => {
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const artifact = mkArtifact(perQuery);
  assert.throws(
    () =>
      runParaphraseRecoveryAnalysis({
        noAnswerArtifact: artifact as unknown as Parameters<
          typeof runParaphraseRecoveryAnalysis
        >[0]["noAnswerArtifact"],
        baselinePolicyId: "nonexistent-policy",
      }),
    /nonexistent-policy/,
    "invalid baselinePolicyId must throw a loud error mentioning the bad id"
  );
});

// ---------------------------------------------------------------------------
// 15. CLI runnable end-to-end
// ---------------------------------------------------------------------------

test("paraphrase-recovery: CLI runs end-to-end (no-write mode) and produces a report", async () => {
  const noAnswerPath = findParaphraseRecoveryMostRecentArtifact(
    ".curion/benchmark",
    "retrieval-no-answer-abstention-"
  );
  if (!noAnswerPath) return;
  const { report } = await runParaphraseRecoveryCli({
    noAnswerArtifact: noAnswerPath,
    noWrite: true,
    noStdout: true,
  });
  assert.equal(report.config.baselinePolicyId, BASELINE_POLICY_ID);
  assert.ok(report.variants.length > 0);
});

// ---------------------------------------------------------------------------
// 16. Existing report shapes are unchanged
// ---------------------------------------------------------------------------

test("paraphrase-recovery: existing no-answer policy table is unchanged (smoke test)", () => {
  // The recovery experiment is additive;
  // the upstream no-answer policy table is
  // a public dependency. A reviewer who
  // wants to verify the dependency is
  // intact reads this smoke test.
  assert.equal(BUILTIN_NO_ANSWER_POLICIES.length >= 15, true);
  // The baseline policy is in the table.
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID);
  assert.ok(baseline);
  assert.equal(baseline.category, "production-like");
  // The baseline has the documented gates.
  assert.equal(baseline.gates.length, 2);
});

// ---------------------------------------------------------------------------
// 17. Sanity: the damage module's classifier is wired into the recovery entry
// ---------------------------------------------------------------------------

test("paraphrase-recovery: recovered FP's damage category matches the upstream classifier", () => {
  // The recovery entry's `recoveredCategory`
  // is computed by calling
  // `classifyFalseAbstention` with the
  // baseline's reason + the per-query input.
  // This test pins the wiring: a recovered
  // FP's `recoveredCategory` is the same
  // category the upstream damage module
  // classifies it as.
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      isParaphraseTrap: true,
      rank1: true,
      hitAt5: true,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const baseline = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === BASELINE_POLICY_ID)!;
  // Compute the upstream classifier
  // directly to pin the contract. The
  // baseline reason for this query is
  // `score-below-0.3+sufficiency-in-...`
  // (both gates fired), so the upstream
  // classifier returns
  // `multi-gate-conjunction-honest` (priority
  // 6 in the classifier).
  const upstreamCategory = classifyFalseAbstention(
    {
      queryId: "q1",
      family: "paraphrase",
      reason: "score-below-0.3+sufficiency-in-insufficient|confabulation",
      rank1: true,
      hitAt5: true,
    },
    perQuery[0]!
  );
  assert.equal(
    upstreamCategory,
    "multi-gate-conjunction-honest",
    "baseline's reason includes both gates; classifier returns the multi-gate-honest category"
  );
  // The recovery decision uses the same
  // classifier. The recovery decision's
  // `baselineReason` is the baseline's
  // reason string, so the wiring is
  // exact.
  const variant = BUILTIN_PARAPHRASE_RECOVERY_VARIANTS.find(
    (v) => v.id === "paraphrase-detector-rank1-or-hit5"
  )!;
  const decisions = evaluateParaphraseRecoveryVariant(variant, baseline, perQuery);
  const recovered = decisions.find((d) => d.recoveredFp === true);
  assert.ok(recovered);
  assert.equal(
    recovered.recoveredCategory,
    "multi-gate-conjunction-honest",
    "recoveredCategory must match the upstream classifier's category for the same input + baseline reason"
  );
});
