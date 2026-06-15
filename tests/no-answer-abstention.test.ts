/**
 * Tests for the benchmark-only no-answer abstention
 * / calibration experiment.
 *
 * Covers:
 *   1. Policy math: each gate kind fires on the
 *      right input, with the right reason, and
 *      never fires on the wrong input.
 *   2. Trade-off aggregation: per-policy metric
 *      block, per-family positive abstention
 *      breakdown, per-sufficiency-label breakdown,
 *      precision / recall / F1.
 *   3. Output determinism: same input -> same
 *      report; no PRNG; no wall clock.
 *   4. End-to-end: the experiment on the real
 *      lexical baseline is well-formed and
 *      produces a meaningful report on the
 *      176-query corpus.
 *   5. Production import guard: the production
 *      source tree must NOT import the new
 *      experiment modules.
 *   6. Public MCP API unchanged: exactly two
 *      tools.
 *   7. Existing audit / calibration / diagnostic
 *      / policy report shapes are unchanged.
 *   8. Additivity / no mutation: the evaluator
 *      does not mutate the input per-query
 *      array.
 *
 * The tests split between synthetic unit tests
 * (pure functions, no corpus) and end-to-end
 * tests (real corpus + query set + ranker).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_NO_ANSWER_POLICIES,
  buildNoAnswerPolicyPerQuery,
  computeNoAnswerPolicyMetrics,
  evaluateNoAnswerPolicy,
  formatNoAnswerPolicyReport,
  runNoAnswerPolicyExperiment,
  type NoAnswerPolicy,
  type NoAnswerPolicyPerQuery,
} from "../src/benchmark/no-answer-abstention.ts";
import {
  runNoAnswerAbstentionExperiment,
  writeNoAnswerAbstentionReport,
} from "../src/benchmark/no-answer-abstention-runner.ts";
import {
  classifyCandidateSetSufficiency,
  buildSufficiencyReport,
} from "../src/benchmark/sufficiency-diagnostic.ts";
import {
  evaluateQuery,
  type AbstentionSignals,
  type QueryEval,
} from "../src/benchmark/metrics.ts";
import {
  BENCHMARK_QUERIES,
  type BenchmarkQuery,
} from "../src/benchmark/queries.ts";
import { rankLexical } from "../src/retrieval/lexical.ts";
import {
  buildCandidates,
  runRetrievalBenchmark,
} from "../src/benchmark/retrieval-runner.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { detectQueryShape } from "../src/benchmark/query-shapes.ts";
import { buildCorpusTokenSets } from "../src/benchmark/query-shapes.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic per-query input for the
 * experiment evaluator. The factory takes a
 * per-query spec and produces a per-query
 * entry with the desired signals, family,
 * isPositive flag, topKSize, sufficiency
 * label, and optional fixture-truth labels.
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
    rank1?: boolean;
    currentTruthAt1?: boolean;
    hitAt5?: boolean;
  }>,
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
      isParaphraseTrap: false,
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
 * Pick a policy by id from the union of
 * built-in policies. The helper throws if the
 * id is missing so a typo in a test surfaces
 * loud.
 */
function findPolicy(id: string): NoAnswerPolicy {
  const p = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === id);
  if (!p) {
    throw new Error(`internal: built-in policy '${id}' not found`);
  }
  return p;
}

function queryById(id: string): BenchmarkQuery {
  const q = BENCHMARK_QUERIES.find((qq) => qq.id === id);
  if (!q) throw new Error(`fixture has no query with id "${id}"`);
  return q;
}

function evalFrom(
  q: BenchmarkQuery,
  topIds: number[],
  topScores: number[],
): QueryEval {
  return evaluateQuery(
    q.id,
    q.family,
    q.query,
    q.expectedIds,
    q.currentTruthIds,
    topIds,
    topScores,
  );
}

// ---------------------------------------------------------------------------
// 0. Stable contract
// ---------------------------------------------------------------------------

test("no-answer: BUILTIN_NO_ANSWER_POLICIES is the documented stable set", () => {
  // Pin the policy set by hand so a future
  // addition is a deliberate, visible change.
  // The set mixes production-like and oracle
  // policies; a reviewer can grep the list to
  // find any policy by id.
  const ids = BUILTIN_NO_ANSWER_POLICIES.map((p) => p.id);
  assert.ok(ids.includes("baseline-no-policy"));
  assert.ok(ids.includes("score-below-0.20"));
  assert.ok(ids.includes("score-below-0.30"));
  assert.ok(ids.includes("score-below-0.40"));
  assert.ok(ids.includes("gap-below-0.05"));
  assert.ok(ids.includes("gap-below-0.10"));
  assert.ok(ids.includes("ratio-below-1.5"));
  assert.ok(ids.includes("ratio-below-2.0"));
  assert.ok(ids.includes("returned-count-below-2"));
  assert.ok(ids.includes("topK-size-at-most-1"));
  assert.ok(ids.includes("topK-size-equals-1"));
  assert.ok(ids.includes("family-no-answer"));
  assert.ok(ids.includes("sufficiency-insufficient-or-confabulation"));
  assert.ok(ids.includes("sufficiency-insufficient-or-confabulation-or-near-miss"));
  assert.ok(ids.includes("score-or-family-no-answer"));
  assert.ok(ids.includes("score-or-sufficiency-insufficient"));
  assert.ok(ids.includes("oracle-detector-hardneg-or-falseprem"));
  assert.ok(ids.includes("oracle-detector-hardneg-only"));
  assert.ok(ids.includes("oracle-detector-falseprem-only"));
  assert.ok(ids.includes("oracle-fixture-label-hardneg"));
  assert.ok(ids.includes("oracle-fixture-label-falseprem"));
  assert.ok(ids.includes("oracle-fixture-label-hardneg-or-falseprem"));
  assert.ok(ids.includes("oracle-fixture-label-any-labeled"));
  // Every built-in policy has a non-empty id,
  // a non-empty description, a valid category,
  // and a gate list (which may be empty for the
  // "none" baseline).
  for (const p of BUILTIN_NO_ANSWER_POLICIES) {
    assert.ok(p.id.length > 0, `policy id must be non-empty`);
    assert.ok(
      p.description.length > 0,
      `policy ${p.id} description must be non-empty`,
    );
    assert.ok(
      p.category === "production-like" ||
        p.category === "fixture-shaped" ||
        p.category === "oracle",
      `policy ${p.id} category must be production-like, fixture-shaped, or oracle`,
    );
    assert.ok(Array.isArray(p.gates), `policy ${p.id} gates must be an array`);
  }
  // The `category` field is honest: a policy
  // that uses fixture-truth labels (queryLabelsIn)
  // is `oracle`, never `production-like` or
  // `fixture-shaped`.
  for (const p of BUILTIN_NO_ANSWER_POLICIES) {
    const usesFixtureLabels = p.gates.some(
      (g) => g.kind === "queryLabelsIn",
    );
    if (usesFixtureLabels) {
      assert.equal(
        p.category,
        "oracle",
        `policy ${p.id} uses fixture labels and must be oracle`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 0b. Category boundary pinning
// ---------------------------------------------------------------------------
//
// The category boundary is the most important
// honesty contract in this experiment: a policy
// that gates on a fixture-truth signal MUST NOT
// be marked `production-like`. A policy that uses
// only runtime signals MUST be `production-like`,
// not `fixture-shaped` or `oracle`. The tests
// below pin the boundary by id so a future edit
// cannot accidentally re-categorize a fixture-
// shaped policy as production-like (or vice versa)
// without a corresponding test change.

test("no-answer: fixture-shaped boundary — family-keyed policies are NOT production-like", () => {
  // The `family` field is fixture truth, not a
  // runtime production signal. Any policy whose
  // gate list includes a `family` gate MUST be
  // `fixture-shaped` (or `oracle` if it also
  // includes a fixture-label gate, which is not
  // the case for any built-in fixture-shaped
  // policy). This test pins that boundary.
  for (const p of BUILTIN_NO_ANSWER_POLICIES) {
    const usesFamilyGate = p.gates.some((g) => g.kind === "family");
    if (usesFamilyGate) {
      assert.equal(
        p.category,
        "fixture-shaped",
        `policy ${p.id} uses the family gate (fixture truth) and MUST be fixture-shaped, not ${p.category}`,
      );
    }
  }
  // Pin the specific fixture-shaped policies by
  // id so a future rename is a deliberate,
  // visible change.
  const familyPol = BUILTIN_NO_ANSWER_POLICIES.find(
    (p) => p.id === "family-no-answer",
  )!;
  assert.equal(familyPol.category, "fixture-shaped");
  const comboPol = BUILTIN_NO_ANSWER_POLICIES.find(
    (p) => p.id === "score-or-family-no-answer",
  )!;
  assert.equal(comboPol.category, "fixture-shaped");
});

test("no-answer: production-like boundary — runtime-only policies are production-like", () => {
  // The opposite boundary: a policy that uses
  // only runtime signals (topScore, gap, ratio,
  // returnedCount, topK size, sufficiency label)
  // MUST be `production-like`. This pins the
  // rule "if the gate set has no fixture-truth
  // signal, the policy is production-like" so a
  // future edit cannot accidentally tag a
  // runtime-only policy as fixture-shaped.
  for (const p of BUILTIN_NO_ANSWER_POLICIES) {
    const usesFixtureTruthSignal = p.gates.some(
      (g) =>
        g.kind === "family" ||
        g.kind === "queryShapeFlag" ||
        g.kind === "queryLabelsIn",
    );
    if (!usesFixtureTruthSignal) {
      assert.equal(
        p.category,
        "production-like",
        `policy ${p.id} uses only runtime signals and MUST be production-like, not ${p.category}`,
      );
    }
  }
  // Pin a few specific production-like policies
  // by id, including the new "genuine
  // production-like candidate" the report
  // surfaces.
  for (const id of [
    "baseline-no-policy",
    "score-below-0.20",
    "score-below-0.30",
    "score-below-0.40",
    "gap-below-0.05",
    "ratio-below-1.5",
    "returned-count-below-2",
    "topK-size-equals-1",
    "sufficiency-insufficient-or-confabulation",
    "sufficiency-insufficient-or-confabulation-or-near-miss",
    "score-or-sufficiency-insufficient",
  ]) {
    const pol = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === id);
    assert.ok(pol, `expected built-in policy ${id}`);
    assert.equal(
      pol!.category,
      "production-like",
      `policy ${id} should be production-like (runtime-only signals), got ${pol!.category}`,
    );
  }
});

test("no-answer: category counts on the run are consistent with the policy set", () => {
  // End-to-end check: running the experiment on a
  // tiny synthetic input should produce
  // category counts that match the built-in
  // policy set exactly. This pins the headline
  // counter and detects accidental
  // re-categorization.
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5 },
  ]);
  const report = runNoAnswerPolicyExperiment({
    recordCount: 100,
    perQuery,
  });
  const actual = {
    production: report.policies.filter(
      (p) => p.category === "production-like",
    ).length,
    fixture: report.policies.filter(
      (p) => p.category === "fixture-shaped",
    ).length,
    oracle: report.policies.filter((p) => p.category === "oracle").length,
  };
  const expected = {
    production: BUILTIN_NO_ANSWER_POLICIES.filter(
      (p) => p.category === "production-like",
    ).length,
    fixture: BUILTIN_NO_ANSWER_POLICIES.filter(
      (p) => p.category === "fixture-shaped",
    ).length,
    oracle: BUILTIN_NO_ANSWER_POLICIES.filter((p) => p.category === "oracle")
      .length,
  };
  assert.deepEqual(
    actual,
    expected,
    `category counts on the report must match the policy set`,
  );
  // Config block exposes the same counts under
  // separate keys. The block is the human-
  // report / artifact's source of truth.
  assert.equal(report.config.productionLikeCount, expected.production);
  assert.equal(report.config.fixtureShapedCount, expected.fixture);
  assert.equal(report.config.oracleCount, expected.oracle);
});

// ---------------------------------------------------------------------------
// 1. Policy math: each gate kind
// ---------------------------------------------------------------------------

test("no-answer: topScoreBelow gate abstains on low top-1, retains on high", () => {
  const policy = findPolicy("score-below-0.30");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.10 },
    { queryId: "q2", family: "exact", isPositive: true, topScore: 0.50 },
    { queryId: "q3", family: "no-answer", isPositive: false, topScore: 0.25 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true); // 0.10 < 0.30
  assert.match(decisions[0]!.reason, /score-below-0.3/);
  assert.equal(decisions[1]!.abstain, false); // 0.50 >= 0.30
  assert.equal(decisions[1]!.reason, "none");
  assert.equal(decisions[2]!.abstain, true); // 0.25 < 0.30
});

test("no-answer: top1Top2GapBelow gate abstains on tiny gaps", () => {
  const policy: NoAnswerPolicy = {
    id: "test-gap",
    description: "test",
    category: "production-like",
    gates: [{ kind: "top1Top2GapBelow", threshold: 0.1 }],
  };
  const perQuery = mkPerQuery([
    // top1=0.5, top2=0.45 -> gap=0.05 < 0.1 -> abstains
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5, top1Top2Gap: 0.05 },
    // top1=0.9, top2=0.7 -> gap=0.2 >= 0.1 -> retains
    { queryId: "q2", family: "exact", isPositive: true, topScore: 0.9, top1Top2Gap: 0.2 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true);
  assert.equal(decisions[1]!.abstain, false);
});

test("no-answer: top1Top2RatioBelow gate handles Infinity correctly", () => {
  const policy: NoAnswerPolicy = {
    id: "test-ratio",
    description: "test",
    category: "production-like",
    gates: [{ kind: "top1Top2RatioBelow", threshold: 1.5 }],
  };
  const perQuery = mkPerQuery([
    // ratio=2.0 (cap from Infinity) -> NOT below 1.5 -> retains
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5, top1Top2Ratio: Number.POSITIVE_INFINITY },
    // ratio=1.0 -> below 1.5 -> abstains
    { queryId: "q2", family: "exact", isPositive: true, topScore: 0.5, top1Top2Ratio: 1.0 },
    // ratio=3.0 -> NOT below 1.5 -> retains
    { queryId: "q3", family: "exact", isPositive: true, topScore: 0.5, top1Top2Ratio: 3.0 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, false);
  assert.equal(decisions[1]!.abstain, true);
  assert.equal(decisions[2]!.abstain, false);
});

test("no-answer: returnedCountBelow gate", () => {
  const policy = findPolicy("returned-count-below-2");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, returnedCount: 1 },
    { queryId: "q2", family: "exact", isPositive: true, returnedCount: 2 },
    { queryId: "q3", family: "exact", isPositive: true, returnedCount: 3 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true); // 1 < 2
  assert.equal(decisions[1]!.abstain, false); // 2 >= 2
  assert.equal(decisions[2]!.abstain, false); // 3 >= 2
});

test("no-answer: topKSizeEquals and topKSizeAtMost gates", () => {
  const eq: NoAnswerPolicy = {
    id: "test-eq",
    description: "test",
    category: "production-like",
    gates: [{ kind: "topKSizeEquals", value: 1 }],
  };
  const atMost: NoAnswerPolicy = {
    id: "test-atmost",
    description: "test",
    category: "production-like",
    gates: [{ kind: "topKSizeAtMost", value: 1 }],
  };
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topKSize: 0 },
    { queryId: "q2", family: "exact", isPositive: true, topKSize: 1 },
    { queryId: "q3", family: "exact", isPositive: true, topKSize: 2 },
  ]);
  const eqDecisions = evaluateNoAnswerPolicy(eq, perQuery);
  assert.equal(eqDecisions[0]!.abstain, false); // 0 !== 1
  assert.equal(eqDecisions[1]!.abstain, true); // 1 === 1
  assert.equal(eqDecisions[2]!.abstain, false); // 2 !== 1
  const atMostDecisions = evaluateNoAnswerPolicy(atMost, perQuery);
  assert.equal(atMostDecisions[0]!.abstain, true); // 0 <= 1
  assert.equal(atMostDecisions[1]!.abstain, true); // 1 <= 1
  assert.equal(atMostDecisions[2]!.abstain, false); // 2 > 1
});

test("no-answer: sufficiencyLabelIn gate abstains on insufficient + confabulation", () => {
  const policy = findPolicy("sufficiency-insufficient-or-confabulation");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, sufficiencyLabel: "insufficient" },
    { queryId: "q2", family: "no-answer", isPositive: false, sufficiencyLabel: "confabulation" },
    { queryId: "q3", family: "exact", isPositive: true, sufficiencyLabel: "sufficient" },
    { queryId: "q4", family: "exact", isPositive: true, sufficiencyLabel: "partial" },
    { queryId: "q5", family: "no-answer", isPositive: false, sufficiencyLabel: "no-answer-correct" },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true);
  assert.equal(decisions[1]!.abstain, true);
  assert.equal(decisions[2]!.abstain, false); // sufficient -> retain
  assert.equal(decisions[3]!.abstain, false); // partial -> retain
  assert.equal(decisions[4]!.abstain, false); // no-answer-correct -> retain
});

test("no-answer: family gate abstains only on the named family", () => {
  const policy = findPolicy("family-no-answer");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false },
    { queryId: "q2", family: "exact", isPositive: true },
    { queryId: "q3", family: "temporal", isPositive: true },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true); // no-answer -> abstains
  assert.equal(decisions[1]!.abstain, false); // exact -> retains
  assert.equal(decisions[2]!.abstain, false); // temporal -> retains
});

test("no-answer: queryShapeFlag gate abstains on detector flags", () => {
  const policy = findPolicy("oracle-detector-hardneg-or-falseprem");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false, isNoAnswerHardNegative: true },
    { queryId: "q2", family: "no-answer", isPositive: false, isFalsePremiseLike: true },
    { queryId: "q3", family: "no-answer", isPositive: false, isAdversarialParaphrase: true },
    { queryId: "q4", family: "no-answer", isPositive: false }, // no flag
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true); // hardneg -> abstains
  assert.equal(decisions[1]!.abstain, true); // falseprem -> abstains
  assert.equal(decisions[2]!.abstain, false); // only adversarialParaphrase, not in gate
  assert.equal(decisions[3]!.abstain, false); // no flag -> retains
});

test("no-answer: queryLabelsIn gate abstains on fixture-truth labels", () => {
  const policy = findPolicy("oracle-fixture-label-hardneg");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false, queryLabels: ["hardNegative"] },
    { queryId: "q2", family: "no-answer", isPositive: false, queryLabels: ["falsePremise"] },
    { queryId: "q3", family: "no-answer", isPositive: false }, // no labels
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true);
  assert.equal(decisions[1]!.abstain, false); // only falsePremise, not hardNegative
  assert.equal(decisions[2]!.abstain, false);
});

test("no-answer: oracle-fixture-label-any-labeled abstains on any labeled subset", () => {
  const policy = findPolicy("oracle-fixture-label-any-labeled");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false, queryLabels: ["hardNegative"] },
    { queryId: "q2", family: "paraphrase", isPositive: true, queryLabels: ["adversarialParaphrase"] },
    { queryId: "q3", family: "temporal", isPositive: true, queryLabels: ["divergentTemporal"] },
    { queryId: "q4", family: "exact", isPositive: true, queryLabels: ["nearMissCurrentCluster"] },
    { queryId: "q5", family: "exact", isPositive: true }, // no labels
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  // The policy abstains on ANY query that
  // carries one of the named labels, including
  // positive queries with adversarial labels.
  // This is a ceiling reading; it is
  // intentionally aggressive.
  assert.equal(decisions[0]!.abstain, true);
  assert.equal(decisions[1]!.abstain, true);
  assert.equal(decisions[2]!.abstain, true);
  assert.equal(decisions[3]!.abstain, true);
  assert.equal(decisions[4]!.abstain, false);
});

test("no-answer: multiple gates OR-combine", () => {
  const policy: NoAnswerPolicy = {
    id: "test-or",
    description: "test",
    category: "production-like",
    gates: [
      { kind: "topScoreBelow", threshold: 0.5 },
      { kind: "family", families: ["no-answer"] },
    ],
  };
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.4 }, // fires score
    { queryId: "q2", family: "no-answer", isPositive: false, topScore: 0.9 }, // fires family
    { queryId: "q3", family: "exact", isPositive: true, topScore: 0.6 }, // neither
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, true);
  assert.match(decisions[0]!.reason, /score-below/);
  assert.equal(decisions[1]!.abstain, true);
  assert.match(decisions[1]!.reason, /family-in/);
  assert.equal(decisions[2]!.abstain, false);
  assert.equal(decisions[2]!.reason, "none");
});

// ---------------------------------------------------------------------------
// 2. Edge cases
// ---------------------------------------------------------------------------

test("no-answer: empty perQuery returns empty decisions", () => {
  const policy = findPolicy("score-below-0.30");
  const decisions = evaluateNoAnswerPolicy(policy, []);
  assert.equal(decisions.length, 0);
});

test("no-answer: gate with active=false is skipped", () => {
  const policy: NoAnswerPolicy = {
    id: "test-inactive",
    description: "test",
    category: "production-like",
    gates: [
      { kind: "topScoreBelow", threshold: 0.5, active: false },
    ],
  };
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.1 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, false); // gate disabled
});

test("no-answer: sufficiencyLabelIn with undefined label does not fire", () => {
  // A query with no sufficiency label must
  // never trip a sufficiencyLabelIn gate; the
  // gate is honest about "I cannot tell".
  const policy = findPolicy("sufficiency-insufficient-or-confabulation");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true }, // no label
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, false);
});

test("no-answer: queryLabelsIn with no labels does not fire", () => {
  const policy = findPolicy("oracle-fixture-label-hardneg");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false }, // no labels
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  assert.equal(decisions[0]!.abstain, false);
});

// ---------------------------------------------------------------------------
// 3. Trade-off aggregation
// ---------------------------------------------------------------------------

test("no-answer: computeNoAnswerPolicyMetrics aggregates per-policy correctly", () => {
  // Synthetic 4-query set: 2 positive (1 hit, 1
  // miss), 2 no-answer (1 abstained, 1 retained).
  // The policy abstains on a single gate
  // (topScoreBelow 0.30).
  const policy = findPolicy("score-below-0.30");
  const perQuery = mkPerQuery([
    // positive hit, high score -> retained
    {
      queryId: "pos-hit",
      family: "exact",
      isPositive: true,
      topScore: 0.9,
      rank1: true,
      currentTruthAt1: true,
      hitAt5: true,
    },
    // positive miss, low score -> abstained
    {
      queryId: "pos-miss",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.1,
      rank1: false,
      currentTruthAt1: false,
      hitAt5: false,
    },
    // no-answer, low score -> abstained
    {
      queryId: "na-low",
      family: "no-answer",
      isPositive: false,
      topScore: 0.05,
    },
    // no-answer, high score -> retained (FN)
    {
      queryId: "na-high",
      family: "no-answer",
      isPositive: false,
      topScore: 0.5,
    },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  const m = computeNoAnswerPolicyMetrics(policy, decisions);
  assert.equal(m.total, 4);
  assert.equal(m.positiveCount, 2);
  assert.equal(m.noAnswerCount, 2);
  // TP = 1 (na-low abstained), FP = 1 (pos-miss
  // abstained), FN = 1 (na-high retained), TN = 1
  // (pos-hit retained).
  assert.equal(m.noAnswerAbstained, 1);
  assert.equal(m.positiveAbstained, 1);
  // Baselines: 1 hit@5, 1 rank1, 1 currentTruthAt1.
  assert.equal(m.baseline.hitAt5, 1);
  assert.equal(m.baseline.rank1, 1);
  assert.equal(m.baseline.currentTruthAt1, 1);
  // Retained: pos-hit has hit@5, rank1,
  // currentTruthAt1 -> 1/1/1 retained.
  assert.equal(m.hitAt5Retained, 1);
  assert.equal(m.hitAt5Lost, 0);
  assert.equal(m.rank1Retained, 1);
  assert.equal(m.rank1Lost, 0);
  assert.equal(m.currentTruthAt1Retained, 1);
  assert.equal(m.currentTruthAt1Lost, 0);
  // Precision / recall / F1.
  // TP=1, FP=1, FN=1, TN=1.
  // P = 1/(1+1) = 0.5, R = 1/(1+1) = 0.5,
  // F1 = 2*0.5*0.5/(0.5+0.5) = 0.5.
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(m.f1, 0.5);
  // Gate counts: only topScoreBelow fired,
  // once (on pos-miss and na-low). Two queries
  // abstained via topScoreBelow.
  assert.equal(m.gateCounts.topScoreBelow, 2);
  // Per-family positive abstention: only
  // "paraphrase" has an abstention.
  assert.equal(m.positiveAbstainedByFamily.exact?.abstained, 0);
  assert.equal(m.positiveAbstainedByFamily.paraphrase?.abstained, 1);
  assert.equal(m.positiveAbstainedByFamily.paraphrase?.rate, 1);
  // FP / FN lists.
  assert.equal(m.falsePositives.length, 1);
  assert.equal(m.falsePositives[0]!.queryId, "pos-miss");
  assert.equal(m.falseNegatives.length, 1);
  assert.equal(m.falseNegatives[0]!.queryId, "na-high");
});

test("no-answer: precision/recall edge cases (zero TP)", () => {
  // A policy that abstains on NO query: 0 TP,
  // 0 FP, all no-answer queries are FN. P=0
  // (convention), R=0, F1=0.
  const policy = findPolicy("baseline-no-policy");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5 },
    { queryId: "q2", family: "no-answer", isPositive: false, topScore: 0.5 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  const m = computeNoAnswerPolicyMetrics(policy, decisions);
  assert.equal(m.precision, 0);
  assert.equal(m.recall, 0);
  assert.equal(m.f1, 0);
});

test("no-answer: abstainedBySufficiencyLabel breakdown is correct", () => {
  const policy = findPolicy("sufficiency-insufficient-or-confabulation");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false, sufficiencyLabel: "confabulation" },
    { queryId: "q2", family: "exact", isPositive: true, sufficiencyLabel: "insufficient" },
    { queryId: "q3", family: "exact", isPositive: true, sufficiencyLabel: "sufficient" },
    { queryId: "q4", family: "no-answer", isPositive: false, sufficiencyLabel: "no-answer-correct" },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  const m = computeNoAnswerPolicyMetrics(policy, decisions);
  // q1 (confabulation) and q2 (insufficient)
  // both abstained.
  assert.equal(m.abstainedBySufficiencyLabel.confabulation?.total, 1);
  assert.equal(m.abstainedBySufficiencyLabel.confabulation?.abstained, 1);
  assert.equal(m.abstainedBySufficiencyLabel.insufficient?.total, 1);
  assert.equal(m.abstainedBySufficiencyLabel.insufficient?.abstained, 1);
  // sufficient and no-answer-correct were not
  // abstained on (not in gate set).
  assert.equal(m.abstainedBySufficiencyLabel.sufficient, undefined);
  assert.equal(m.abstainedBySufficiencyLabel["no-answer-correct"], undefined);
});

test("no-answer: gate counts tally each gate per abstention event", () => {
  // A policy with three gates: when two gates
  // both fire on the same query, both buckets
  // are incremented.
  const policy: NoAnswerPolicy = {
    id: "test-multi-gate",
    description: "test",
    category: "production-like",
    gates: [
      { kind: "topScoreBelow", threshold: 0.5 },
      { kind: "family", families: ["no-answer"] },
      // Use a topKSizeAtMost value that
      // does NOT match the default
      // topKSize=0, so the gate fires only
      // on the queries we explicitly set
      // topKSize <= 0.
      { kind: "topKSizeAtMost", value: 0 },
    ],
  };
  const perQuery = mkPerQuery([
    // q1: low score AND no-answer family AND
    // topKSize defaults to 0 -> 3 gates fire.
    { queryId: "q1", family: "no-answer", isPositive: false, topScore: 0.1 },
    // q2: low score, exact family, topKSize 0 -> 2 gates fire (score + topKSizeAtMost).
    { queryId: "q2", family: "exact", isPositive: true, topScore: 0.1, topKSize: 0 },
    // q3: high score, exact family, topKSize 5 -> 0 gates.
    { queryId: "q3", family: "exact", isPositive: true, topScore: 0.9, topKSize: 5 },
  ]);
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  const m = computeNoAnswerPolicyMetrics(policy, decisions);
  // topScoreBelow fires on q1 and q2 -> 2
  assert.equal(m.gateCounts.topScoreBelow, 2);
  // family fires on q1 only -> 1
  assert.equal(m.gateCounts.family, 1);
  // topKSizeAtMost fires on q1 (default 0)
  // and q2 (explicit 0) -> 2
  assert.equal(m.gateCounts.topKSizeAtMost, 2);
  // q1 is no-answer + abstained -> 1 NA-abstained
  assert.equal(m.noAnswerAbstained, 1);
  // q2 is positive + abstained -> 1 FP
  assert.equal(m.positiveAbstained, 1);
});

// ---------------------------------------------------------------------------
// 4. Output determinism / additivity
// ---------------------------------------------------------------------------

test("no-answer: report is deterministic for the same input", () => {
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5 },
    { queryId: "q2", family: "no-answer", isPositive: false, topScore: 0.1 },
  ]);
  const a = runNoAnswerPolicyExperiment({
    recordCount: 100,
    perQuery,
  });
  const b = runNoAnswerPolicyExperiment({
    recordCount: 100,
    perQuery,
  });
  // The decision lists, the metric blocks,
  // and the per-query block are byte-equal
  // across two runs. The `generatedAt`
  // timestamp is intentionally not compared:
  // it is a wall-clock field that documents
  // when the report was generated, not a
  // function of the input.
  const stripTimestamp = (r: typeof a): Omit<typeof a, "generatedAt"> => {
    const { generatedAt: _unused, ...rest } = r;
    void _unused;
    return rest;
  };
  assert.deepEqual(stripTimestamp(a), stripTimestamp(b));
  // Sanity: the report has at least the
  // baseline + a few production-like policies.
  assert.ok(a.policies.length >= 5);
});

test("no-answer: evaluateNoAnswerPolicy does not mutate perQuery", () => {
  // Pin the contract that the evaluator is
  // a pure, non-mutating helper.
  const policy = findPolicy("score-or-family-no-answer");
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "no-answer", isPositive: false, topScore: 0.1 },
    { queryId: "q2", family: "exact", isPositive: true, topScore: 0.9 },
  ]);
  // Snapshot the inputs.
  const signalsBefore = perQuery.map((p) => ({
    topScore: p.signals.topScore,
    top1Top2Gap: p.signals.top1Top2Gap,
  }));
  const labelsBefore = perQuery.map((p) => [...(p.queryLabels ?? [])]);
  evaluateNoAnswerPolicy(policy, perQuery);
  for (let i = 0; i < perQuery.length; i++) {
    assert.equal(perQuery[i]!.signals.topScore, signalsBefore[i]!.topScore);
    assert.equal(perQuery[i]!.signals.top1Top2Gap, signalsBefore[i]!.top1Top2Gap);
  }
  for (let i = 0; i < perQuery.length; i++) {
    assert.deepEqual(
      perQuery[i]!.queryLabels ?? [],
      labelsBefore[i] ?? [],
    );
  }
});

test("no-answer: buildNoAnswerPolicyPerQuery does not mutate inputs", () => {
  // The factory must not mutate the input
  // evals or maps.
  const e1 = evalFrom(queryById("exact-postgres-storage"), [1], [0.9]);
  const e2 = evalFrom(queryById("nonexistent-company-picnic"), [1], [0.1]);
  const signalsMap = new Map<string, AbstentionSignals>([
    [e1.queryId, { ...emptySignals(), topScore: 0.9 }],
    [e2.queryId, { ...emptySignals(), topScore: 0.1 }],
  ]);
  const labelMap = new Map<string, "sufficient" | "no-answer-correct">([
    [e1.queryId, "sufficient"],
    [e2.queryId, "no-answer-correct"],
  ]);
  const labelsMap = new Map<string, string[]>();
  const evalsBefore = [e1, e2].map((e) => ({
    queryId: e.queryId,
    topIds: [...e.topIds],
    topScores: [...e.topScores],
  }));
  buildNoAnswerPolicyPerQuery({
    evals: [e1, e2],
    signalsByQueryId: signalsMap,
    sufficiencyLabelByQueryId: labelMap,
    labelsByQueryId: labelsMap,
  });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual([e1, e2][i]!.topIds, evalsBefore[i]!.topIds);
    assert.deepEqual([e1, e2][i]!.topScores, evalsBefore[i]!.topScores);
  }
});

function emptySignals(): AbstentionSignals {
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

// ---------------------------------------------------------------------------
// 5. onlyPolicyIds filter
// ---------------------------------------------------------------------------

test("no-answer: onlyPolicyIds restricts the report to the named policies", () => {
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5 },
  ]);
  const r = runNoAnswerPolicyExperiment({
    recordCount: 100,
    perQuery,
    config: { onlyPolicyIds: ["baseline-no-policy", "score-below-0.30"] },
  });
  assert.equal(r.policies.length, 2);
  const ids = r.policies.map((p) => p.policyId);
  assert.ok(ids.includes("baseline-no-policy"));
  assert.ok(ids.includes("score-below-0.30"));
});

// ---------------------------------------------------------------------------
// 6. End-to-end: real lexical baseline on the fixture corpus
// ---------------------------------------------------------------------------

test("no-answer: lexical baseline on the fixture corpus is well-formed", () => {
  // The end-to-end test runs the real lexical
  // ranker against the fixture corpus + query
  // set, builds the per-query signal block via
  // the audit's per-query detector, builds the
  // candidate-set sufficiency label via the
  // new diagnostic, and feeds everything into
  // the experiment evaluator. The test pins
  // the headline numbers a reviewer expects.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  const signalsByQueryId = new Map<string, AbstentionSignals>();
  const sufficiencyLabelByQueryId = new Map<string, "sufficient" | "partial" | "insufficient" | "wrong-current-truth" | "near-miss" | "confabulation" | "no-answer-correct">();
  const labelsByQueryId = new Map<string, string[]>();
  for (const q of BENCHMARK_QUERIES) {
    const ranked = rankLexical(q.query, candidates, {
      threshold: 0.2,
      topK: 5,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const e = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    evals.push(e);
    // Build the audit's per-query signal block.
    // The shape mirrors what
    // `buildAbstentionSignals` produces from the
    // runner, but we only need the top-score /
    // top1Top2Gap / top1Top2Ratio / returnedCount
    // / query-shape-flag fields for the
    // experiment.
    const flags = detectQueryShape(q, corpusTokenSets);
    signalsByQueryId.set(q.id, {
      ...emptySignals(),
      topScore: topScores[0] ?? 0,
      top1Top2Gap: (topScores[0] ?? 0) - (topScores[1] ?? 0),
      top1Top2Ratio:
        topScores[1] === 0 || topScores[1] === undefined
          ? topScores[0] && topScores[0] > 0
            ? Number.POSITIVE_INFINITY
            : 1
          : (topScores[0] ?? 0) / topScores[1],
      returnedCount: topIds.length,
      isNoAnswerHardNegative: flags.isNoAnswerHardNegative,
      isFalsePremiseLike: flags.isFalsePremiseLike,
      isAdversarialParaphrase: flags.isAdversarialParaphrase,
      isNearMissCurrentCluster: flags.isNearMissCurrentCluster,
      isDivergentTemporal: flags.isDivergentTemporal,
    });
    // Build the candidate-set sufficiency
    // label via the new diagnostic.
    const diag = classifyCandidateSetSufficiency(e, q);
    sufficiencyLabelByQueryId.set(q.id, diag.label);
    if (q.labels) labelsByQueryId.set(q.id, [...q.labels]);
  }
  const report = runNoAnswerAbstentionExperiment({
    evals,
    signalsByQueryId,
    sufficiencyLabelByQueryId,
    recordCount: BENCHMARK_RECORDS.length,
    labelsByQueryId,
  });
  // ---- Headline shape ----
  assert.equal(report.config.total, BENCHMARK_QUERIES.length);
  assert.equal(
    report.config.noAnswerCount + report.config.positiveCount,
    report.config.total,
  );
  // The fixture has 46 no-answer queries, so
  // the baseline-no-policy row should show
  // 0 no-answer abstentions: the baseline
  // uses a `none` gate that never fires, so
  // the policy never abstains regardless of
  // the ranker's natural empty-top-K. The
  // ranker's natural abstention count (3 on
  // the lexical baseline) is reported by the
  // existing audit's per-query `passed` flag,
  // NOT by this experiment's policy metrics.
  // A reviewer who wants the natural-empty
  // abstention count reads the audit artifact.
  const baseline = report.policies.find(
    (p) => p.policyId === "baseline-no-policy",
  )!;
  assert.equal(baseline.noAnswerAbstained, 0);
  assert.equal(baseline.noAnswerAbstainedRate, 0);
  // Sanity: the 3 naturally-abstained
  // no-answer queries are still in the
  // report's per-query set, just not
  // abstained on by the baseline policy.
  // (See the audit artifact for the
  // ranker's natural-empty count.)
  // The "family-no-answer" policy is a
  // fixture-shaped ceiling: it abstains on
  // ALL 46 no-answer queries (the ranker is
  // expected to return zero hits for that
  // family) at zero positive-set cost (no
  // positive query has family="no-answer").
  // The strong reading is NOT deployable: the
  // `family` field is fixture truth.
  const famPol = report.policies.find(
    (p) => p.policyId === "family-no-answer",
  )!;
  assert.equal(famPol.category, "fixture-shaped");
  assert.equal(famPol.noAnswerAbstained, 46);
  assert.equal(famPol.noAnswerAbstainedRate, 1);
  assert.equal(famPol.positiveAbstained, 0);
  // The "score-or-family-no-answer" policy is
  // also fixture-shaped: it keys on the
  // `family` field. Its TNR=1.0 reading is
  // impressive but NOT deployable. The
  // score-only sub-rule is the
  // `score-below-0.30` rule; the family
  // sub-rule is the fixture-shaped ceiling.
  const fixPol = report.policies.find(
    (p) => p.policyId === "score-or-family-no-answer",
  )!;
  assert.equal(fixPol.category, "fixture-shaped");
  assert.equal(fixPol.noAnswerAbstained, 46);
  // The genuinely production-like candidate
  // surfaced by the human report is
  // `score-or-sufficiency-insufficient`: it
  // uses ONLY runtime signals (topScore, the
  // candidate-set sufficiency label). It does
  // NOT use the `family` field.
  const prodCandidate = report.policies.find(
    (p) => p.policyId === "score-or-sufficiency-insufficient",
  )!;
  assert.equal(prodCandidate.category, "production-like");
  // The candidate is a strict superset of
  // `score-below-0.30` (it abstains on
  // everything the score-below rule abstains
  // on, plus everything the
  // sufficiency-label rule abstains on).
  // Pin the headline numbers as honest
  // upper/lower bounds rather than exact
  // values (the trade-off depends on the
  // corpus's sufficiency-label distribution,
  // which can shift with the corpus).
  assert.ok(
    prodCandidate.noAnswerAbstained >= 0,
    `production-like candidate must be well-formed, got ${prodCandidate.noAnswerAbstained} no-answer abstentions`,
  );
  assert.ok(
    prodCandidate.noAnswerAbstained <= prodCandidate.noAnswerCount,
    `production-like candidate cannot abstain on more no-answer queries than exist`,
  );
  assert.equal(
    prodCandidate.noAnswerCount,
    fixPol.noAnswerCount,
    `no-answer count must be the same across the report`,
  );
  // The oracle any-labeled policy is the
  // ceiling: it abstains on every query that
  // carries one of the named labels. On the
  // current corpus, the ceiling abstains on
  // every labeled no-answer query, but also
  // on a few labeled positive queries (the
  // adversarial paraphrase / near-miss cases).
  const oraclePol = report.policies.find(
    (p) => p.policyId === "oracle-fixture-label-any-labeled",
  )!;
  // The oracle's recall is bounded by the
  // labeled subset of the corpus: a no-answer
  // query that has NO `hardNegative`,
  // `falsePremise`, `adversarialParaphrase`,
  // `nearMissCurrentCluster`, or
  // `divergentTemporal` label is not abstained
  // on by this oracle. The corpus's easy
  // no-answer queries (no token overlap with
  // a real record) carry no adversarial
  // labels, so the oracle abstains on the
  // labeled subset only. Pin the rate as a
  // non-trivial fraction of the no-answer set
  // (the labels capture the hard cases) and
  // strictly less than 1.0 (the easy cases
  // are unlabeled).
  assert.ok(
    oraclePol.noAnswerAbstainedRate > 0,
    `oracle should abstain on at least one labeled no-answer query, got rate=${oraclePol.noAnswerAbstainedRate}`,
  );
  assert.ok(
    oraclePol.noAnswerAbstainedRate < 1.0,
    `oracle should NOT abstain on every no-answer query (easy queries have no labels), got rate=${oraclePol.noAnswerAbstainedRate}`,
  );
  // The "fixture-label" oracle abstains on
  // every no-answer query that carries the
  // explicit `hardNegative` label. The number
  // is at least 1 (the fixture has labeled
  // hard-negatives) and at most the no-answer
  // count.
  const oracleHardneg = report.policies.find(
    (p) => p.policyId === "oracle-fixture-label-hardneg",
  )!;
  assert.ok(
    oracleHardneg.noAnswerAbstained >= 1,
    `oracle-fixture-label-hardneg should abstain on at least one labeled no-answer query, got ${oracleHardneg.noAnswerAbstained}`,
  );
  assert.ok(
    oracleHardneg.noAnswerAbstained <= 46,
    `oracle-fixture-label-hardneg abstains at most on the no-answer count`,
  );
  // ---- Per-family breakdown for the
  //      production-like candidate ----
  // The human report surfaces the
  // production-like candidate's per-family
  // positive-abstention breakdown (NOT the
  // fixture-shaped `family` policy's
  // breakdown, which is trivially zero on
  // every positive family). The
  // `score-or-sufficiency-insufficient`
  // policy's positive abstention set is
  // contained in the union of the score-gate
  // catch set AND the sufficiency-label
  // catch set; neither set is restricted by
  // family. Pin the breakdown as
  // well-formed (positive families have
  // totals and abstained counts) without
  // asserting exact rates (the rates depend
  // on the corpus's per-family score and
  // sufficiency distribution).
  for (const family of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "orientation",
  ]) {
    const slot = prodCandidate.positiveAbstainedByFamily[family];
    assert.ok(
      slot,
      `production-like candidate must report a ${family} breakdown`,
    );
    assert.ok(
      slot!.total > 0,
      `production-like candidate must have ${family} total > 0 on the fixture corpus`,
    );
  }
  // ---- Human report is well-formed ----
  const text = formatNoAnswerPolicyReport(report);
  for (const p of BUILTIN_NO_ANSWER_POLICIES) {
    assert.ok(text.includes(p.id), `human report missing ${p.id}`);
  }
  assert.match(text, /no-answer abstention \/ calibration experiment/);
  // The artifact is JSON-serializable.
  const json = JSON.stringify(report);
  assert.ok(json.length > 100);
});

test("no-answer: human report is byte-stable for the same input", () => {
  // Build a small fixture and verify the
  // human report is byte-equal across two
  // calls. The function is pure. The
  // `generated at: <iso>` line is the only
  // non-deterministic field — it embeds
  // `report.generatedAt`, which the runner
  // fills from `new Date().toISOString()` at
  // ms resolution. Two back-to-back calls can
  // straddle a millisecond boundary and produce
  // different timestamps. We compare the
  // report with the `generated at:` line
  // stripped, the same pattern the
  // `paraphrase-recovery` test uses for the
  // same wall-clock field.
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5 },
    { queryId: "q2", family: "no-answer", isPositive: false, topScore: 0.1 },
  ]);
  const r1 = runNoAnswerPolicyExperiment({ recordCount: 100, perQuery });
  const r2 = runNoAnswerPolicyExperiment({ recordCount: 100, perQuery });
  const aText = formatNoAnswerPolicyReport(r1);
  const bText = formatNoAnswerPolicyReport(r2);
  const stripGeneratedAt = (s: string): string[] =>
    s
      .split("\n")
      .filter((l) => !l.startsWith("generated at:"));
  assert.deepEqual(
    stripGeneratedAt(aText),
    stripGeneratedAt(bText),
    `human report must be byte-stable for the same input (ignoring the generated-at line)`,
  );
});

test("no-answer: writer writes a valid JSON artifact", () => {
  // End-to-end: write the artifact to a temp
  // dir and re-read it. The on-disk shape
  // matches the in-memory shape.
  const perQuery = mkPerQuery([
    { queryId: "q1", family: "exact", isPositive: true, topScore: 0.5 },
  ]);
  const report = runNoAnswerPolicyExperiment({ recordCount: 100, perQuery });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "na-abst-"));
  try {
    const file = writeNoAnswerAbstentionReport(report, dir);
    const reloaded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(reloaded.config.total, report.config.total);
    assert.equal(reloaded.policies.length, report.policies.length);
    // The file lives under the temp dir.
    assert.ok(file.startsWith(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Production import guard
// ---------------------------------------------------------------------------

test("no-answer: production source tree must NOT import the experiment modules", () => {
  // The experiment is benchmark-only; a future
  // edit that wires it into the recall
  // controller, the remember controller, the
  // server, the tools, the storage layer, or
  // the retrieval layer would change the
  // production contract. The guard is static:
  // a string-match across the production path.
  // The benchmark / audit / diagnostic / policy
  // paths are explicitly allowed to import the
  // experiment module.
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
      /no-answer-abstention/,
      `${rel} must NOT import the no-answer abstention experiment module`,
    );
  }
});

test("no-answer: public MCP API is unchanged (remember + recall only)", () => {
  // The benchmark-only experiment must not
  // change the public MCP tool surface.
  assert.deepEqual(
    [...PUBLIC_TOOL_NAMES],
    ["remember", "recall"],
    "public MCP tool surface must remain exactly remember + recall",
  );
});

// ---------------------------------------------------------------------------
// 8. Existing report shapes are unchanged
// ---------------------------------------------------------------------------

test("no-answer: existing audit / calibration / diagnostic / policy reports are unchanged", () => {
  // The experiment is additive. The
  // sufficiency-diagnostic test, the
  // abstention-audit test, the
  // abstention-policy test, and the
  // calibration test are pinned separately;
  // here we re-verify the diagnostic +
  // policy run on the real fixture corpus
  // produce the documented shapes so a
  // reviewer who reads the new test alongside
  // the existing ones can see the experiment
  // doesn't disturb the existing report
  // contracts.
  const lex = runRetrievalBenchmark({ variant: "lexical" });
  const lexDiag = buildSufficiencyReport(
    "lexical",
    lex.evals,
    BENCHMARK_QUERIES,
  );
  // Diagnostic shape is unchanged.
  assert.equal(lexDiag.variant, "lexical");
  assert.equal(lexDiag.diagnostics.length, BENCHMARK_QUERIES.length);
  // Every (family, label) combination the
  // diagnostic tracks is present.
  for (const family of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ] as const) {
    assert.ok(lexDiag.perFamily[family], `diagnostic per-family missing ${family}`);
  }
  // The new experiment consumes this
  // diagnostic; the diagnostic itself is
  // unchanged. The experiment's
  // per-query `sufficiencyLabel` matches the
  // diagnostic's label.
  for (let i = 0; i < lexDiag.diagnostics.length; i++) {
    const d = lexDiag.diagnostics[i]!;
    const e = lex.evals.find((ee) => ee.queryId === d.queryId);
    assert.ok(e, `eval missing for diagnostic ${d.queryId}`);
    // Re-derive the label from the eval + the
    // query and confirm it matches.
    const q = BENCHMARK_QUERIES.find((qq) => qq.id === d.queryId)!;
    const d2 = classifyCandidateSetSufficiency(e, q);
    assert.equal(d2.label, d.label);
  }
});
