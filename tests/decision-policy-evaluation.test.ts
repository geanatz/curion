/**
 * Tests for the benchmark-only decision-policy evaluation
 * helper (v2).
 *
 * The controller-integration test suite
 * (`tests/decision-engine.test.ts`) pins the controller's
 * shadow-mode integration, the schema, and the parser surface.
 * This file pins the decision-policy evaluation harness that
 * closes the gap: it runs the real decision adapter against
 * a curated v2 scenario set with scripted provider behaviour
 * and emits an artifact a reviewer can audit.
 *
 * Coverage (v2):
 *
 *   1. Per-scenario assertions: every built-in scenario
 *      passes its expectation block under the scripted
 *      provider behaviour.
 *
 *   2. Repair path: the `repair-recovers` scenario exercises
 *      the same-provider repair pass and verifies the
 *      adapter makes 2 HTTP calls (1 invalid + 1 valid).
 *
 *   3. Hard-failure path: the `primary-hard-failure-no-
 *      fallback` scenario verifies the adapter returns
 *      `all-providers-failed` without throwing, and the
 *      httpCalls count matches the expected state machine.
 *
 *   4. Fallback recovery: the `fallback-recovery-after-
 *      primary-failure` scenario verifies that primary
 *      hard failure is followed by a single fallback call
 *      (no repair on hard failure), yielding 2 HTTP calls
 *      and outcome=ok with fallbackUsed=true.
 *
 *   5. Always-invalid output: the `always-invalid-provider-
 *      output` scenario verifies that 4 invalid responses
 *      (primary first + repair + fallback first + repair)
 *      yield `all-providers-failed` after exactly 4 HTTP
 *      calls.
 *
 *   6. Action distribution: the action histogram in the
 *      report includes every action vocabulary slot, with
 *      a count of zero when the slot was not observed.
 *
 *   7. Target-memory match (Jaccard / IoU): scenarios with
 *      an `expected*Ids` block contribute to the aggregate
 *      Jaccard; the per-scenario Jaccard is asserted at 1.0
 *      for every scripted-correct scenario.
 *
 *   8. Safety-privacy gate: the strict pass-100% gate on
 *      safety-critical scenarios passes iff every
 *      safety-critical scenario passes.
 *
 *   9. All-scenarios gate + confusion matrix: the
 *      overall-gates block distinguishes the safety-privacy
 *      gate from the all-scenarios gate.
 *
 *   10. Determinism: repeated runs produce byte-equal
 *       captured decisions for the same scenario set.
 *
 *   11. No-network: the scripted fetch is the only path
 *       the adapter sees.
 *
 *   12. Report shape: meta + runs + actionHistogram +
 *       reasonHistogram + confusionMatrix + perActionAccuracy
 *       + perReasonAccuracy + targetMemoryMatch +
 *       confidenceBuckets + providerCallStats +
 *       safetyPrivacyGate + gates + categories + limitations
 *       are all well-formed.
 *
 *   13. CLI parser: accepts `--artifacts`, `--no-write`,
 *       `--no-stdout`; rejects unknown flags.
 *
 *   14. Artifact writer: writes a JSON artifact under
 *       a temp dir using the documented prefix.
 *
 *   15. Public API guard: the public MCP tool surface is
 *       unchanged; the decision adapter is wired only via
 *       the test-only `decisionProviderFetchImpl` seam.
 *
 *   16. Built-in scenario set integrity: unique ids, covers
 *       the brief's required action vocabulary axes, all
 *       `safetyClass` values are known, every scenario has
 *       a category.
 *
 *   17. Limitations block: surfaces the no-network /
 *       adapter-driven / frozen-scenarios / public-API
 *       caveats.
 *
 * The tests do NOT make any network call; the scripted
 * fetch in the harness is the only provider path.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseBenchmarkArtifactCli } from "../src/benchmark/_cli.ts";
import {
  parseDecisionPolicyEvaluationCli,
  prepareDecisionPolicyEvaluationEnv,
} from "../src/benchmark/decision-policy-evaluation-runner.ts";
import {
  BUILT_IN_DECISION_POLICY_SCENARIOS,
  DECISION_POLICY_EVALUATION_LIMITATIONS,
  DECISION_POLICY_EVALUATION_LIVE_WARNINGS,
  DECISION_POLICY_EVAL_LIVE_ENV,
  DECISION_POLICY_SCENARIO_CATEGORIES,
  DECISION_POLICY_SCENARIO_SET_VERSION,
  LiveOptInRequiredError,
  formatDecisionPolicyEvaluationReport,
  isLiveOptInEnv,
  runDecisionPolicyEvaluation,
  writeDecisionPolicyEvaluationReport,
} from "../src/benchmark/decision-policy-evaluation.ts";
import { loadDotEnv } from "../src/config/env-loader.ts";
import { REMEMBER_DECISION_ACTIONS, REMEMBER_DECISION_REASONS } from "../src/decision/types.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 1. Per-scenario assertions
// ---------------------------------------------------------------------------

test("decision-policy evaluation: all 26 v2 built-in scenarios pass", async () => {
  const report = await runDecisionPolicyEvaluation();
  // The 26 v2 built-in scenarios must all pass. A future
  // scenario that fails on a known limitation should be
  // marked expected-fail or removed from the v2 set; the
  // harness should not silently ship a failing scenario.
  assert.equal(report.meta.scenarioCount, 26);
  assert.equal(report.meta.passedCount, 26);
  assert.equal(report.meta.failedCount, 0);
  for (const r of report.runs) {
    assert.ok(
      r.pass,
      `scenario '${r.scenarioId}' must pass: ${formatAssertionFailures(r.assertions)}`
    );
  }
});

function formatAssertionFailures(
  assertions: ReadonlyArray<{ name: string; pass: boolean; note: string }>
): string {
  return assertions
    .filter((a) => !a.pass)
    .map((a) => `${a.name}=${a.note}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// 2. Repair path: invalid first response, valid repair response
// ---------------------------------------------------------------------------

test("decision-policy evaluation: repair-recovers makes exactly 2 HTTP calls and returns a valid decision", async () => {
  const report = await runDecisionPolicyEvaluation();
  const repair = report.runs.find((r) => r.scenarioId === "repair-recovers");
  assert.ok(repair, "repair-recovers scenario must be in the report");
  assert.equal(repair.adapterOk, true);
  assert.equal(repair.action, "store");
  assert.equal(repair.reason, "novel");
  // 2 calls: invalid first + valid repair. No fallback.
  assert.equal(repair.httpCalls, 2);
  assert.equal(repair.fallbackUsed, false);
  assert.equal(repair.repairAttempted, true);
  assert.equal(repair.fallbackAttempted, false);
});

// ---------------------------------------------------------------------------
// 3. Hard-failure path: 5xx on primary + no fallback
// ---------------------------------------------------------------------------

test("decision-policy evaluation: primary-hard-failure-no-fallback returns all-providers-failed without throwing", async () => {
  const report = await runDecisionPolicyEvaluation();
  const failure = report.runs.find((r) => r.scenarioId === "primary-hard-failure-no-fallback");
  assert.ok(failure, "primary-hard-failure-no-fallback scenario must be in the report");
  assert.equal(failure.adapterOk, false);
  assert.equal(failure.failureKind, "all-providers-failed");
  // The adapter makes 1 HTTP call (primary 5xx) and does
  // NOT attempt a repair call on hard failures — repair
  // is reserved for parse / validate failures. No fallback
  // is configured.
  assert.equal(failure.httpCalls, 1);
  assert.equal(failure.repairAttempted, false);
  assert.equal(failure.fallbackAttempted, false);
});

// ---------------------------------------------------------------------------
// 4. Fallback recovery after primary hard failure
// ---------------------------------------------------------------------------

test("decision-policy evaluation: fallback-recovery-after-primary-failure uses the fallback after primary 5xx", async () => {
  const report = await runDecisionPolicyEvaluation();
  const s = report.runs.find((r) => r.scenarioId === "fallback-recovery-after-primary-failure");
  assert.ok(s, "fallback-recovery-after-primary-failure scenario must be in the report");
  assert.equal(s.adapterOk, true);
  assert.equal(s.action, "store");
  assert.equal(s.reason, "novel");
  // 2 calls: primary 5xx + fallback first success. Repair
  // is NOT attempted for primary hard failure (parse path
  // only); the fallback's first call succeeds.
  assert.equal(s.httpCalls, 2);
  assert.equal(s.fallbackUsed, true);
  // Per-scenario provider-call inference:
  //   - repairAttempted = httpCalls >= 2 = TRUE (the SECOND
  //     call in this run is the fallback first attempt, not
  //     a repair, but the harness's boolean reflects
  //     `callIndex >= 2` on the primary side. With our URL-
  //     based discrimination, the second call is a fallback
  //     call, NOT a primary repair. The boolean should
  //     therefore be FALSE.) Assert the URL-based shape.
  assert.equal(s.repairAttempted, false, "primary repair must not be attempted on hard failure");
  assert.equal(s.fallbackAttempted, true);
});

// ---------------------------------------------------------------------------
// 5. Always-invalid provider output
// ---------------------------------------------------------------------------

test("decision-policy evaluation: always-invalid-provider-output exhausts all 4 scripted calls", async () => {
  const report = await runDecisionPolicyEvaluation();
  const s = report.runs.find((r) => r.scenarioId === "always-invalid-provider-output");
  assert.ok(s, "always-invalid-provider-output scenario must be in the report");
  assert.equal(s.adapterOk, false);
  assert.equal(s.failureKind, "all-providers-failed");
  // Primary first + primary repair + fallback first +
  // fallback repair = 4 HTTP calls.
  assert.equal(s.httpCalls, 4);
});

// ---------------------------------------------------------------------------
// 6. Action distribution: every vocabulary slot appears in the histogram
// ---------------------------------------------------------------------------

test("decision-policy evaluation: action histogram covers the full action vocabulary", async () => {
  const report = await runDecisionPolicyEvaluation();
  for (const action of REMEMBER_DECISION_ACTIONS) {
    const row = report.actionHistogram.find((r) => r.action === action);
    assert.ok(row, `action histogram must include ${action}`);
    assert.equal(typeof row.count, "number");
    assert.ok(row.count >= 0, `${action} count must be >= 0`);
  }
  // The summed counts must equal the number of scenarios
  // whose adapter returned ok (the histogram is over
  // successful outcomes only).
  const histogramSum = report.actionHistogram.reduce((s, r) => s + r.count, 0);
  assert.equal(histogramSum, report.meta.adapterOkCount);
});

test("decision-policy evaluation: reason histogram covers the full reason vocabulary", async () => {
  const report = await runDecisionPolicyEvaluation();
  for (const reason of REMEMBER_DECISION_REASONS) {
    const row = report.reasonHistogram.find((r) => r.reason === reason);
    assert.ok(row, `reason histogram must include ${reason}`);
    assert.equal(typeof row.count, "number");
    assert.ok(row.count >= 0, `${reason} count must be >= 0`);
  }
  const histogramSum = report.reasonHistogram.reduce((s, r) => s + r.count, 0);
  assert.equal(histogramSum, report.meta.adapterOkCount);
});

// ---------------------------------------------------------------------------
// 7. Target-memory match (v2 Jaccard / IoU)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: per-scenario Jaccard scores are well-formed", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.ok(report.targetMemoryMatch.perScenario.length >= 7);
  for (const r of report.targetMemoryMatch.perScenario) {
    assert.ok(r.jaccard >= 0 && r.jaccard <= 1, `jaccard must be in [0,1]: got ${r.jaccard}`);
  }
  // Aggregate is the micro mean of per-scenario Jaccards.
  const sumJ = report.targetMemoryMatch.perScenario.reduce((s, r) => s + r.jaccard, 0);
  const meanJ = sumJ / report.targetMemoryMatch.perScenario.length;
  assert.ok(Math.abs(report.targetMemoryMatch.aggregateJaccard - meanJ) < 1e-9);
  assert.equal(
    report.targetMemoryMatch.aggregateIoU,
    report.targetMemoryMatch.aggregateJaccard,
    "Jaccard over sets equals IoU over sets"
  );
});

test("decision-policy evaluation: scripted success yields Jaccard = 1.00 on every target-id scenario", async () => {
  const report = await runDecisionPolicyEvaluation();
  // Every target-id scenario should have a perfect Jaccard
  // under the scripted provider behaviour.
  for (const r of report.targetMemoryMatch.perScenario) {
    assert.equal(r.jaccard, 1, `${r.scenarioId} must produce a perfect Jaccard`);
  }
});

test("decision-policy evaluation: target-memory match rate counts only scenarios with target-memory expectations", async () => {
  const report = await runDecisionPolicyEvaluation();
  // Every scenario whose expect sets a targetIdIn* or
  // targetIdNotIn* block contributes to the meta counter.
  // With the v2 set, every scenario that sets an id-array
  // expectation is also expected to pass.
  const expectedDenominator = BUILT_IN_DECISION_POLICY_SCENARIOS.filter(
    (s) =>
      s.expect.targetIdInSuperseded !== undefined ||
      s.expect.targetIdInConflicts !== undefined ||
      s.expect.targetIdInRedundant !== undefined ||
      (s.expect.targetIdNotInSuperseded !== undefined &&
        s.expect.targetIdNotInSuperseded.length > 0) ||
      (s.expect.targetIdNotInConflicts !== undefined &&
        s.expect.targetIdNotInConflicts.length > 0) ||
      (s.expect.targetIdNotInRedundant !== undefined && s.expect.targetIdNotInRedundant.length > 0)
  ).length;
  assert.equal(report.meta.scenariosWithTargetMemoryMatchExpectation, expectedDenominator);
  assert.equal(
    report.meta.targetMemoryMatchPassCount,
    expectedDenominator,
    "every target-id scenario must pass under the scripted success provider"
  );
});

// ---------------------------------------------------------------------------
// 8. Safety-privacy gate
// ---------------------------------------------------------------------------

test("decision-policy evaluation: safety-privacy gate passes iff every safety-critical scenario passes", async () => {
  const report = await runDecisionPolicyEvaluation();
  const safetyRuns = report.runs.filter((r) => r.safetyCritical);
  assert.ok(
    safetyRuns.length >= 5,
    `v2 set must exercise at least 5 safety-critical scenarios, got ${safetyRuns.length}`
  );
  assert.equal(safetyRuns.length, report.safetyPrivacyGate.safetyCriticalCount);
  for (const r of safetyRuns) {
    assert.ok(r.pass, `safety-critical scenario '${r.scenarioId}' must pass`);
  }
  assert.equal(report.safetyPrivacyGate.passed, true);
});

test("decision-policy evaluation: safety-privacy failure surfaces on report.gates.safetyPrivacyFailedScenarioIds", async () => {
  // Build a one-off scenario set with a deliberately failing
  // safety-critical scenario. The harness's all-scenarios
  // gate should report both:
  //   (a) safetyPrivacyPassed = false, with the failing id in
  //       `safetyPrivacyFailedScenarioIds`.
  //   (b) overallPassed = false.
  const failingSafety = BUILT_IN_DECISION_POLICY_SCENARIOS.find(
    (s) => s.safetyCritical && s.id === "reject-secret-api-key"
  )!;
  // Swap the scripted response to `store / novel` so the
  // safety-critical scenario FAILS its expectation.
  const mutated = [
    {
      ...failingSafety,
      scripted: {
        primaryFirstResponse: JSON.stringify({
          action: "store",
          reason: "novel",
          supersededIds: [],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runDecisionPolicyEvaluation({ scenarios: mutated });
  assert.equal(report.safetyPrivacyGate.safetyCriticalFailed, 1);
  assert.equal(report.safetyPrivacyGate.passed, false);
  assert.deepEqual([...report.safetyPrivacyGate.failedScenarioIds], ["reject-secret-api-key"]);
  assert.equal(report.gates.safetyPrivacyPassed, false);
  assert.equal(report.gates.overallPassed, false);
  assert.deepEqual([...report.gates.safetyPrivacyFailedScenarioIds], ["reject-secret-api-key"]);
});

// ---------------------------------------------------------------------------
// 9. All-scenarios gate + confusion matrix
// ---------------------------------------------------------------------------

test("decision-policy evaluation: confusion matrix has one row per expected-action and one col per actual-action", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.ok(report.confusionMatrix.rows.length >= 1);
  assert.ok(report.confusionMatrix.cols.length >= 1);
  assert.equal(
    report.confusionMatrix.matrix.length,
    report.confusionMatrix.rows.length,
    "matrix row count must equal rows label count"
  );
  for (const row of report.confusionMatrix.matrix) {
    assert.equal(row.length, report.confusionMatrix.cols.length);
  }
  // The action vocabulary labels should all appear in the
  // matrix (rows + cols) because the v2 set exercises the
  // full action vocabulary.
  for (const a of REMEMBER_DECISION_ACTIONS) {
    const hasInRows = report.confusionMatrix.rows.includes(a);
    const hasInCols = report.confusionMatrix.cols.includes(a);
    assert.ok(hasInRows || hasInCols, `confusion matrix must surface ${a} in rows or cols`);
  }
  // The total count summed across the matrix equals the
  // total scenario count (every scenario contributes to
  // exactly one cell of the confusion matrix).
  const totalInMatrix = report.confusionMatrix.matrix.flat().reduce((s, c) => s + c, 0);
  assert.equal(totalInMatrix, report.meta.scenarioCount);
});

test("decision-policy evaluation: per-action / per-reason accuracy is well-formed", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(report.perActionAccuracy.length, REMEMBER_DECISION_ACTIONS.length);
  assert.equal(report.perReasonAccuracy.length, REMEMBER_DECISION_REASONS.length);
  for (const row of report.perActionAccuracy) {
    assert.ok(row.expectedCount >= 0);
    assert.ok(row.matchedCount >= 0);
    if (row.expectedCount === 0) assert.equal(row.accuracy, null);
    if (row.accuracy !== null) {
      assert.ok(row.accuracy >= 0 && row.accuracy <= 1);
    }
  }
  for (const row of report.perReasonAccuracy) {
    assert.ok(row.expectedCount >= 0);
    assert.ok(row.matchedCount >= 0);
    if (row.expectedCount === 0) assert.equal(row.accuracy, null);
    if (row.accuracy !== null) {
      assert.ok(row.accuracy >= 0 && row.accuracy <= 1);
    }
  }
});

test("decision-policy evaluation: gates block distinguishes safety-privacy from all-scenarios", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(
    report.gates.overallPassed,
    report.gates.safetyPrivacyPassed && report.gates.allScenariosPassed
  );
  assert.ok(report.gates.summary.includes("safety-privacy gate"));
  assert.ok(report.gates.summary.includes("all-scenarios gate"));
});

// ---------------------------------------------------------------------------
// 10. Determinism: repeated runs produce byte-equal captured decisions
// ---------------------------------------------------------------------------

test("decision-policy evaluation: repeated runs produce byte-equal captured decisions", async () => {
  const r1 = await runDecisionPolicyEvaluation();
  const r2 = await runDecisionPolicyEvaluation();
  assert.equal(r1.runs.length, r2.runs.length);
  for (let i = 0; i < r1.runs.length; i += 1) {
    const a = r1.runs[i]!;
    const b = r2.runs[i]!;
    assert.equal(a.scenarioId, b.scenarioId);
    assert.equal(a.adapterOk, b.adapterOk);
    assert.equal(a.action, b.action);
    assert.equal(a.reason, b.reason);
    assert.deepEqual([...(a.supersededIds ?? [])], [...(b.supersededIds ?? [])]);
    assert.deepEqual([...(a.conflictsWithIds ?? [])], [...(b.conflictsWithIds ?? [])]);
    assert.deepEqual([...(a.redundantWithIds ?? [])], [...(b.redundantWithIds ?? [])]);
    assert.equal(a.httpCalls, b.httpCalls);
    if (a.confidence !== undefined && b.confidence !== undefined) {
      assert.equal(a.confidence, b.confidence);
    }
  }
  // The histogram counts must be deterministic too.
  assert.deepEqual(
    r1.actionHistogram.map((h) => h.count),
    r2.actionHistogram.map((h) => h.count)
  );
});

// ---------------------------------------------------------------------------
// 11. No-network: the scripted fetch is the only path
// ---------------------------------------------------------------------------

test("decision-policy evaluation: the harness never makes a real network call", async () => {
  // The harness wires a scripted fetch into the adapter's
  // `DecisionAdapterOptions.fetchImpl` seam. The fetch
  // returns canned responses in-process; the harness never
  // reaches a real provider URL. The per-scenario httpCalls
  // count is the sum of scripted-call counts summed
  // across all scenarios.
  const report = await runDecisionPolicyEvaluation();
  // The expected per-scenario call counts are:
  //   - 17 scenarios with a primary-only valid response: 1 call each
  //   - 1 scenario (repair-recovers) with primary invalid +
  //     primary repair valid: 2 calls
  //   - 1 scenario (primary-hard-failure-no-fallback) with
  //     primary 5xx (no repair on hard failure; no fallback
  //     configured): 1 call
  //   - 1 scenario (fallback-recovery-after-primary-failure)
  //     with primary 5xx + fallback first success: 2 calls
  //   - 1 scenario (always-invalid-provider-output) with all
  //     four calls: 4 calls
  //   - 1 scenario (invalid-output-after-repair-still-invalid)
  //     with primary first + repair (no fallback): 2 calls
  //   - 1 scenario (D7 false-supersession-trap) primary-only: 1 call
  //   - 1 scenario (D8 false-conflict-trap) primary-only: 1 call
  // Total: 17 + 2 + 1 + 2 + 4 + 2 + 1 + 1 = 30
  // Plus D1 store-with-irrelevant-high-ranked-memory (1 call).
  // Let me just compute it: scenarios in v2 = 26
  //   - 22 with 1 call each: 22
  //   - 1 with 2 calls (repair-recovers): 2
  //   - 1 with 1 call (primary-hard-failure-no-fallback): 1
  //   - 1 with 2 calls (fallback-recovery): 2
  //   - 1 with 4 calls (always-invalid): 4
  //   - 1 with 2 calls (invalid-output-after-repair): 2
  //   - 1 with 1 call (false-supersession-trap): 1
  //   - 1 with 1 call (false-conflict-trap): 1
  // Total scenarios: 22 + 1 + 1 + 1 + 1 + 1 = 27 (off by 1)
  // Let me count directly from the run results.
  const actualTotal = report.runs.reduce((s, r) => s + r.httpCalls, 0);
  assert.equal(report.meta.totalHttpCalls, actualTotal);
  assert.equal(
    report.meta.totalHttpCalls,
    BUILT_IN_DECISION_POLICY_SCENARIOS.reduce((s, sc) => {
      const exp = sc.expect.httpCalls ?? 1;
      return s + exp;
    }, 0),
    `total http calls should equal sum of expected per-scenario httpCalls`
  );
});

// ---------------------------------------------------------------------------
// 12. Report shape (v2)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: report shape is well-formed (v2 metrics + gates + categories)", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(typeof report.generatedAt, "string");
  assert.ok(report.generatedAt.length > 0);
  // Scenario-set version stamp.
  assert.equal(report.scenarioSetVersion, DECISION_POLICY_SCENARIO_SET_VERSION);
  // Meta block.
  assert.equal(typeof report.meta.scenarioCount, "number");
  assert.equal(typeof report.meta.passedCount, "number");
  assert.equal(typeof report.meta.failedCount, "number");
  assert.equal(typeof report.meta.adapterOkCount, "number");
  assert.equal(typeof report.meta.adapterFailedCount, "number");
  assert.equal(typeof report.meta.totalHttpCalls, "number");
  assert.equal(typeof report.meta.scenariosWithTargetMemoryMatchExpectation, "number");
  assert.equal(typeof report.meta.targetMemoryMatchPassCount, "number");
  assert.equal(typeof report.meta.safetyCriticalCount, "number");
  assert.equal(typeof report.meta.safetyCriticalPassedCount, "number");
  // Per-category summary covers every canonical category.
  assert.equal(report.categories.length, DECISION_POLICY_SCENARIO_CATEGORIES.length);
  for (const c of report.categories) {
    assert.ok(DECISION_POLICY_SCENARIO_CATEGORIES.includes(c.category));
    assert.equal(typeof c.totalScenarios, "number");
    assert.equal(typeof c.passed, "number");
    assert.equal(typeof c.failed, "number");
    assert.equal(typeof c.safetyCriticalTotal, "number");
    assert.equal(typeof c.safetyCriticalPassed, "number");
    assert.equal(typeof c.safetyCriticalFailed, "number");
    assert.equal(c.totalScenarios, c.passed + c.failed);
    assert.equal(c.safetyCriticalTotal, c.safetyCriticalPassed + c.safetyCriticalFailed);
  }
  // Histograms.
  assert.equal(report.actionHistogram.length, REMEMBER_DECISION_ACTIONS.length);
  assert.equal(report.reasonHistogram.length, REMEMBER_DECISION_REASONS.length);
  // Per-action / per-reason accuracy.
  assert.equal(report.perActionAccuracy.length, REMEMBER_DECISION_ACTIONS.length);
  assert.equal(report.perReasonAccuracy.length, REMEMBER_DECISION_REASONS.length);
  // Confusion matrix shape.
  assert.ok(Array.isArray(report.confusionMatrix.rows));
  assert.ok(Array.isArray(report.confusionMatrix.cols));
  assert.ok(Array.isArray(report.confusionMatrix.matrix));
  // Target-memory match shape.
  assert.equal(typeof report.targetMemoryMatch.aggregateJaccard, "number");
  assert.equal(typeof report.targetMemoryMatch.aggregateIoU, "number");
  assert.equal(typeof report.targetMemoryMatch.scenariosWithExpectedIds, "number");
  assert.equal(typeof report.targetMemoryMatch.perfectMatches, "number");
  assert.ok(Array.isArray(report.targetMemoryMatch.perScenario));
  assert.ok(Array.isArray(report.targetMemoryMatch.perCategory));
  // Confidence buckets.
  for (const v of Object.values(report.confidenceBuckets)) {
    assert.equal(typeof v, "number");
    assert.ok(v >= 0);
  }
  // Provider-call stats.
  for (const v of Object.values(report.providerCallStats)) {
    assert.equal(typeof v, "number");
    assert.ok(v >= 0);
  }
  // Safety-privacy gate.
  assert.equal(typeof report.safetyPrivacyGate.safetyCriticalCount, "number");
  assert.equal(typeof report.safetyPrivacyGate.safetyCriticalPassed, "number");
  assert.equal(typeof report.safetyPrivacyGate.safetyCriticalFailed, "number");
  assert.equal(typeof report.safetyPrivacyGate.passed, "boolean");
  assert.ok(Array.isArray(report.safetyPrivacyGate.failedScenarioIds));
  // Gates block.
  assert.equal(typeof report.gates.safetyPrivacyPassed, "boolean");
  assert.equal(typeof report.gates.allScenariosPassed, "boolean");
  assert.equal(typeof report.gates.overallPassed, "boolean");
  assert.ok(Array.isArray(report.gates.safetyPrivacyFailedScenarioIds));
  assert.ok(Array.isArray(report.gates.allFailedScenarioIds));
  assert.equal(typeof report.gates.summary, "string");
  // Runs are well-formed.
  for (const r of report.runs) {
    assert.equal(typeof r.scenarioId, "string");
    assert.equal(typeof r.label, "string");
    assert.equal(typeof r.description, "string");
    assert.equal(typeof r.rawInput, "string");
    assert.equal(typeof r.safetyClass, "string");
    assert.equal(typeof r.relatedCount, "number");
    assert.equal(typeof r.httpCalls, "number");
    assert.equal(typeof r.repairAttempted, "boolean");
    assert.equal(typeof r.fallbackAttempted, "boolean");
    assert.equal(typeof r.adapterOk, "boolean");
    assert.ok(Array.isArray(r.assertions));
    assert.equal(typeof r.pass, "boolean");
    // v2 fields.
    assert.ok(DECISION_POLICY_SCENARIO_CATEGORIES.includes(r.category));
    assert.equal(typeof r.safetyCritical, "boolean");
    assert.ok(r.capturedTargetIds !== undefined);
    assert.ok(r.targetMemoryJaccard === null || typeof r.targetMemoryJaccard === "number");
    // Per-run provider-call inference:
    //   - `repairAttempted` is true iff the scripted fetch saw a
    //     primary-repair call (the path can also be reached via
    //     fallback-first when primary hard-fails; the per-scenario
    //     Jaccard shows up here). httpCalls >= 2 is a necessary but
    //     NOT sufficient condition for `repairAttempted = true`
    //     (e.g. primary 5xx + fallback success = httpCalls 2 +
    //     repairAttempted = false).
    //   - `fallbackAttempted` is true iff any fallback call was
    //     invoked. Sufficient: httpCalls >= 3 ⇒ fallbackAttempted.
    if (r.httpCalls >= 3) {
      assert.equal(r.fallbackAttempted, true, `r.httpCalls >= 3 implies fallbackAttempted`);
    }
    // Symmetric: every `fallbackAttempted` scenario has at least
    // the primary first call plus its own fallback first call, so
    // httpCalls >= 2.
    if (r.fallbackAttempted) {
      assert.ok(r.httpCalls >= 2, `fallbackAttempted implies httpCalls >= 2 (got ${r.httpCalls})`);
    }
    // For successful runs, the success-only fields are present.
    if (r.adapterOk) {
      assert.ok(r.action !== undefined);
      assert.ok(r.reason !== undefined);
      assert.ok(r.confidence !== undefined);
      assert.ok(r.providerUsed !== undefined);
      assert.equal(typeof r.fallbackUsed, "boolean");
    } else {
      assert.ok(r.failureKind !== undefined);
    }
  }
  // Limitations block is non-empty.
  assert.ok(Array.isArray(report.limitations));
  assert.ok(report.limitations.length >= 5);
  for (const lim of report.limitations) {
    assert.equal(typeof lim, "string");
    assert.ok(lim.length > 0);
  }
});

test("decision-policy evaluation: limitations block surfaces the no-network / adapter-driven / public-API caveats", () => {
  const text = DECISION_POLICY_EVALUATION_LIMITATIONS.join("\n");
  assert.match(text, /no-network/i);
  assert.match(text, /adapter-driven/i);
  assert.match(text, /public mcp api|public.*api|tool schema/i);
  assert.match(text, /benchmark-only|research-only/i);
  assert.match(text, /frozen scenario/i);
  assert.match(text, /v2/i, "limitations block surfaces the v2 scenario-set version");
});

test("decision-policy evaluation: human report is non-empty and surfaces the expected sections", async () => {
  const report = await runDecisionPolicyEvaluation();
  const text = formatDecisionPolicyEvaluationReport(report);
  assert.ok(text.length > 0);
  assert.match(text, /=== curion decision-policy evaluation ===/);
  assert.match(text, /--- meta ---/);
  assert.match(text, /--- gates ---/);
  assert.match(text, /--- categories ---/);
  assert.match(text, /--- action histogram ---/);
  assert.match(text, /--- reason histogram ---/);
  assert.match(text, /--- per-action accuracy ---/);
  assert.match(text, /--- per-reason accuracy ---/);
  assert.match(text, /--- confusion matrix/);
  assert.match(text, /--- target-memory match/);
  assert.match(text, /--- confidence buckets ---/);
  assert.match(text, /--- provider call stats ---/);
  assert.match(text, /--- safety \/ privacy gate ---/);
  assert.match(text, /READ THIS FIRST/);
  assert.match(text, /--- per-scenario summary ---/);
  assert.match(text, /--- limitations \(research-only\) ---/);
  // Scenario-set version stamp is on the human report.
  assert.match(text, new RegExp(`scenario set version: ${DECISION_POLICY_SCENARIO_SET_VERSION}`));
  // Per-scenario sections are present.
  for (const r of report.runs) {
    assert.match(text, new RegExp(`--- scenario: ${r.scenarioId}`));
  }
});

// ---------------------------------------------------------------------------
// 13. CLI parser
// ---------------------------------------------------------------------------

test("decision-policy evaluation: CLI parser accepts --artifacts, --no-write, --no-stdout and rejects unknown flags", () => {
  const parsed = parseDecisionPolicyEvaluationCli(["--artifacts", "/tmp/foo"]);
  assert.equal(parsed.artifactsDir, "/tmp/foo");
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);

  const parsedNoWrite = parseDecisionPolicyEvaluationCli(["--no-write"]);
  assert.equal(parsedNoWrite.noWrite, true);

  const parsedNoStdout = parseDecisionPolicyEvaluationCli(["--no-stdout"]);
  assert.equal(parsedNoStdout.noStdout, true);

  assert.throws(
    () => parseDecisionPolicyEvaluationCli(["--unknown-flag"]),
    /unknown decision-policy evaluation cli flag/
  );
});

test("decision-policy evaluation: CLI parser with no args uses a safe default", () => {
  const parsed = parseDecisionPolicyEvaluationCli([]);
  assert.ok(parsed.artifactsDir.endsWith(".curion/benchmark"));
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);
});

// ---------------------------------------------------------------------------
// 14. Artifact writer
// ---------------------------------------------------------------------------

test("decision-policy evaluation: writeDecisionPolicyEvaluationReport writes a well-formed artifact with the documented prefix", async () => {
  const report = await runDecisionPolicyEvaluation();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-test-"));
  try {
    const file = writeDecisionPolicyEvaluationReport(report, tmp);
    assert.ok(fs.existsSync(file), "artifact file must be written");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // The shape is the same as the in-memory report.
    assert.equal(parsed.meta.scenarioCount, report.meta.scenarioCount);
    assert.equal(parsed.runs.length, report.runs.length);
    assert.equal(parsed.actionHistogram.length, report.actionHistogram.length);
    assert.equal(parsed.reasonHistogram.length, report.reasonHistogram.length);
    // v2 fields on the artifact.
    assert.equal(parsed.scenarioSetVersion, DECISION_POLICY_SCENARIO_SET_VERSION);
    assert.equal(parsed.categories.length, report.categories.length);
    assert.equal(parsed.confusionMatrix.matrix.length, report.confusionMatrix.matrix.length);
    // The filename uses the documented prefix.
    assert.match(path.basename(file), /^decision-policy-evaluation-/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("decision-policy evaluation: writeDecisionPolicyEvaluationReport creates the target directory if missing", async () => {
  const report = await runDecisionPolicyEvaluation();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-parent-"));
  try {
    const dir = path.join(parent, "nested", "benchmark");
    const file = writeDecisionPolicyEvaluationReport(report, dir);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 15. Public API guard
// ---------------------------------------------------------------------------

test("decision-policy evaluation: the public MCP tool surface is unchanged", () => {
  // The harness evaluates the decision adapter directly with
  // a scripted fetch. It does NOT add a new public MCP tool,
  // resource, or input schema. We assert by checking the
  // canonical `PUBLIC_TOOL_NAMES` constant.
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

test("decision-policy evaluation: the harness does not modify the controller's public options surface", async () => {
  // The harness wires the scripted fetch through the
  // `DecisionAdapterOptions.fetchImpl` slot (a test-only
  // seam that mirrors the controller's
  // `decisionProviderFetchImpl` option). The harness must
  // NOT touch the public `remember` MCP tool surface.
  const toolSource = fs.readFileSync(new URL("../src/tools/remember.ts", import.meta.url), "utf8");
  // The tool source must not pass the test-only
  // `decisionProviderFetchImpl` option. A future reviewer
  // who tries to expose the option on the wire is stopped
  // here.
  assert.ok(
    !toolSource.includes("decisionProviderFetchImpl"),
    `src/tools/remember.ts must not reference the test-only 'decisionProviderFetchImpl' option`
  );
});

// ---------------------------------------------------------------------------
// 16. Built-in scenario set integrity (v2)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: BUILT_IN_DECISION_POLICY_SCENARIOS has unique ids and covers the brief's required axes", () => {
  const ids = BUILT_IN_DECISION_POLICY_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
  // The brief required the v1 sanity axes; the v2 set must
  // still cover them. We assert on a representative subset.
  const requiredV1 = [
    "store-new",
    "supersede-pair",
    "invalidate-candidate",
    "flag-conflict",
    "flag-redundant",
    "reject-vague",
    "clarify-ambiguous",
    "no-op-low-value",
    "repair-recovers",
    "primary-hard-failure-no-fallback",
  ];
  for (const id of requiredV1) {
    assert.ok(
      ids.includes(id),
      `BUILT_IN_DECISION_POLICY_SCENARIOS must include scenario id '${id}'`
    );
  }
  // v2 added categories. We assert at least one new scenario
  // per added category.
  const v2Ids = [
    // safety-privacy (any 1+)
    "redact-sensitive-content",
    // lifecycle-time (any 1+)
    "supersede-temporal-replacement",
    // robustness-traps extras (any 1+)
    "fallback-recovery-after-primary-failure",
    "always-invalid-provider-output",
    "false-supersession-trap",
    "false-conflict-trap",
    "invalid-output-after-repair-still-invalid",
  ];
  for (const id of v2Ids) {
    assert.ok(ids.includes(id), `v2 BUILT_IN_DECISION_POLICY_SCENARIOS must include '${id}'`);
  }
  // Every category must be exercised.
  for (const cat of DECISION_POLICY_SCENARIO_CATEGORIES) {
    assert.ok(
      BUILT_IN_DECISION_POLICY_SCENARIOS.some((s) => s.category === cat),
      `v2 set must include at least one scenario in category '${cat}'`
    );
  }
  // Every scenario must have a category.
  for (const s of BUILT_IN_DECISION_POLICY_SCENARIOS) {
    assert.ok(
      DECISION_POLICY_SCENARIO_CATEGORIES.includes(s.category),
      `scenario '${s.id}' uses unknown category '${s.category}'`
    );
  }
});

test("decision-policy evaluation: BUILT_IN_DECISION_POLICY_SCENARIOS only uses known SafetyClass values", () => {
  // The `safetyClass` field is typed against the classifier's
  // `SafetyClass` enum.
  const knownClasses = new Set([
    "safe",
    "secret",
    "raw-dump",
    "vague-junk",
    "mixed-safe-sensitive",
    "prompt-injection",
    "unsafe-preference",
    "self-conflict",
    "vague-memory",
    "replacement-correction",
  ]);
  for (const s of BUILT_IN_DECISION_POLICY_SCENARIOS) {
    assert.ok(
      knownClasses.has(s.safetyClass),
      `scenario '${s.id}' uses unknown safetyClass '${s.safetyClass}'`
    );
  }
});

test("decision-policy evaluation: BUILT_IN_DECISION_POLICY_SCENARIOS has at least one safety-critical scenario", () => {
  // The v2 set must drive the safety-privacy gate.
  const safetyCount = BUILT_IN_DECISION_POLICY_SCENARIOS.filter(
    (s) => s.safetyCritical ?? s.category === "safety-privacy"
  ).length;
  assert.ok(
    safetyCount >= 5,
    `v2 set must include at least 5 safety-critical scenarios, got ${safetyCount}`
  );
});

test("decision-policy evaluation: scenario set version stamp is exposed", () => {
  assert.equal(typeof DECISION_POLICY_SCENARIO_SET_VERSION, "string");
  assert.match(DECISION_POLICY_SCENARIO_SET_VERSION, /^v\d+$/);
});

// ---------------------------------------------------------------------------
// 17. Decision-adapter call shape: per-scenario captured fields (v2)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: per-scenario captured fields include the expected action / reason / confidence / id arrays", async () => {
  const report = await runDecisionPolicyEvaluation();
  const supersede = report.runs.find((r) => r.scenarioId === "supersede-pair");
  assert.ok(supersede);
  assert.equal(supersede.action, "supersede");
  assert.equal(supersede.reason, "explicit_replacement");
  assert.ok((supersede.confidence ?? 0) >= 0.5);
  assert.ok((supersede.supersededIds ?? []).includes(7));
  // v2: a failing scenario carries a `failureKind` and no `action`.
  const failure = report.runs.find((r) => r.scenarioId === "primary-hard-failure-no-fallback");
  assert.ok(failure);
  assert.equal(failure.adapterOk, false);
  assert.equal(failure.failureKind, "all-providers-failed");
  assert.equal(failure.action, undefined);
});

// ---------------------------------------------------------------------------
// 18. Live-mode opt-in gating (impossible-to-run-accidentally safety)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: scripted default carries evaluationMode='scripted' and no `live` metadata block", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(report.evaluationMode, "scripted");
  assert.equal(report.live, undefined);
  // The scripted human report surfaces the mode label so a
  // reviewer reading the artifact on disk sees the mode at a
  // glance.
  const text = formatDecisionPolicyEvaluationReport(report);
  assert.match(text, /evaluation mode:\s+scripted/);
  // Live-mode metadata block is absent in the scripted
  // report (a reviewer who sees it present is looking at a
  // live artifact).
  assert.ok(!text.includes("live-mode metadata"));
  // The limitations block still carries the no-network
  // research-only disclosure.
  assert.ok(DECISION_POLICY_EVALUATION_LIMITATIONS.some((l) => l.startsWith("No-network")));
});

test("decision-policy evaluation: live mode requires BOTH opt-in signals (env + CLI) and refuses to run otherwise", async () => {
  // 1. mode: 'live' without env flag → throws.
  await assert.rejects(
    () =>
      runDecisionPolicyEvaluation({
        mode: "live",
        envOptInFlag: false,
        cliArgs: ["--live"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LiveOptInRequiredError);
      assert.match((err as Error).message, /env CURION_DECISION_EVAL_LIVE=1/);
      return true;
    }
  );
  // 2. mode: 'live' without CLI flag → throws.
  await assert.rejects(
    () =>
      runDecisionPolicyEvaluation({
        mode: "live",
        envOptInFlag: true,
        cliArgs: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LiveOptInRequiredError);
      assert.match((err as Error).message, /CLI --live flag/);
      return true;
    }
  );
  // 3. mode: 'live' with neither signal → throws.
  await assert.rejects(
    () =>
      runDecisionPolicyEvaluation({
        mode: "live",
        envOptInFlag: false,
        cliArgs: [],
      }),
    (err: unknown) => {
      assert.ok(err instanceof LiveOptInRequiredError);
      return true;
    }
  );
});

test("decision-policy evaluation: scripted mode ignores the env opt-in flag (env alone does NOT enable live mode)", async () => {
  // Env flag set without an explicit mode: 'live' arg must
  // remain scripted. The function defaults to scripted mode
  // when `mode` is omitted.
  const report = await runDecisionPolicyEvaluation({
    envOptInFlag: true,
    cliArgs: [],
  });
  assert.equal(report.evaluationMode, "scripted");
  assert.equal(report.live, undefined);
});

test("decision-policy evaluation: isLiveOptInEnv only treats exact '1' as opt-in (truthy strings do NOT enable live mode)", () => {
  // Only the exact string "1" enables live mode. "true",
  // "yes", "on", "Y", "TRUE" are all rejected so an
  // accidentally-set boolean env var cannot enable live
  // mode by surprise.
  assert.equal(isLiveOptInEnv({ [DECISION_POLICY_EVAL_LIVE_ENV]: "1" }), true);
  assert.equal(isLiveOptInEnv({ [DECISION_POLICY_EVAL_LIVE_ENV]: "true" }), false);
  assert.equal(isLiveOptInEnv({ [DECISION_POLICY_EVAL_LIVE_ENV]: "TRUE" }), false);
  assert.equal(isLiveOptInEnv({ [DECISION_POLICY_EVAL_LIVE_ENV]: "yes" }), false);
  assert.equal(isLiveOptInEnv({ [DECISION_POLICY_EVAL_LIVE_ENV]: "on" }), false);
  assert.equal(isLiveOptInEnv({ [DECISION_POLICY_EVAL_LIVE_ENV]: "" }), false);
  assert.equal(isLiveOptInEnv({}), false);
});

test("decision-policy evaluation: CLI parser accepts --live (opt-in) and reports live: true", () => {
  const parsed = parseDecisionPolicyEvaluationCli(["--live"]);
  assert.equal(parsed.live, true);
  // The other flags remain unaffected.
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);
  assert.ok(parsed.artifactsDir.endsWith(".curion/benchmark"));
});

test("decision-policy evaluation: CLI parser without --live reports live: false", () => {
  const parsed = parseDecisionPolicyEvaluationCli(["--no-write"]);
  assert.equal(parsed.live, false);
});

test("decision-policy evaluation: shared benchmark CLI helper rejects --live by default (opt-in only)", () => {
  // The shared helper defaults to `supportLive: false`. A
  // benchmark runner that does NOT opt in (e.g. the
  // adaptive-depth runner) refuses the flag with a clear
  // "unknown <contextLabel> cli flag" error.
  assert.throws(
    () => parseBenchmarkArtifactCli(["--live"]),
    /unknown benchmark cli flag: "--live"/
  );
});

test("decision-policy evaluation: live mode runs against the real adapter with no `fetchImpl` override and never echoes API keys on the artifact", async () => {
  // We mock the global fetch so the live path exercises
  // the real adapter code path end-to-end (real prompt
  // build → real http client → real response parse) without
  // making a network call. The stub returns the canonical
  // OpenAI-compatible 200 response shape with a valid
  // remember-policy decision payload for every call.
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  let callIndex = 0;
  const cannedResponses = [
    // Primary first.
    JSON.stringify({
      id: "x",
      model: "live/test-model",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '```json\n{"action":"store","reason":"novel","supersededIds":[],"conflictsWithIds":[],"redundantWithIds":[],"confidence":0.85}\n```',
          },
        },
      ],
    }),
    // Primary repair (in case the first was unparsable; the
    // canned primary is already valid so this is never
    // reached, but the live counter wrapper still
    // attributes calls so we leave a fallback canned
    // response ready).
    JSON.stringify({
      id: "x",
      model: "live/test-model",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '```json\n{"action":"store","reason":"novel","supersededIds":[],"conflictsWithIds":[],"redundantWithIds":[],"confidence":0.85}\n```',
          },
        },
      ],
    }),
  ];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body = init && "body" in init ? String(init.body) : "";
    calls.push({ url, body });
    const idx = Math.min(callIndex, cannedResponses.length - 1);
    callIndex += 1;
    return new Response(cannedResponses[idx], {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  // Save and override env so the live `loadDecisionAdapterConfig`
  // resolves to a fake but valid provider config. We never
  // put a real key in the env — the stub just needs the
  // config to be present so the adapter does NOT short-circuit
  // on `missing-config`.
  const savedEnv = { ...process.env };
  process.env[DECISION_POLICY_EVAL_LIVE_ENV] = "1";
  process.env.CURION_PRIMARY_BASE_URL = "https://api.live-example.test/v1";
  process.env.CURION_PRIMARY_MODEL = "live/test-model";
  process.env.CURION_PRIMARY_API_KEY = "sk-test-live-stub-not-real-zzzzz";
  process.env.CURION_PRIMARY_API_FORMAT = "openai-compatible";
  process.env.CURION_ADAPTER_TIMEOUT_MS = "5000";
  process.env.CURION_ADAPTER_MAX_TOKENS = "256";
  try {
    // Restrict to a single tiny scenario so the test runs
    // quickly. We use a custom inline scenario rather than
    // `BUILT_IN_DECISION_POLICY_SCENARIOS` so the test does
    // not depend on the v2 scenario count.
    const scenario = BUILT_IN_DECISION_POLICY_SCENARIOS[0]!;
    const report = await runDecisionPolicyEvaluation({
      scenarios: [scenario],
      mode: "live",
      envOptInFlag: true,
      cliArgs: ["--live"],
    });
    // Mode label is on the report.
    assert.equal(report.evaluationMode, "live");
    assert.ok(report.live, "live metadata block must be present in live mode");
    // Live metadata block is well-formed and carries the
    // env + cli opt-in evidence WITHOUT any API key value.
    assert.equal(report.live.optInEnvPresent, true);
    assert.deepEqual([...report.live.optInCliArgs], ["--live"]);
    assert.equal(
      report.live.providerConfigSnapshot.primaryBaseUrl,
      "https://api.live-example.test/v1"
    );
    assert.equal(report.live.providerConfigSnapshot.primaryModel, "live/test-model");
    assert.equal(report.live.providerConfigSnapshot.hasPrimaryApiKey, true);
    assert.equal(report.live.providerConfigSnapshot.hasFallbackApiKey, false);
    // The apiFormat / timeout / maxTokens reflect the env
    // values verbatim.
    assert.equal(report.live.providerConfigSnapshot.primaryApiFormat, "openai-compatible");
    assert.equal(report.live.providerConfigSnapshot.timeoutMs, 5000);
    assert.equal(report.live.providerConfigSnapshot.maxTokens, 256);
    // No API key string ever appears on the artifact. We
    // JSON-stringify the live block and assert the fake
    // key token is NOT present.
    const serialized = JSON.stringify(report.live);
    assert.ok(
      !serialized.includes("sk-test-live-stub-not-real-zzzzz"),
      `live metadata block must NOT echo the API key value; got: ${serialized}`
    );
    assert.ok(
      !/(api[_-]?key|apiKey)/i.test(serialized) ||
        /hasPrimaryApiKey|hasFallbackApiKey/.test(serialized),
      `live block must only mention API keys via the boolean presence flags`
    );
    // The block carries the reviewer-must-read warnings.
    assert.deepEqual([...report.live.warnings], [...DECISION_POLICY_EVALUATION_LIVE_WARNINGS]);
    // The stubbed global fetch was invoked at least once
    // (the live path actually called out via `globalThis.fetch`).
    assert.ok(
      calls.length >= 1,
      `live mode must invoke globalThis.fetch; got ${calls.length} calls`
    );
    // The URL the adapter called matched the env-provided
    // base URL.
    assert.ok(
      calls.every((c) => c.url.startsWith("https://api.live-example.test/v1")),
      `every live call should target the env-configured base URL; got: ${calls.map((c) => c.url).join(", ")}`
    );
    // The adapter parsed the canned response into a valid
    // structured decision.
    const run = report.runs[0]!;
    assert.equal(run.adapterOk, true);
    assert.equal(run.action, "store");
    assert.equal(run.reason, "novel");
    assert.equal(run.providerUsed, "custom");
    assert.equal(run.modelUsed, "live/test-model");
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
  }
});

test("decision-policy evaluation: live-mode report's human formatter surfaces the reviewer-must-read-first block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "x",
        model: "live/test-model",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                '```json\n{"action":"store","reason":"novel","supersededIds":[],"conflictsWithIds":[],"redundantWithIds":[],"confidence":0.9}\n```',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const savedEnv = { ...process.env };
  process.env[DECISION_POLICY_EVAL_LIVE_ENV] = "1";
  process.env.CURION_PRIMARY_BASE_URL = "https://api.live-example.test/v1";
  process.env.CURION_PRIMARY_MODEL = "live/test-model";
  process.env.CURION_PRIMARY_API_KEY = "sk-test-live-stub-not-real-zzzzz";
  try {
    const scenario = BUILT_IN_DECISION_POLICY_SCENARIOS[0]!;
    const report = await runDecisionPolicyEvaluation({
      scenarios: [scenario],
      mode: "live",
      envOptInFlag: true,
      cliArgs: ["--live"],
    });
    const text = formatDecisionPolicyEvaluationReport(report);
    assert.match(text, /evaluation mode:\s+live/);
    assert.match(text, /live-mode metadata \(reviewer MUST read this first\)/);
    assert.match(text, /opt-in env flag present:\s+true/);
    assert.match(text, /opt-in CLI args:\s+--live/);
    // The provider snapshot surfaces the config WITHOUT keys.
    assert.match(text, /baseUrl=https:\/\/api\.live-example\.test\/v1/);
    assert.match(text, /keyPresent=true/);
    // Warnings block surfaces the live-mode caveats.
    assert.match(text, /warnings \(live mode\):/);
    assert.match(text, /LIVE MODE/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
  }
});

test("decision-policy evaluation: scripted mode remains the default (no env mutation needed) and never invokes globalThis.fetch", async () => {
  // Mutate globalThis.fetch so any unexpected call from the
  // scripted path would throw — the harness must NEVER
  // touch the global fetch.
  const originalFetch = globalThis.fetch;
  let realFetchCalls = 0;
  globalThis.fetch = (async () => {
    realFetchCalls += 1;
    throw new Error("scripted mode must not invoke globalThis.fetch");
  }) as typeof fetch;
  try {
    // Force-clear the live opt-in env var so any leakage
    // from a previous test cannot accidentally enable live
    // mode in this one. The runner is pure: scripted is the
    // default.
    const savedEnv = process.env[DECISION_POLICY_EVAL_LIVE_ENV];
    delete process.env[DECISION_POLICY_EVAL_LIVE_ENV];
    try {
      const report = await runDecisionPolicyEvaluation();
      assert.equal(report.evaluationMode, "scripted");
      assert.equal(report.live, undefined);
      assert.equal(realFetchCalls, 0);
    } finally {
      if (savedEnv !== undefined) process.env[DECISION_POLICY_EVAL_LIVE_ENV] = savedEnv;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decision-policy evaluation: live metadata block is absent from scripted artifacts (byte-equal to v2 baseline except for the mode label)", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(report.evaluationMode, "scripted");
  assert.equal("live" in report, false, "scripted artifact must not carry a `live` key");
  // Round-tripping through the artifact writer must produce
  // the same shape: the live block is absent in the
  // serialized JSON.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-live-absent-"));
  try {
    const file = writeDecisionPolicyEvaluationReport(report, tmp);
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.evaluationMode, "scripted");
    assert.equal(parsed.live, undefined);
    assert.equal("live" in parsed, false, "scripted JSON artifact must not carry a `live` key");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 19. Env-loading integration: `.env` populates provider config before
//     mode resolution without weakening the double opt-in.
// ---------------------------------------------------------------------------
//
// These tests pin the integration between the runner's env-loading
// helper and the live-mode provider config resolver. They do NOT
// touch the real local `.env` (the helper accepts a `path` override
// for testability and `loadDotEnv` accepts a `skip` escape hatch).
// No real API keys are written or read; all fixture values are
// synthetic and labelled as such so a reviewer can grep for them
// if they ever leak into a log.

test("decision-policy evaluation: prepareDecisionPolicyEvaluationEnv returns key NAMES (never values) and reports load status", () => {
  // The helper is the public, testable seam between the runner
  // and `loadDotEnv`. It returns the path attempted, whether the
  // file was parsed, the list of keys that were set, and the
  // list of keys that were skipped because they were already
  // present in process.env. No VALUES are exposed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-envprep-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(
    envFile,
    [
      "# Test-only fixture for env-loader integration.",
      "CURION_PRIMARY_BASE_URL=https://api.envprep-test.test/v1",
      "CURION_PRIMARY_MODEL=envprep/test-model",
      "# Fake key — value must NOT appear in helper return value.",
      "CURION_PRIMARY_API_KEY=sk-test-envprep-FAKE-KEY-DO-NOT-USE-zzzzz",
      "CURION_PRIMARY_API_FORMAT=openai-compatible",
      "CURION_DECISION_EVAL_LIVE=1",
    ].join("\n")
  );
  const savedEnv = { ...process.env };
  for (const k of [
    "CURION_PRIMARY_BASE_URL",
    "CURION_PRIMARY_MODEL",
    "CURION_PRIMARY_API_KEY",
    "CURION_PRIMARY_API_FORMAT",
    "CURION_DECISION_EVAL_LIVE",
  ]) {
    delete process.env[k];
  }
  try {
    const result = prepareDecisionPolicyEvaluationEnv({ path: envFile });
    assert.equal(result.loaded, true);
    assert.equal(result.path, envFile);
    assert.ok(result.keyCount > 0, `expected at least one key loaded; got ${result.keyCount}`);
    // Key names only — never values.
    for (const k of result.keys) {
      assert.equal(typeof k, "string");
      assert.ok(k.length > 0);
    }
    // The fake key string MUST NOT appear anywhere in the result.
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes("sk-test-envprep-FAKE-KEY-DO-NOT-USE-zzzzz"),
      `env prep result must NOT echo the API key value; got: ${serialized}`
    );
    // The result must include the canonical env var names.
    assert.ok(result.keys.includes("CURION_PRIMARY_BASE_URL"));
    assert.ok(result.keys.includes("CURION_PRIMARY_MODEL"));
    assert.ok(result.keys.includes("CURION_PRIMARY_API_KEY"));
    assert.ok(result.keys.includes("CURION_PRIMARY_API_FORMAT"));
    assert.ok(result.keys.includes("CURION_DECISION_EVAL_LIVE"));
    // process.env was populated from the temp .env.
    assert.equal(process.env.CURION_PRIMARY_BASE_URL, "https://api.envprep-test.test/v1");
    assert.equal(process.env.CURION_PRIMARY_API_KEY, "sk-test-envprep-FAKE-KEY-DO-NOT-USE-zzzzz");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("decision-policy evaluation: env-loaded provider config is visible to live mode (keyPresent=true on the live block)", async () => {
  // The end-to-end integration: a temp .env supplies a fake
  // provider key + base URL + model. The harness, called via
  // `runDecisionPolicyEvaluation` with the env loader having
  // populated process.env, must surface the loaded values on
  // the live `providerConfigSnapshot` and report
  // `hasPrimaryApiKey: true` — without echoing the key value.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-envload-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(
    envFile,
    [
      "# Test-only fixture for env-loader live-mode integration.",
      "CURION_PRIMARY_BASE_URL=https://api.envload-test.test/v1",
      "CURION_PRIMARY_MODEL=envload/test-model",
      "CURION_PRIMARY_API_KEY=sk-test-envload-FAKE-KEY-DO-NOT-USE-yyyyy",
      "CURION_PRIMARY_API_FORMAT=openai-compatible",
      "CURION_DECISION_EVAL_LIVE=1",
    ].join("\n")
  );
  const originalFetch = globalThis.fetch;
  // Stub globalThis.fetch so the live path does NOT actually
  // call the network. The test exercises the env-loader → adapter
  // plumbing, not the network.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "x",
        model: "envload/test-model",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                '```json\n{"action":"store","reason":"novel","supersededIds":[],"conflictsWithIds":[],"redundantWithIds":[],"confidence":0.9}\n```',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const savedEnv = { ...process.env };
  for (const k of [
    "CURION_PRIMARY_BASE_URL",
    "CURION_PRIMARY_MODEL",
    "CURION_PRIMARY_API_KEY",
    "CURION_PRIMARY_API_FORMAT",
    "CURION_ADAPTER_TIMEOUT_MS",
    "CURION_ADAPTER_MAX_TOKENS",
    "CURION_DECISION_EVAL_LIVE",
  ]) {
    delete process.env[k];
  }
  try {
    // 1. Drive the runner's env-loading helper against the temp file.
    const prep = prepareDecisionPolicyEvaluationEnv({ path: envFile });
    assert.equal(prep.loaded, true);
    // 2. The env flag from .env is now visible to the live-mode
    //    gate inside the harness.
    assert.equal(process.env[DECISION_POLICY_EVAL_LIVE_ENV], "1");
    // 3. The harness, called with the populated env, sees the
    //    loaded provider config on the live snapshot.
    const scenario = BUILT_IN_DECISION_POLICY_SCENARIOS[0]!;
    const report = await runDecisionPolicyEvaluation({
      scenarios: [scenario],
      mode: "live",
      envOptInFlag: true,
      cliArgs: ["--live"],
    });
    assert.equal(report.evaluationMode, "live");
    assert.ok(report.live, "live metadata block must be present");
    assert.equal(report.live.optInEnvPresent, true);
    assert.deepEqual([...report.live.optInCliArgs], ["--live"]);
    // 4. The provider config snapshot reflects the env values.
    assert.equal(
      report.live.providerConfigSnapshot.primaryBaseUrl,
      "https://api.envload-test.test/v1"
    );
    assert.equal(report.live.providerConfigSnapshot.primaryModel, "envload/test-model");
    assert.equal(report.live.providerConfigSnapshot.primaryApiFormat, "openai-compatible");
    // 5. The boolean presence flag is true (key loaded) but the
    //    key value MUST NOT be echoed on the artifact.
    assert.equal(report.live.providerConfigSnapshot.hasPrimaryApiKey, true);
    assert.equal(report.live.providerConfigSnapshot.hasFallbackApiKey, false);
    const serialized = JSON.stringify(report.live);
    assert.ok(
      !serialized.includes("sk-test-envload-FAKE-KEY-DO-NOT-USE-yyyyy"),
      `live metadata block must NOT echo the API key value; got: ${serialized}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("decision-policy evaluation: env loader does NOT weaken the double opt-in (.env with live env flag but no --live stays scripted)", async () => {
  // The env-loading integration must not collapse the gate.
  // A `.env` that sets CURION_DECISION_EVAL_LIVE=1 is not, on
  // its own, sufficient to enable live mode: the user still
  // must pass `--live`. The scripted run is the safe default.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-gate-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(
    envFile,
    [
      "# Test-only fixture for the double opt-in preservation.",
      "CURION_DECISION_EVAL_LIVE=1",
      "CURION_PRIMARY_API_KEY=sk-test-gate-FAKE-KEY-DO-NOT-USE-xxxxx",
    ].join("\n")
  );
  const savedEnv = { ...process.env };
  for (const k of ["CURION_DECISION_EVAL_LIVE", "CURION_PRIMARY_API_KEY"]) {
    delete process.env[k];
  }
  try {
    const prep = prepareDecisionPolicyEvaluationEnv({ path: envFile });
    assert.equal(prep.loaded, true);
    // The env file set the opt-in flag; process.env now has it.
    assert.equal(process.env[DECISION_POLICY_EVAL_LIVE_ENV], "1");
    // Calling the harness with no --live CLI arg keeps scripted
    // mode, even though the env opt-in is set.
    const report = await runDecisionPolicyEvaluation({
      env: process.env,
      // mode: "scripted" (the default)
      // envOptInFlag: true (derived from the loaded env)
      // cliArgs: []  (no --live)
    });
    assert.equal(report.evaluationMode, "scripted");
    assert.equal(report.live, undefined);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("decision-policy evaluation: env loader with --live but no env opt-in still resolves to scripted-misconfig (gate intact)", async () => {
  // Mirror case: the user passed --live on the CLI but the .env
  // does not set the env opt-in. The runner must surface the
  // scripted-misconfig branch and refuse live mode. The env
  // loader does NOT inject the missing env flag on the user's
  // behalf.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-gate-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(
    envFile,
    [
      "# Test-only fixture: only the provider key, NO live opt-in flag.",
      "CURION_PRIMARY_API_KEY=sk-test-noflag-FAKE-KEY-DO-NOT-USE-wwwww",
    ].join("\n")
  );
  const savedEnv = { ...process.env };
  for (const k of ["CURION_DECISION_EVAL_LIVE", "CURION_PRIMARY_API_KEY"]) {
    delete process.env[k];
  }
  try {
    const prep = prepareDecisionPolicyEvaluationEnv({ path: envFile });
    assert.equal(prep.loaded, true);
    // The env opt-in flag is NOT set after the load.
    assert.equal(process.env[DECISION_POLICY_EVAL_LIVE_ENV], undefined);
    // The harness, called with --live but no env opt-in, throws
    // the documented LiveOptInRequiredError — the env loader did
    // NOT backfill the env flag.
    await assert.rejects(
      () =>
        runDecisionPolicyEvaluation({
          mode: "live",
          envOptInFlag: false,
          cliArgs: ["--live"],
          env: process.env,
        }),
      (err: unknown) => err instanceof LiveOptInRequiredError
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("decision-policy evaluation: loadDotEnv does not overwrite an explicitly-exported env value (env-loader contract)", () => {
  // The helper documents override=false. This test pins the
  // contract end-to-end: a process.env value explicitly set
  // by the caller (the explicit-export case) wins over a
  // conflicting value in `.env`. The decision-policy runner
  // inherits this contract from the shared env-loader.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-decision-eval-nooverride-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(envFile, "CURION_PRIMARY_BASE_URL=https://api.from-dotenv.test/v1\n");
  const before = { ...process.env };
  process.env.CURION_PRIMARY_BASE_URL = "https://api.from-process-env.test/v1";
  try {
    const result = prepareDecisionPolicyEvaluationEnv({ path: envFile });
    assert.equal(result.loaded, true);
    // process.env was NOT overwritten.
    assert.equal(process.env.CURION_PRIMARY_BASE_URL, "https://api.from-process-env.test/v1");
    // The skipped list records the conflict.
    assert.ok(result.skipped.includes("CURION_PRIMARY_BASE_URL"));
    assert.ok(!result.keys.includes("CURION_PRIMARY_BASE_URL"));
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("decision-policy evaluation: loadDotEnv skip:true on the helper is a no-op (the runner can opt out for hermetic tests)", () => {
  // The shared env-loader exposes a `skip: true` escape hatch
  // for hermetic tests. The runner's helper accepts and
  // forwards it so future tests / alternate runners can
  // bypass dotenv discovery without bypassing the
  // double opt-in.
  const result = prepareDecisionPolicyEvaluationEnv({ skip: true });
  assert.equal(result.loaded, false);
  assert.equal(result.keyCount, 0);
  assert.deepEqual(result.keys, []);
  // The helper's own contract: when skip:true, the path is
  // still recorded (it is the path the helper WOULD have
  // attempted), so a reviewer reading the artifact can tell
  // the helper ran but was disabled.
  assert.equal(typeof result.path, "string");
  assert.ok(result.path.length > 0);
  // Also exercise the underlying loadDotEnv skip behaviour
  // directly to confirm the same path is wired through.
  const direct = loadDotEnv({ skip: true });
  assert.equal(direct.loaded, false);
  assert.deepEqual(direct.keys, []);
});

// ---------------------------------------------------------------------------
// 20. Per-scope gate semantics (model-quality vs provider-path)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: meta carries modelQuality and providerPath counters", async () => {
  // The meta block surfaces scope counters so a reviewer can
  // compare the two scopes' pass rates without parsing the
  // per-scenario runs. The v2 split is 21 model-quality + 5
  // provider-path = 26 total.
  const report = await runDecisionPolicyEvaluation();
  assert.equal(
    report.meta.modelQualityCount + report.meta.providerPathCount,
    report.meta.scenarioCount,
    "model-quality + provider-path must equal the total scenario count"
  );
  assert.equal(report.meta.modelQualityCount, 21);
  assert.equal(report.meta.providerPathCount, 5);
  assert.equal(report.meta.modelQualityPassedCount, report.meta.modelQualityCount);
  assert.equal(report.meta.providerPathPassedCount, report.meta.providerPathCount);
});

test("decision-policy evaluation: modelQualityGate passes under scripted mode (all 21 model-quality scenarios pass)", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(report.modelQualityGate.modelQualityCount, 21);
  assert.equal(report.modelQualityGate.modelQualityPassed, 21);
  assert.equal(report.modelQualityGate.modelQualityFailed, 0);
  assert.equal(report.modelQualityGate.passed, true);
  assert.deepEqual([...report.modelQualityGate.failedScenarioIds], []);
});

test("decision-policy evaluation: providerPathGate passes under scripted mode (all 5 provider-path scenarios pass)", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(report.providerPathGate.providerPathCount, 5);
  assert.equal(report.providerPathGate.providerPathPassed, 5);
  assert.equal(report.providerPathGate.providerPathFailed, 0);
  assert.equal(report.providerPathGate.passed, true);
  assert.deepEqual([...report.providerPathGate.failedScenarioIds], []);
  // The `note` field is omitted in scripted mode (it would
  // only be present in live mode).
  assert.equal(report.providerPathGate.note, undefined);
});

test("decision-policy evaluation: live mode reports the providerPathGate transparency note", async () => {
  // The live-mode path surfaces a `note` on the
  // `providerPathGate` block so a reviewer reading the
  // artifact understands the gate is informational only.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "x",
        model: "live/test-model",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                '```json\n{"action":"store","reason":"novel","supersededIds":[],"conflictsWithIds":[],"redundantWithIds":[],"confidence":0.9}\n```',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const savedEnv = { ...process.env };
  process.env[DECISION_POLICY_EVAL_LIVE_ENV] = "1";
  process.env.CURION_PRIMARY_BASE_URL = "https://api.live-scope-test.test/v1";
  process.env.CURION_PRIMARY_MODEL = "live/test-model";
  process.env.CURION_PRIMARY_API_KEY = "sk-test-live-scope-FAKE-DO-NOT-USE-aaaaa";
  try {
    const report = await runDecisionPolicyEvaluation({
      mode: "live",
      envOptInFlag: true,
      cliArgs: ["--live"],
    });
    // The providerPathGate block carries the live-mode note.
    assert.ok(
      typeof report.providerPathGate.note === "string" &&
        report.providerPathGate.note.includes("Read `modelQualityGate`"),
      `live-mode providerPathGate must carry the transparency note; got: ${report.providerPathGate.note}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
  }
});

test("decision-policy evaluation: gates block carries modelQualityPassed / providerPathPassed fields", async () => {
  // The overall gates block surfaces each gate as a separate
  // boolean so a reviewer can read the headline verdict
  // without re-deriving it.
  const report = await runDecisionPolicyEvaluation();
  assert.equal(typeof report.gates.modelQualityPassed, "boolean");
  assert.equal(typeof report.gates.providerPathPassed, "boolean");
  assert.equal(typeof report.gates.modelQualityFailedScenarioIds, "object");
  assert.equal(typeof report.gates.providerPathFailedScenarioIds, "object");
  // In scripted mode all three gates pass.
  assert.equal(report.gates.safetyPrivacyPassed, true);
  assert.equal(report.gates.modelQualityPassed, true);
  assert.equal(report.gates.providerPathPassed, true);
  assert.equal(report.gates.allScenariosPassed, true);
  // The summary surfaces every gate and the conjunction that
  // drives `overallPassed`.
  assert.ok(report.gates.summary.includes("safety-privacy gate"));
  assert.ok(report.gates.summary.includes("model-quality gate"));
  assert.ok(report.gates.summary.includes("provider-path gate"));
  assert.ok(report.gates.summary.includes("all-scenarios gate"));
  assert.ok(report.gates.summary.includes("overall:"));
});

test("decision-policy evaluation: overallPassed = safetyPrivacyPassed AND modelQualityPassed (provider-path excluded)", async () => {
  // The overall gate excludes the provider-path gate so
  // live-mode reviewers are not penalized for the harness
  // state machine not exercising scripted hard-failure
  // paths. We construct a one-off scenario set with a
  // deliberately failing provider-path scenario to confirm
  // the conjunction.
  const failingProviderPath = BUILT_IN_DECISION_POLICY_SCENARIOS.find(
    (s) => s.id === "repair-recovers"
  )!;
  // Swap the scripted response to a valid decision on the
  // first call (no repair needed). The provider-path
  // scenario will fail (httpCalls=1 instead of 2) but the
  // model-quality gate stays untouched.
  const mutated = [
    {
      ...failingProviderPath,
      scripted: {
        primaryFirstResponse: JSON.stringify({
          action: "store",
          reason: "novel",
          supersededIds: [],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runDecisionPolicyEvaluation({ scenarios: mutated });
  // The mutated provider-path scenario is the only scenario
  // in the set; provider-path gate fails, model-quality
  // gate vacuously passes (0/0), safety-privacy gate
  // vacuously passes (0/0).
  assert.equal(report.providerPathGate.passed, false);
  assert.equal(report.gates.providerPathPassed, false);
  // Model-quality gate is the meaningful headline.
  assert.equal(report.modelQualityGate.modelQualityCount, 0);
  assert.equal(report.modelQualityGate.passed, true);
  assert.equal(report.gates.modelQualityPassed, true);
  // overallPassed excludes provider-path failures.
  assert.equal(report.gates.overallPassed, true);
});

test("decision-policy evaluation: a failing model-quality scenario fails overallPassed but not providerPathPassed", async () => {
  // The converse case: a deliberately failing model-quality
  // scenario must fail the model-quality gate AND the
  // overall gate, but leave the provider-path gate
  // untouched.
  const failingModelQuality = BUILT_IN_DECISION_POLICY_SCENARIOS.find((s) => s.id === "store-new")!;
  const mutated = [
    {
      ...failingModelQuality,
      scripted: {
        primaryFirstResponse: JSON.stringify({
          action: "reject",
          reason: "ambiguous_or_vague",
          supersededIds: [],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runDecisionPolicyEvaluation({ scenarios: mutated });
  // The mutated scenario is a model-quality scenario; it
  // fails the model-quality gate.
  assert.equal(report.modelQualityGate.passed, false);
  assert.equal(report.gates.modelQualityPassed, false);
  // Provider-path gate is vacuous (0 provider-path
  // scenarios in the set).
  assert.equal(report.modelQualityGate.modelQualityFailed, 1);
  assert.deepEqual([...report.modelQualityGate.failedScenarioIds], ["store-new"]);
  // overallPassed = safetyPrivacyPassed && modelQualityPassed
  // = true && false = false.
  assert.equal(report.gates.overallPassed, false);
});

test("decision-policy evaluation: scopes summary block covers every scope slot and surfaces safety-critical sub-counts", async () => {
  const report = await runDecisionPolicyEvaluation();
  assert.equal(report.scopes.length, 2);
  const scopeLabels = report.scopes.map((s) => s.scope);
  assert.ok(scopeLabels.includes("model-quality"));
  assert.ok(scopeLabels.includes("provider-path"));
  for (const s of report.scopes) {
    assert.equal(typeof s.totalScenarios, "number");
    assert.equal(typeof s.passed, "number");
    assert.equal(typeof s.failed, "number");
    assert.equal(typeof s.safetyCriticalTotal, "number");
    assert.equal(typeof s.safetyCriticalPassed, "number");
    assert.equal(typeof s.safetyCriticalFailed, "number");
    assert.equal(s.totalScenarios, s.passed + s.failed);
    assert.equal(s.safetyCriticalTotal, s.safetyCriticalPassed + s.safetyCriticalFailed);
  }
});

// ---------------------------------------------------------------------------
// 21. Per-scenario evaluationScope field
// ---------------------------------------------------------------------------

test("decision-policy evaluation: every run records an evaluationScope on the per-scenario result", async () => {
  const report = await runDecisionPolicyEvaluation();
  for (const r of report.runs) {
    assert.ok(
      r.evaluationScope === "model-quality" || r.evaluationScope === "provider-path",
      `run '${r.scenarioId}' must carry an evaluationScope; got: ${r.evaluationScope}`
    );
  }
});

test("decision-policy evaluation: exactly the 5 scripted-failure scenarios are tagged provider-path", () => {
  // The five provider-path resilience scenarios exercise the
  // harness's primary → repair → fallback → fallback-repair
  // state machine under scripted hard-failure / parse-
  // failure inputs. Every other scenario is a model-quality
  // scenario.
  const providerPathIds = BUILT_IN_DECISION_POLICY_SCENARIOS.filter(
    (s) => s.evaluationScope === "provider-path"
  ).map((s) => s.id);
  const expectedProviderPathIds = [
    "repair-recovers",
    "primary-hard-failure-no-fallback",
    "fallback-recovery-after-primary-failure",
    "always-invalid-provider-output",
    "invalid-output-after-repair-still-invalid",
  ];
  assert.deepEqual(providerPathIds.sort(), expectedProviderPathIds.sort());
  // Everything else is model-quality (the default).
  for (const s of BUILT_IN_DECISION_POLICY_SCENARIOS) {
    if (!expectedProviderPathIds.includes(s.id)) {
      assert.equal(
        s.evaluationScope,
        undefined,
        `scenario '${s.id}' should default to model-quality (no evaluationScope set); got: ${s.evaluationScope}`
      );
    }
  }
});

test("decision-policy evaluation: model-quality scenarios cover the full action/reason vocabulary in scripted mode", async () => {
  // Sanity check: the 21 model-quality scenarios exercise
  // every action / reason slot at least once under the
  // scripted provider behaviour. A future scenario set that
  // adds new model-quality scenarios should keep this
  // invariant.
  const report = await runDecisionPolicyEvaluation();
  const modelQualityRuns = report.runs.filter((r) => r.evaluationScope === "model-quality");
  for (const action of REMEMBER_DECISION_ACTIONS) {
    const seen = modelQualityRuns.some((r) => r.adapterOk && r.action === action);
    assert.ok(
      seen || !modelQualityRuns.some((r) => r.expect.action === action),
      `model-quality scenarios must cover action '${action}' (or no model-quality scenario expects it)`
    );
  }
});

// ---------------------------------------------------------------------------
// 22. Prompt content: target-memory IDs use id=N (not positional index=)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: the prompt renders related memories with id=N tokens, NOT positional index= tokens", async () => {
  // We exercise the adapter end-to-end with a scripted fetch
  // and capture the body the adapter sends. The body is the
  // JSON envelope the OpenAI-compatible http client posts;
  // the user-role prompt lives under `messages[1].content`.
  // The test asserts the prompt:
  //   1. leads related-memory lines with `id=N`,
  //   2. does NOT lead them with `index=N`,
  //   3. carries explicit textual guidance about using id
  //      values in the decision arrays.
  const { decideRememberPolicyWithFallback } = await import("../src/decision/adapter.ts");
  const { buildRememberDecisionEvidence } = await import("../src/decision/evidence.ts");
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return new Response(
      JSON.stringify({
        id: "x",
        model: "test",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "supersede",
                reason: "explicit_replacement",
                supersededIds: [42],
                conflictsWithIds: [],
                redundantWithIds: [],
                confidence: 0.9,
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const packet = buildRememberDecisionEvidence({
    rawInput: "Replace old DB choice with new one.",
    related: [
      {
        id: 42,
        kind: "fact",
        memoryContent: "Old DB choice was SQLite for the prototype.",
      },
    ],
  });
  await decideRememberPolicyWithFallback(packet, "Replace old DB choice with new one.", {
    primaryApiKey: "sk-test-not-real-aaaaa",
    fallbackApiKey: "sk-test-not-real-bbbbb",
    primaryBaseUrl: "https://api.example.com/v1",
    fallbackBaseUrl: "https://api.fallback.example/v1",
    primaryModel: "test/model",
    fallbackModel: "test/fallback",
    fetchImpl,
  });
  assert.ok(calls.length >= 1, "expected at least one HTTP call");
  const firstCall = calls[0]!;
  const body = JSON.parse(firstCall.body);
  // The body shape is `{ messages: [{role,content}, ...] }`.
  const messages = body.messages;
  assert.ok(Array.isArray(messages), "body must carry a messages array");
  const userMessage = messages.find((m: { role: string }) => m.role === "user");
  assert.ok(userMessage, "user-role message must be present");
  const userContent: string = userMessage.content;
  // The prompt leads with `id=N` for the related memory.
  assert.match(
    userContent,
    /- id=42 \[fact\]/,
    `user prompt must lead the related-memory line with 'id=42 [fact]'; got first 800 chars: ${userContent.slice(0, 800)}`
  );
  // The prompt does NOT lead with the old `index=0 controllerId=42` shape.
  assert.ok(
    !/- index=0 controllerId=/.test(userContent),
    `user prompt must NOT use the legacy '- index=N controllerId=M' line shape; got first 800 chars: ${userContent.slice(0, 800)}`
  );
  // The prompt carries explicit textual guidance about
  // using `id=N` values in the decision arrays.
  assert.ok(
    /Use THESE `id=N` values/i.test(userContent),
    `user prompt must carry explicit guidance about using id=N values`
  );
  // The system prompt also carries the action / reason /
  // confidence guidance.
  const systemMessage = messages.find((m: { role: string }) => m.role === "system");
  assert.ok(systemMessage, "system-role message must be present");
  const systemContent: string = systemMessage.content;
  assert.ok(
    /ACTION SELECTION GUIDE/.test(systemContent),
    "system prompt must carry the action selection guide"
  );
  assert.ok(
    /REASON SELECTION GUIDE/.test(systemContent),
    "system prompt must carry the reason selection guide"
  );
  assert.ok(
    /CONFIDENCE CALIBRATION/.test(systemContent),
    "system prompt must carry the confidence calibration guide"
  );
  // The system prompt explicitly distinguishes
  // `mixed_sensitive` vs `secret_echoed`.
  assert.ok(
    /mixed_sensitive/i.test(systemContent) && /secret_echoed/i.test(systemContent),
    "system prompt must mention both mixed_sensitive and secret_echoed"
  );
  // The system prompt explicitly distinguishes
  // `clarify` vs `reject` vs `no_op`. The v2.1 refinement
  // broadened the action-boundary guidance into a dedicated
  // "ACTION BOUNDARIES" section; the original v2
  // `(NOT `reject`)` phrasing may be split across the
  // ACTION SELECTION GUIDE bullets and the ACTION BOUNDARIES
  // section. We assert on a flexible regex that matches the
  // boundary guidance in either form.
  assert.ok(
    /`clarify`[^.]*NOT\s+`reject`/i.test(systemContent) &&
      /`no_op`[^.]*NOT\s+`reject`/i.test(systemContent),
    "system prompt must distinguish clarify vs reject vs no_op"
  );
  // The v2.1 refinement adds an explicit ACTION BOUNDARIES
  // section that distinguishes `reject` vs `no_op`,
  // `reject` vs `clarify`, and `redact` vs `reject`. Pin the
  // new section so a future refactor that drops it fails
  // this test before the live model loses the guidance.
  assert.match(
    systemContent,
    /ACTION BOUNDARIES/i,
    "system prompt must carry the v2.1 ACTION BOUNDARIES section"
  );
  assert.match(
    systemContent,
    /`reject` vs `no_op`/i,
    "system prompt ACTION BOUNDARIES must distinguish reject vs no_op"
  );
  assert.match(
    systemContent,
    /`reject` vs `clarify`/i,
    "system prompt ACTION BOUNDARIES must distinguish reject vs clarify"
  );
  assert.match(
    systemContent,
    /`redact` vs `reject`/i,
    "system prompt ACTION BOUNDARIES must distinguish redact vs reject"
  );
  assert.match(
    systemContent,
    /Temporal \/ current-vs-old ambiguity/i,
    "system prompt ACTION BOUNDARIES must address temporal / current-vs-old ambiguity"
  );
});

test("decision-policy evaluation: the system prompt carries a TARGET ID ARRAY GUIDE that pins invalidate / retraction targets to supersededIds", async () => {
  // The latest live eval (`invalidate-candidate`) failed the
  // model-quality gate because the model picked the right
  // action/reason (`invalidate` / `explicit_retraction`) but
  // returned `supersededIds: []` — the model read the
  // `supersededIds` schema description as "replacement-only".
  //
  // The remediation is to (a) add an explicit
  // "TARGET ID ARRAY GUIDE" section to the system prompt that
  // maps every action to its id array, and (b) update the
  // user-prompt schema description for `supersededIds` so it
  // names BOTH `supersede` and `invalidate`. This test pins
  // both surface elements so a future refactor that loses
  // the guidance is caught here before the live model loses it.
  const { decideRememberPolicyWithFallback } = await import("../src/decision/adapter.ts");
  const { buildRememberDecisionEvidence } = await import("../src/decision/evidence.ts");
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return new Response(
      JSON.stringify({
        id: "x",
        model: "test",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "invalidate",
                reason: "explicit_retraction",
                supersededIds: [12],
                conflictsWithIds: [],
                redundantWithIds: [],
                confidence: 0.82,
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const packet = buildRememberDecisionEvidence({
    rawInput: "Forget that we ever shipped a slack webhook on the home page.",
    related: [
      {
        id: 12,
        kind: "fact",
        memoryContent:
          "The project ships a Slack webhook on the home page for incident notifications.",
      },
    ],
  });
  await decideRememberPolicyWithFallback(packet, packet.rawInputHash, {
    primaryApiKey: "sk-test-not-real-aaaaa",
    fallbackApiKey: "sk-test-not-real-bbbbb",
    primaryBaseUrl: "https://api.example.com/v1",
    fallbackBaseUrl: "https://api.fallback.example/v1",
    primaryModel: "test/model",
    fallbackModel: "test/fallback",
    fetchImpl,
  });
  assert.ok(calls.length >= 1, "expected at least one HTTP call");
  const body = JSON.parse(calls[0]!.body);
  const messages = body.messages;
  assert.ok(Array.isArray(messages), "body must carry a messages array");
  // --- system prompt guidance ----------------------------------------
  const systemMessage = messages.find((m: { role: string }) => m.role === "system");
  assert.ok(systemMessage, "system-role message must be present");
  const systemContent: string = systemMessage.content;
  // The TARGET ID ARRAY GUIDE header must be present.
  assert.match(
    systemContent,
    /TARGET ID ARRAY GUIDE/i,
    "system prompt must carry the TARGET ID ARRAY GUIDE section"
  );
  // The guide must explicitly map `supersededIds` to BOTH
  // `supersede` AND `invalidate` (retraction). Without this
  // binding, the model leaves `supersededIds` empty on
  // retractions and the `targetIdInSuperseded` assertion fails.
  assert.match(
    systemContent,
    /`supersededIds`[\s\S]{0,500}(?:invalidate|retract|retraction)/i,
    "system prompt TARGET ID ARRAY GUIDE must bind supersededIds to invalidate / retraction"
  );
  assert.match(
    systemContent,
    /(?:invalidate|retract)[\s\S]{0,500}`supersededIds`/i,
    "system prompt TARGET ID ARRAY GUIDE must mention invalidate / retract on the way to supersededIds"
  );
  // The guide must explicitly address the common miss
  // (returning `supersededIds: []` for `invalidate`).
  assert.match(
    systemContent,
    /`supersededIds: \[\]`[\s\S]{0,200}invalidate/i,
    "system prompt TARGET ID ARRAY GUIDE must call out the `supersededIds: []` miss for invalidate"
  );
  // --- user-prompt schema description ---------------------------------
  const userMessage = messages.find((m: { role: string }) => m.role === "user");
  assert.ok(userMessage, "user-role message must be present");
  const userContent: string = userMessage.content;
  const supersededLine = userContent.match(/"supersededIds"[\s\S]{0,500}/);
  assert.ok(supersededLine, "user prompt must contain the supersededIds schema description");
  assert.match(
    supersededLine![0],
    /SUPERSEDES OR INVALIDATES/i,
    "user prompt schema for supersededIds must mention SUPERSEDES OR INVALIDATES"
  );
  assert.match(
    supersededLine![0],
    /invalidate/i,
    "user prompt schema for supersededIds must mention invalidate"
  );
});

test("decision-policy evaluation: the v2 invalidate-candidate scenario keeps id=12 in supersededIds", () => {
  // The scripted scenario asserts the model must put the
  // related id (12) in `supersededIds` for an
  // invalidate / explicit_retraction decision. This pin
  // catches a future scenario edit that loosens the
  // expected target array or removes the assertion
  // altogether — which would silently lose the regression
  // coverage that this prompt refinement closed.
  const scenario = BUILT_IN_DECISION_POLICY_SCENARIOS.find((s) => s.id === "invalidate-candidate");
  assert.ok(scenario, "invalidate-candidate scenario must exist in the v2 set");
  assert.equal(scenario!.expect.action, "invalidate");
  assert.equal(scenario!.expect.reason, "explicit_retraction");
  assert.equal(
    scenario!.expect.targetIdInSuperseded,
    12,
    "invalidate-candidate must keep id=12 as the expected supersededIds target"
  );
  assert.deepEqual(
    [...(scenario!.expect.expectedSupersededIds ?? [])],
    [12],
    "invalidate-candidate must keep expectedSupersededIds=[12]"
  );
  // The related memory the scenario seeds is id=12.
  assert.equal(scenario!.related.length, 1);
  assert.equal(scenario!.related[0]!.id, 12);
});

test("decision-policy evaluation: the repair prompt also carries the id=N guidance", async () => {
  // The repair prompt is the second user-role message after
  // a primary call returned an unparsable response. We
  // exercise the path: first call returns invalid JSON,
  // repair call returns a valid decision. The repair call's
  // body must carry the id=N guidance so a misrepair does
  // not regress the prompt quality.
  const { decideRememberPolicyWithFallback } = await import("../src/decision/adapter.ts");
  const { buildRememberDecisionEvidence } = await import("../src/decision/evidence.ts");
  const calls: Array<{ url: string; body: string }> = [];
  let callIndex = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    const isRepair = callIndex === 1;
    callIndex += 1;
    const content = isRepair
      ? JSON.stringify({
          action: "supersede",
          reason: "explicit_replacement",
          supersededIds: [42],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        })
      : "this is not valid json";
    return new Response(
      JSON.stringify({
        id: "x",
        model: "test",
        choices: [{ message: { role: "assistant", content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const packet = buildRememberDecisionEvidence({
    rawInput: "Replace old DB choice with new one.",
    related: [
      {
        id: 42,
        kind: "fact",
        memoryContent: "Old DB choice was SQLite for the prototype.",
      },
    ],
  });
  const r = await decideRememberPolicyWithFallback(packet, "Replace old DB choice with new one.", {
    primaryApiKey: "sk-test-not-real-aaaaa",
    fallbackApiKey: "sk-test-not-real-bbbbb",
    primaryBaseUrl: "https://api.example.com/v1",
    fallbackBaseUrl: "https://api.fallback.example/v1",
    primaryModel: "test/model",
    fallbackModel: "test/fallback",
    fetchImpl,
  });
  // The repair path must succeed.
  assert.equal(r.ok, true, "repair call must succeed");
  if (!r.ok) return;
  // The harness made 2 calls (invalid first + valid repair).
  assert.equal(calls.length, 2);
  const repairCall = calls[1]!;
  const repairBody = JSON.parse(repairCall.body);
  const repairUserMessage = repairBody.messages.find((m: { role: string }) => m.role === "user");
  assert.ok(repairUserMessage, "repair call must carry a user-role message");
  const repairContent: string = repairUserMessage.content;
  // The repair prompt mentions id=N.
  assert.ok(/id=N/.test(repairContent), "repair prompt must mention id=N tokens");
  // The repair prompt explicitly tells the model to use id
  // values (NOT positional indices) in the id arrays.
  assert.ok(
    /NOT positional indices/.test(repairContent),
    "repair prompt must explicitly distinguish id=N from positional indices"
  );
});

// ---------------------------------------------------------------------------
// 23. Updated limitations block
// ---------------------------------------------------------------------------

test("decision-policy evaluation: limitations block surfaces the model-quality / provider-path scope split", () => {
  // The limitations block now also surfaces the
  // model-quality / provider-path split so a reviewer
  // reading the artifact understands the new gate
  // attribution.
  const text = DECISION_POLICY_EVALUATION_LIMITATIONS.join("\n");
  assert.match(text, /model-quality/i, "limitations block must mention model-quality");
  assert.match(text, /provider-path/i, "limitations block must mention provider-path");
  assert.match(
    text,
    /target-memory id|id=N/i,
    "limitations block must mention the target-memory id contract"
  );
});

// ---------------------------------------------------------------------------
// 24. v2.1 attribution split (model-quality vs provider-path assertions)
// ---------------------------------------------------------------------------

test("decision-policy evaluation: every assertion row carries a group tag (decision-quality vs provider-path)", async () => {
  // The v2.1 attribution split tags each per-scenario
  // assertion row with a `group` so the `modelQualityGate`
  // can be sourced from `decision-quality` assertions only.
  // The contract is: outcome / action / reason / confidence*
  // / targetIdIn* / targetIdNotIn* → "decision-quality";
  // httpCalls / providerUsed / fallbackUsed → "provider-path".
  const report = await runDecisionPolicyEvaluation();
  for (const r of report.runs) {
    for (const a of r.assertions) {
      assert.ok(
        a.group === "decision-quality" || a.group === "provider-path",
        `assertion '${a.name}' on scenario '${r.scenarioId}' must carry a group tag; got: ${a.group}`
      );
    }
  }
  // Under scripted mode every assertion is expected to pass,
  // so the scripted artefact's `decisionQualityPass` and
  // `providerPathPass` are both true for every run.
  for (const r of report.runs) {
    assert.equal(r.decisionQualityPass, true, `decisionQualityPass must be true on scripted pass`);
    assert.equal(r.providerPathPass, true, `providerPathPass must be true on scripted pass`);
  }
});

test("decision-policy evaluation: scripted mode has empty modelQualityProviderPathMismatchScenarioIds", async () => {
  // In scripted mode the scripted fetch always honours the
  // httpCalls / fallbackUsed expectations, so the
  // provider-path assertion group never fails on a
  // model-quality scenario. The
  // modelQualityProviderPathMismatchScenarioIds list is
  // therefore empty.
  const report = await runDecisionPolicyEvaluation();
  assert.deepEqual(
    [...report.gates.modelQualityProviderPathMismatchScenarioIds],
    [],
    "modelQualityProviderPathMismatchScenarioIds must be empty in scripted mode"
  );
  assert.deepEqual(
    [...report.modelQualityGate.providerPathMismatchScenarioIds],
    [],
    "modelQualityGate.providerPathMismatchScenarioIds must be empty in scripted mode"
  );
});

test("decision-policy evaluation: modelQualityGate passes when a model-quality scenario has a provider-path mismatch", async () => {
  // The v2.1 contract: a model-quality scenario whose
  // decision-quality assertions pass but whose provider-path
  // assertion fails (a live-mode-only pattern) does NOT fail
  // the modelQualityGate. We exercise the contract by
  // mutating a single model-quality scenario so its scripted
  // response is parsed in a single call (httpCalls=1) but
  // the scenario still expects httpCalls=2 (a provider-path
  // mismatch). The decision-quality assertions still pass.
  const baseline = BUILT_IN_DECISION_POLICY_SCENARIOS.find((s) => s.id === "repair-recovers")!;
  // Promote it to model-quality scope by clearing its
  // `evaluationScope` so the harness treats it as a
  // model-quality scenario whose provider-path expectation
  // (httpCalls=2) is now mismatched (the canned response is
  // valid on the first call, so httpCalls=1). The harness's
  // scripted fetch returns the valid response on the first
  // call, the parser succeeds, no repair is attempted.
  const mutated = [
    {
      ...baseline,
      evaluationScope: undefined,
      scripted: {
        // Valid response on the first call → httpCalls=1,
        // not the scenario's expected 2.
        primaryFirstResponse: JSON.stringify({
          action: "store",
          reason: "novel",
          supersededIds: [],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runDecisionPolicyEvaluation({ scenarios: mutated });
  // Exactly one scenario, classified as model-quality.
  assert.equal(report.modelQualityGate.modelQualityCount, 1);
  // The decision-quality assertions passed (action=store,
  // reason=novel, confidence in [0.5, 1.0]) so the model
  // quality gate stays green.
  assert.equal(report.modelQualityGate.modelQualityPassed, 1);
  assert.equal(report.modelQualityGate.passed, true);
  assert.deepEqual([...report.modelQualityGate.failedScenarioIds], []);
  // The provider-path assertion (httpCalls=2) failed but is
  // surfaced under providerPathMismatchScenarioIds, NOT
  // under failedScenarioIds.
  assert.deepEqual(
    [...report.modelQualityGate.providerPathMismatchScenarioIds],
    ["repair-recovers"]
  );
  // The scenario's full `pass` is false (httpCalls=1 ≠ 2),
  // and its `providerPathPass` is false; its
  // `decisionQualityPass` is true. This is the v2.1 split
  // working as designed.
  const run = report.runs[0]!;
  assert.equal(run.pass, false);
  assert.equal(run.decisionQualityPass, true);
  assert.equal(run.providerPathPass, false);
  // The httpCalls assertion is tagged provider-path.
  const httpCallsAssertion = run.assertions.find((a) => a.name === "httpCalls");
  assert.ok(httpCallsAssertion);
  assert.equal(httpCallsAssertion.group, "provider-path");
  assert.equal(httpCallsAssertion.pass, false);
  // The action / reason / outcome assertions are tagged
  // decision-quality.
  for (const aName of ["outcome", "action", "reason"]) {
    const a = run.assertions.find((row) => row.name === aName);
    assert.ok(a);
    assert.equal(a.group, "decision-quality");
    assert.equal(a.pass, true);
  }
  // The gates block surfaces the mismatch list and keeps
  // `modelQualityPassed` true while `allScenariosPassed` is
  // false.
  assert.equal(report.gates.modelQualityPassed, true);
  assert.equal(report.gates.allScenariosPassed, false);
  assert.deepEqual(
    [...report.gates.modelQualityProviderPathMismatchScenarioIds],
    ["repair-recovers"]
  );
});

test("decision-policy evaluation: modelQualityGate fails when a model-quality scenario's decision-quality assertion fails (decision path unchanged)", async () => {
  // The v2.1 contract is symmetric: a model-quality scenario
  // whose decision-quality assertion fails DOES fail the
  // modelQualityGate. We exercise the negative case by
  // mutating a model-quality scenario to emit the wrong
  // action. The decision-quality assertion (`action`) fails,
  // the providerPathPass is true, the modelQualityGate
  // fails, and the provider-path mismatch list is empty
  // (no provider-path issue here).
  const baseline = BUILT_IN_DECISION_POLICY_SCENARIOS.find((s) => s.id === "store-new")!;
  const mutated = [
    {
      ...baseline,
      scripted: {
        primaryFirstResponse: JSON.stringify({
          action: "reject", // wrong on purpose
          reason: "ambiguous_or_vague",
          supersededIds: [],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runDecisionPolicyEvaluation({ scenarios: mutated });
  assert.equal(report.modelQualityGate.modelQualityCount, 1);
  assert.equal(report.modelQualityGate.modelQualityPassed, 0);
  assert.equal(report.modelQualityGate.passed, false);
  assert.deepEqual([...report.modelQualityGate.failedScenarioIds], ["store-new"]);
  // No provider-path mismatch: the decision-quality failure
  // is the only failure on this scenario.
  assert.deepEqual([...report.modelQualityGate.providerPathMismatchScenarioIds], []);
  // overallPassed is false (model-quality gate failed).
  assert.equal(report.gates.modelQualityPassed, false);
  assert.equal(report.gates.overallPassed, false);
});

test("decision-policy evaluation: human report surfaces the modelQualityProviderPathMismatchScenarioIds block when populated", async () => {
  // The human report must surface the
  // modelQualityProviderPathMismatchScenarioIds row when
  // populated. We construct a one-off report (no live
  // provider required) by mutating a model-quality scenario
  // to have a provider-path mismatch.
  const baseline = BUILT_IN_DECISION_POLICY_SCENARIOS.find((s) => s.id === "repair-recovers")!;
  const mutated = [
    {
      ...baseline,
      evaluationScope: undefined,
      scripted: {
        primaryFirstResponse: JSON.stringify({
          action: "store",
          reason: "novel",
          supersededIds: [],
          conflictsWithIds: [],
          redundantWithIds: [],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runDecisionPolicyEvaluation({ scenarios: mutated });
  const text = formatDecisionPolicyEvaluationReport(report);
  // The mismatch row is in the gates block.
  assert.match(
    text,
    /model-quality provider-path mismatches \(decision-quality PASS, full PASS FAIL — live-mode-only\): repair-recovers/,
    `human report must surface the mismatch row; got: ${text.split("--- gates ---")[1]?.split("--- per-category")[0] ?? "(no gates block found)"}`
  );
  // The per-scenario detail block surfaces the per-row
  // group tag and the decisionQualityPass line so a
  // reviewer can read the per-scenario attribution.
  assert.match(
    text,
    /\[provider-path\] httpCalls:/,
    `per-scenario detail must tag the httpCalls assertion as provider-path`
  );
  assert.match(
    text,
    /decision-quality assertions: PASS/,
    `per-scenario detail must surface the decisionQualityPass line`
  );
});

test("decision-policy evaluation: limitations block surfaces the v2.1 attribution split", () => {
  // The limitations block must mention the v2.1
  // model-quality / provider-path attribution split so a
  // reviewer reading the artifact understands the
  // modelQualityGate reads `decisionQualityPass` (NOT the
  // full `pass` conjunction).
  const text = DECISION_POLICY_EVALUATION_LIMITATIONS.join("\n");
  assert.match(
    text,
    /decision-quality|provider-path|attribution/i,
    "limitations block must mention the v2.1 attribution split"
  );
  assert.match(
    text,
    /v2\.1|live mode|live-mode/i,
    "limitations block must mention the v2.1 / live-mode split"
  );
});
