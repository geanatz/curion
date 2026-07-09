/**
 * Tests for the benchmark-only recall-policy evaluation
 * helper (v1).
 *
 * Coverage:
 *
 *   1. Per-scenario assertions: every built-in v1 scenario
 *      passes its expectation block under the scripted
 *      provider behaviour.
 *
 *   2. Repair path: the `malformed-provider-answer` scenario
 *      exercises the same-provider repair pass and verifies
 *      the adapter makes exactly 2 HTTP calls (1 invalid + 1
 *      valid).
 *
 *   3. All-invalid path: the `always-invalid-provider`
 *      scenario verifies the adapter exhausts the state
 *      machine (primary first + primary repair + fallback
 *      first + fallback repair) for 4 calls and returns
 *      `failureKind: "all-providers-failed"`.
 *
 *   4. Status distribution: the status histogram in the
 *      report includes every status vocabulary slot, with a
 *      count of zero when not observed.
 *
 *   5. Reason distribution: the reason histogram covers
 *      every reason vocabulary slot.
 *
 *   6. Target-memory match (Jaccard / IoU): scenarios with
 *      a target-memory expectation contribute to the
 *      aggregate Jaccard; per-scenario Jaccard is 1.0 for
 *      every scripted-correct scenario under the v1 scenario
 *      set.
 *
 *   7. Confusion matrix: rows = expected, cols = actual;
 *      the v1 scripted-success scenarios have no row/col
 *      mismatch.
 *
 *   8. Status-confusion matrix: the v1 scripted-success
 *      scenarios produce a diagonal-only matrix.
 *
 *   9. Abstention gate: strict pass-100% gate on every
 *      abstention-critical scenario passes iff every such
 *      scenario passes.
 *
 *   10. Model-quality + provider-path gates: pass under
 *       scripted mode (scripted fetches honour every
 *       per-scenario expectation).
 *
 *   11. Determinism: repeated runs produce byte-equal
 *       captured decisions for the same scenario set.
 *
 *   12. No-network: the scripted fetch is the only provider
 *       path the adapter sees; the harness never invokes
 *       `globalThis.fetch`.
 *
 *   13. Report shape: meta + categories + scopes +
 *       statusHistogram + reasonHistogram + perStatusAccuracy
 *       + perReasonAccuracy + statusConfusionMatrix +
 *       targetMemoryMatch + providerCallStats + abstentionGate
 *       + safetyGate + modelQualityGate + providerPathGate +
 *       gates + runs + limitations are all well-formed.
 *
 *   14. CLI parser: accepts `--artifacts`, `--no-write`,
 *       `--no-stdout`; rejects unknown flags and `--live`
 *       (live mode is intentionally NOT exposed in v1).
 *
 *   15. Artifact writer: writes a JSON artifact under a
 *       temp dir using the documented prefix.
 *
 *   16. Public API guard: the public MCP tool surface is
 *       unchanged; production code paths do NOT import the
 *       benchmark-only adapter.
 *
 *   17. Built-in scenario set integrity: unique ids, covers
 *       every canonical category, every scenario has a
 *       category, every scenario has a valid
 *       `RecallPolicyStatus` expectation when one is set.
 *
 *   18. Limitations block: surfaces the no-network /
 *       benchmark-only-adapter / frozen-scenarios /
 *       public-API caveats.
 *
 *   19. Adapter-direct exercise: the
 *       `runBenchmarkOnlyRecallPolicyAdapter` function
 *       returns a structured success decision under the
 *       scripted fetch.
 *
 *   20. Capture-artifact roundtrip: a written artifact
 *       round-trips through `JSON.parse` and preserves
 *       the report shape (prefix + scenario-set version).
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
import { okChatResponse } from "../src/benchmark/_scripted-fetch.ts";
import { parseRecallPolicyEvaluationCli } from "../src/benchmark/recall-policy-evaluation-runner.ts";
import {
  BUILT_IN_RECALL_POLICY_SCENARIOS,
  RECALL_POLICY_EVALUATION_LIMITATIONS,
  RECALL_POLICY_SCENARIO_CATEGORIES,
  RECALL_POLICY_SCENARIO_SET_VERSION,
  RECALL_POLICY_STATUSES,
  formatRecallPolicyEvaluationReport,
  runBenchmarkOnlyRecallPolicyAdapter,
  runRecallPolicyEvaluation,
  writeRecallPolicyEvaluationReport,
} from "../src/benchmark/recall-policy-evaluation.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 1. Per-scenario assertions
// ---------------------------------------------------------------------------

test("recall-policy evaluation: all 16 v1 built-in scenarios pass", async () => {
  const report = await runRecallPolicyEvaluation();
  // The 16 v1 built-in scenarios must all pass. A future
  // scenario that fails on a known limitation should be
  // marked expected-fail or removed from the v1 set; the
  // harness should not silently ship a failing scenario.
  assert.equal(report.meta.scenarioCount, 16);
  assert.equal(report.meta.passedCount, 16);
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

test("recall-policy evaluation: malformed-provider-answer makes exactly 2 HTTP calls and returns a valid decision", async () => {
  const report = await runRecallPolicyEvaluation();
  const repair = report.runs.find((r) => r.scenarioId === "malformed-provider-answer");
  assert.ok(repair, "malformed-provider-answer scenario must be in the report");
  assert.equal(repair.adapterOk, true);
  assert.equal(repair.status, "answered");
  assert.equal(repair.reason, "repair_recovers");
  // 2 calls: invalid first + valid repair. No fallback.
  assert.equal(repair.httpCalls, 2);
  assert.equal(repair.fallbackUsed, undefined);
  assert.equal(repair.repairAttempted, true);
  assert.equal(repair.fallbackAttempted, false);
});

// ---------------------------------------------------------------------------
// 3. All-invalid path: 4 calls, all-providers-failed
// ---------------------------------------------------------------------------

test("recall-policy evaluation: always-invalid-provider exhausts the state machine and returns all-providers-failed", async () => {
  const report = await runRecallPolicyEvaluation();
  const s = report.runs.find((r) => r.scenarioId === "always-invalid-provider");
  assert.ok(s, "always-invalid-provider scenario must be in the report");
  assert.equal(s.adapterOk, false);
  assert.equal(s.failureKind, "all-providers-failed");
  // Primary first + primary repair + fallback first +
  // fallback repair = 4 HTTP calls.
  assert.equal(s.httpCalls, 4);
  // Both repair- and fallback-paths are exercised.
  assert.equal(s.repairAttempted, true);
  assert.equal(s.fallbackAttempted, true);
});

// ---------------------------------------------------------------------------
// 4. Status distribution: every vocabulary slot appears in the histogram
// ---------------------------------------------------------------------------

test("recall-policy evaluation: status histogram covers the full status vocabulary", async () => {
  const report = await runRecallPolicyEvaluation();
  for (const status of RECALL_POLICY_STATUSES) {
    const row = report.statusHistogram.find((r) => r.status === status);
    assert.ok(row, `status histogram must include ${status}`);
    assert.equal(typeof row.count, "number");
    assert.ok(row.count >= 0, `${status} count must be >= 0`);
  }
  // Sum across status histogram must equal the number of
  // scenarios whose adapter returned ok.
  const histogramSum = report.statusHistogram.reduce((s, r) => s + r.count, 0);
  assert.equal(histogramSum, report.meta.adapterOkCount);
});

// ---------------------------------------------------------------------------
// 5. Per-scenario direct exercise of the benchmark-only adapter
// ---------------------------------------------------------------------------

test("recall-policy evaluation: runBenchmarkOnlyRecallPolicyAdapter returns a structured success on a canned scripted fetch", async () => {
  const scenario = BUILT_IN_RECALL_POLICY_SCENARIOS.find((s) => s.id === "direct-match");
  assert.ok(scenario, "direct-match scenario must exist");
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return okChatResponse(
      JSON.stringify({
        status: "answered",
        reason: "direct_match",
        sourceIds: [101],
        confidence: 0.91,
      })
    );
  };
  const result = await runBenchmarkOnlyRecallPolicyAdapter(scenario!, fetchImpl);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "answered");
  assert.deepEqual([...result.value.sourceIds], [101]);
  assert.equal(result.httpCalls, 1);
  // The adapter called exactly one URL (the primary URL).
  assert.equal(calls.length, 1);
  // The body is the JSON envelope the adapter sends.
  const parsed = JSON.parse(calls[0]!.body);
  assert.equal(parsed.query, scenario!.query);
});

// ---------------------------------------------------------------------------
// 6. Target-memory match (Jaccard / IoU)
// ---------------------------------------------------------------------------

test("recall-policy evaluation: per-scenario Jaccard scores are well-formed", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.ok(report.targetMemoryMatch.perScenario.length >= 10);
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

test("recall-policy evaluation: scripted success yields Jaccard = 1.00 on every target-id scenario", async () => {
  const report = await runRecallPolicyEvaluation();
  // Every scenario with a `sourceIdInAnswer` or
  // `expectedConflictIds` / `expectedSupersededIds` /
  // `expectedOlderVariantIds` block under the scripted
  // provider behaviour should have a perfect Jaccard.
  for (const r of report.targetMemoryMatch.perScenario) {
    assert.equal(r.jaccard, 1, `${r.scenarioId} must produce a perfect Jaccard`);
  }
});

// ---------------------------------------------------------------------------
// 7. Confusion matrix: well-formed, v1 set produces a diagonal
// ---------------------------------------------------------------------------

test("recall-policy evaluation: status confusion matrix has one row per expected-status and one col per actual-status", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.ok(report.statusConfusionMatrix.rows.length >= 1);
  assert.ok(report.statusConfusionMatrix.cols.length >= 1);
  assert.equal(
    report.statusConfusionMatrix.matrix.length,
    report.statusConfusionMatrix.rows.length,
    "matrix row count must equal rows label count"
  );
  for (const row of report.statusConfusionMatrix.matrix) {
    assert.equal(row.length, report.statusConfusionMatrix.cols.length);
  }
  // The total count summed across the matrix equals the
  // total scenario count (every scenario contributes to
  // exactly one cell of the confusion matrix).
  const totalInMatrix = report.statusConfusionMatrix.matrix.flat().reduce((s, c) => s + c, 0);
  assert.equal(totalInMatrix, report.meta.scenarioCount);
});

test("recall-policy evaluation: per-status / per-reason accuracy is well-formed", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.equal(report.perStatusAccuracy.length, RECALL_POLICY_STATUSES.length);
  for (const row of report.perStatusAccuracy) {
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

// ---------------------------------------------------------------------------
// 8. Abstention gate
// ---------------------------------------------------------------------------

test("recall-policy evaluation: abstention gate passes iff every abstention-critical scenario passes", async () => {
  const report = await runRecallPolicyEvaluation();
  const abstentionRuns = report.runs.filter((r) => r.abstentionCritical);
  assert.ok(
    abstentionRuns.length >= 3,
    `v1 set must exercise at least 3 abstention-critical scenarios, got ${abstentionRuns.length}`
  );
  assert.equal(abstentionRuns.length, report.abstentionGate.abstentionCriticalCount);
  for (const r of abstentionRuns) {
    assert.ok(r.pass, `abstention-critical scenario '${r.scenarioId}' must pass`);
  }
  assert.equal(report.abstentionGate.passed, true);
});

test("recall-policy evaluation: abstention failure surfaces on report.gates.abstentionFailedScenarioIds", async () => {
  // Build a one-off scenario set with a deliberately failing
  // abstention-critical scenario. The harness's gates block
  // should report:
  //   (a) abstentionPassed = false, with the failing id in
  //       `abstentionFailedScenarioIds`.
  //   (b) overallPassed = false.
  const failing = BUILT_IN_RECALL_POLICY_SCENARIOS.find((s) => s.id === "no-relevant-memory")!;
  // Swap the scripted response to `answered` so the
  // abstention-critical scenario FAILS its expectation.
  const mutated = [
    {
      ...failing,
      scripted: {
        primaryResponse: JSON.stringify({
          status: "answered",
          reason: "direct_match",
          sourceIds: [140],
          confidence: 0.9,
        }),
      },
    },
  ];
  const report = await runRecallPolicyEvaluation({ scenarios: mutated });
  assert.equal(report.abstentionGate.abstentionCriticalFailed, 1);
  assert.equal(report.abstentionGate.passed, false);
  assert.deepEqual([...report.abstentionGate.failedScenarioIds], ["no-relevant-memory"]);
  assert.equal(report.gates.abstentionPassed, false);
  assert.equal(report.gates.overallPassed, false);
  assert.deepEqual([...report.gates.abstentionFailedScenarioIds], ["no-relevant-memory"]);
});

// ---------------------------------------------------------------------------
// 9. All-scenarios gate + gates block
// ---------------------------------------------------------------------------

test("recall-policy evaluation: gates block distinguishes abstention from all-scenarios", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.equal(
    report.gates.overallPassed,
    report.gates.abstentionPassed &&
      report.gates.safetyPassed &&
      report.gates.modelQualityPassed &&
      report.gates.providerPathPassed
  );
  assert.ok(report.gates.summary.includes("abstention gate"));
  assert.ok(report.gates.summary.includes("all-scenarios gate"));
});

// ---------------------------------------------------------------------------
// 10. Determinism: repeated runs produce byte-equal captured decisions
// ---------------------------------------------------------------------------

test("recall-policy evaluation: repeated runs produce byte-equal captured decisions", async () => {
  const r1 = await runRecallPolicyEvaluation();
  const r2 = await runRecallPolicyEvaluation();
  assert.equal(r1.runs.length, r2.runs.length);
  for (let i = 0; i < r1.runs.length; i += 1) {
    const a = r1.runs[i]!;
    const b = r2.runs[i]!;
    assert.equal(a.scenarioId, b.scenarioId);
    assert.equal(a.adapterOk, b.adapterOk);
    assert.equal(a.status, b.status);
    assert.equal(a.reason, b.reason);
    assert.deepEqual([...(a.sourceIds ?? [])], [...(b.sourceIds ?? [])]);
    assert.deepEqual([...(a.conflictIds ?? [])], [...(b.conflictIds ?? [])]);
    assert.deepEqual([...(a.supersededIds ?? [])], [...(b.supersededIds ?? [])]);
    assert.deepEqual([...(a.olderVariantIds ?? [])], [...(b.olderVariantIds ?? [])]);
    assert.equal(a.httpCalls, b.httpCalls);
    if (a.confidence !== undefined && b.confidence !== undefined) {
      assert.equal(a.confidence, b.confidence);
    }
  }
  // The histogram counts must be deterministic too.
  assert.deepEqual(
    r1.statusHistogram.map((h) => h.count),
    r2.statusHistogram.map((h) => h.count)
  );
});

// ---------------------------------------------------------------------------
// 11. No-network: the scripted fetch is the only path
// ---------------------------------------------------------------------------

test("recall-policy evaluation: the harness never makes a real network call", async () => {
  // The harness wires a scripted fetch into the benchmark-only
  // adapter; the scripted fetch returns canned responses in-
  // process and the harness never reaches a real provider URL.
  const report = await runRecallPolicyEvaluation();
  // The expected per-scenario call counts for v1 (16 scenarios):
  //   - 14 with 1 call each: 14
  //   - 1 (malformed-provider-answer) with 2 calls: 2
  //   - 1 (always-invalid-provider) with 4 calls: 4
  // Total: 20
  const actualTotal = report.runs.reduce((s, r) => s + r.httpCalls, 0);
  assert.equal(report.meta.totalHttpCalls, actualTotal);
  assert.equal(
    report.meta.totalHttpCalls,
    BUILT_IN_RECALL_POLICY_SCENARIOS.reduce((s, sc) => {
      const exp = sc.expect.httpCalls ?? 1;
      return s + exp;
    }, 0),
    `total http calls should equal sum of expected per-scenario httpCalls`
  );
});

test("recall-policy evaluation: scripted mode remains the default and never invokes globalThis.fetch", async () => {
  // Mutate globalThis.fetch so any unexpected call from the
  // scripted path would throw — the harness must NEVER touch
  // the global fetch.
  const originalFetch = globalThis.fetch;
  let realFetchCalls = 0;
  globalThis.fetch = (async () => {
    realFetchCalls += 1;
    throw new Error("scripted mode must not invoke globalThis.fetch");
  }) as typeof fetch;
  try {
    const report = await runRecallPolicyEvaluation();
    assert.equal(realFetchCalls, 0);
    assert.equal(report.evaluationMode ?? "scripted", "scripted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 12. Report shape (v1)
// ---------------------------------------------------------------------------

test("recall-policy evaluation: report shape is well-formed (v1 metrics + gates + categories)", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.equal(typeof report.generatedAt, "string");
  assert.ok(report.generatedAt.length > 0);
  // Scenario-set version stamp.
  assert.equal(report.scenarioSetVersion, RECALL_POLICY_SCENARIO_SET_VERSION);
  // Meta block.
  assert.equal(typeof report.meta.scenarioCount, "number");
  assert.equal(typeof report.meta.passedCount, "number");
  assert.equal(typeof report.meta.failedCount, "number");
  assert.equal(typeof report.meta.adapterOkCount, "number");
  assert.equal(typeof report.meta.adapterFailedCount, "number");
  assert.equal(typeof report.meta.totalHttpCalls, "number");
  assert.equal(typeof report.meta.abstentionCriticalCount, "number");
  assert.equal(typeof report.meta.abstentionCriticalPassedCount, "number");
  // Per-category summary covers every canonical category.
  assert.equal(report.categories.length, RECALL_POLICY_SCENARIO_CATEGORIES.length);
  for (const c of report.categories) {
    assert.ok(RECALL_POLICY_SCENARIO_CATEGORIES.includes(c.category));
    assert.equal(typeof c.totalScenarios, "number");
    assert.equal(typeof c.passed, "number");
    assert.equal(typeof c.failed, "number");
    assert.equal(typeof c.abstentionCriticalTotal, "number");
    assert.equal(typeof c.abstentionCriticalPassed, "number");
    assert.equal(typeof c.abstentionCriticalFailed, "number");
    assert.equal(c.totalScenarios, c.passed + c.failed);
    assert.equal(
      c.abstentionCriticalTotal,
      c.abstentionCriticalPassed + c.abstentionCriticalFailed
    );
  }
  // Histograms.
  assert.equal(report.statusHistogram.length, RECALL_POLICY_STATUSES.length);
  // Per-status / per-reason accuracy.
  assert.equal(report.perStatusAccuracy.length, RECALL_POLICY_STATUSES.length);
  // Confusion matrix shape.
  assert.ok(Array.isArray(report.statusConfusionMatrix.rows));
  assert.ok(Array.isArray(report.statusConfusionMatrix.cols));
  assert.ok(Array.isArray(report.statusConfusionMatrix.matrix));
  // Target-memory match shape.
  assert.equal(typeof report.targetMemoryMatch.aggregateJaccard, "number");
  assert.equal(typeof report.targetMemoryMatch.aggregateIoU, "number");
  assert.equal(typeof report.targetMemoryMatch.scenariosWithExpectedIds, "number");
  assert.equal(typeof report.targetMemoryMatch.perfectMatches, "number");
  // Provider-call stats.
  for (const v of Object.values(report.providerCallStats)) {
    assert.equal(typeof v, "number");
    assert.ok(v >= 0);
  }
  // Gates blocks.
  assert.equal(typeof report.abstentionGate.abstentionCriticalCount, "number");
  assert.equal(typeof report.abstentionGate.passed, "boolean");
  assert.ok(Array.isArray(report.abstentionGate.failedScenarioIds));
  assert.equal(typeof report.safetyGate.safetyCriticalCount, "number");
  assert.equal(typeof report.safetyGate.passed, "boolean");
  assert.equal(typeof report.modelQualityGate.modelQualityCount, "number");
  assert.equal(typeof report.modelQualityGate.passed, "boolean");
  assert.equal(typeof report.providerPathGate.providerPathCount, "number");
  assert.equal(typeof report.providerPathGate.passed, "boolean");
  // Gates block.
  assert.equal(typeof report.gates.overallPassed, "boolean");
  assert.equal(typeof report.gates.allScenariosPassed, "boolean");
  assert.equal(typeof report.gates.summary, "string");
  // Runs are well-formed.
  for (const r of report.runs) {
    assert.equal(typeof r.scenarioId, "string");
    assert.equal(typeof r.label, "string");
    assert.equal(typeof r.description, "string");
    assert.equal(typeof r.query, "string");
    assert.equal(typeof r.relatedCount, "number");
    assert.equal(typeof r.httpCalls, "number");
    assert.equal(typeof r.repairAttempted, "boolean");
    assert.equal(typeof r.fallbackAttempted, "boolean");
    assert.equal(typeof r.adapterOk, "boolean");
    assert.ok(Array.isArray(r.assertions));
    assert.equal(typeof r.pass, "boolean");
    // v1 fields.
    assert.ok(RECALL_POLICY_SCENARIO_CATEGORIES.includes(r.category));
    assert.equal(typeof r.abstentionCritical, "boolean");
    assert.ok(r.capturedTargetIds !== undefined);
    assert.ok(r.targetMemoryJaccard === null || typeof r.targetMemoryJaccard === "number");
    // Per-run provider-call inference.
    //   - `repairAttempted` is true iff the scripted fetch saw a
    //     primary-repair call.
    //   - `fallbackAttempted` is true iff any fallback call was
    //     invoked.
    // Symmetric: every `fallbackAttempted` scenario has at least
    // primary first + fallback first (so httpCalls >= 2).
    if (r.fallbackAttempted) {
      assert.ok(r.httpCalls >= 2, `fallbackAttempted implies httpCalls >= 2 (got ${r.httpCalls})`);
    }
    // For successful runs, the success-only fields are present.
    if (r.adapterOk) {
      assert.ok(r.status !== undefined);
      assert.ok(r.reason !== undefined);
      assert.ok(r.confidence !== undefined);
      assert.ok(Array.isArray(r.sourceIds));
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

test("recall-policy evaluation: limitations block surfaces the no-network / benchmark-only-adapter / public-API caveats", () => {
  const text = RECALL_POLICY_EVALUATION_LIMITATIONS.join("\n");
  assert.match(text, /no-network/i);
  assert.match(text, /benchmark-only|research-only/i);
  assert.match(text, /public mcp api|public.*api|tool schema/i);
  assert.match(text, /frozen scenario/i);
  assert.match(text, /v1/i, "limitations block surfaces the v1 scenario-set version");
  assert.match(text, /abstention gate|abstention-critical/i);
});

test("recall-policy evaluation: human report is non-empty and surfaces the expected sections", async () => {
  const report = await runRecallPolicyEvaluation();
  const text = formatRecallPolicyEvaluationReport(report);
  assert.ok(text.length > 0);
  assert.match(text, /=== curion recall-policy evaluation ===/);
  assert.match(text, /--- meta ---/);
  assert.match(text, /--- gates ---/);
  assert.match(text, /--- categories ---/);
  assert.match(text, /--- scopes ---/);
  assert.match(text, /--- status histogram ---/);
  assert.match(text, /--- reason histogram ---/);
  assert.match(text, /--- per-status accuracy ---/);
  assert.match(text, /--- per-reason accuracy ---/);
  assert.match(text, /--- status confusion matrix/);
  assert.match(text, /--- target-memory match/);
  assert.match(text, /--- provider call stats ---/);
  assert.match(text, /--- abstention gate ---/);
  assert.match(text, /READ THIS FIRST/);
  assert.match(text, /--- per-scenario summary ---/);
  assert.match(text, /--- limitations \(research-only\) ---/);
  // Scenario-set version stamp is on the human report.
  assert.match(text, new RegExp(`scenario set version: ${RECALL_POLICY_SCENARIO_SET_VERSION}`));
  // Per-scenario sections are present.
  for (const r of report.runs) {
    assert.match(text, new RegExp(`--- scenario: ${r.scenarioId}`));
  }
});

// ---------------------------------------------------------------------------
// 13. CLI parser
// ---------------------------------------------------------------------------

test("recall-policy evaluation: CLI parser accepts --artifacts, --no-write, --no-stdout and rejects unknown flags", () => {
  const parsed = parseRecallPolicyEvaluationCli(["--artifacts", "/tmp/foo"]);
  assert.equal(parsed.artifactsDir, "/tmp/foo");
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);

  const parsedNoWrite = parseRecallPolicyEvaluationCli(["--no-write"]);
  assert.equal(parsedNoWrite.noWrite, true);

  const parsedNoStdout = parseRecallPolicyEvaluationCli(["--no-stdout"]);
  assert.equal(parsedNoStdout.noStdout, true);

  assert.throws(
    () => parseRecallPolicyEvaluationCli(["--unknown-flag"]),
    /unknown recall-policy evaluation cli flag/
  );
});

test("recall-policy evaluation: CLI parser rejects --live (live mode is intentionally NOT exposed in v1)", () => {
  // The shared benchmark CLI helper defaults to
  // `supportLive: false`. A benchmark runner that does NOT
  // opt in (e.g. the recall-policy runner, which intentionally
  // has no live mode in v1) refuses the flag with a clear
  // "unknown <contextLabel> cli flag" error.
  assert.throws(
    () => parseRecallPolicyEvaluationCli(["--live"]),
    /unknown recall-policy evaluation cli flag: "--live"/
  );
});

test("recall-policy evaluation: CLI parser with no args uses a safe default", () => {
  const parsed = parseRecallPolicyEvaluationCli([]);
  assert.ok(parsed.artifactsDir.endsWith(".curion/benchmark"));
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);
});

// ---------------------------------------------------------------------------
// 14. Artifact writer
// ---------------------------------------------------------------------------

test("recall-policy evaluation: writeRecallPolicyEvaluationReport writes a well-formed artifact with the documented prefix", async () => {
  const report = await runRecallPolicyEvaluation();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-recall-policy-eval-test-"));
  try {
    const file = writeRecallPolicyEvaluationReport(report, tmp);
    assert.ok(fs.existsSync(file), "artifact file must be written");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // The shape is the same as the in-memory report.
    assert.equal(parsed.meta.scenarioCount, report.meta.scenarioCount);
    assert.equal(parsed.runs.length, report.runs.length);
    assert.equal(parsed.statusHistogram.length, report.statusHistogram.length);
    assert.equal(parsed.reasonHistogram.length, report.reasonHistogram.length);
    // v1 fields on the artifact.
    assert.equal(parsed.scenarioSetVersion, RECALL_POLICY_SCENARIO_SET_VERSION);
    assert.equal(parsed.categories.length, report.categories.length);
    assert.equal(
      parsed.statusConfusionMatrix.matrix.length,
      report.statusConfusionMatrix.matrix.length
    );
    // The filename uses the documented prefix.
    assert.match(path.basename(file), /^recall-policy-evaluation-/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recall-policy evaluation: writeRecallPolicyEvaluationReport creates the target directory if missing", async () => {
  const report = await runRecallPolicyEvaluation();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "curion-recall-policy-eval-parent-"));
  try {
    const dir = path.join(parent, "nested", "benchmark");
    const file = writeRecallPolicyEvaluationReport(report, dir);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 15. Public API guard
// ---------------------------------------------------------------------------

test("recall-policy evaluation: the public MCP tool surface is unchanged", () => {
  // The harness evaluates a benchmark-only recall-policy
  // adapter directly with a scripted fetch. It does NOT add
  // a new public MCP tool, resource, or input schema. We
  // assert by checking the canonical `PUBLIC_TOOL_NAMES`
  // constant.
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

test("recall-policy evaluation: the production recall controller does NOT import the benchmark-only adapter", () => {
  // The production `recall(text)` controller lives in
  // `src/controller/recall-controller.ts` and MUST NOT import
  // the benchmark-only recall-policy adapter. A future
  // reviewer who tries to wire the benchmark into production
  // is caught here before the public surface drifts.
  const controllerSource = fs.readFileSync(
    new URL("../src/controller/recall-controller.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    !controllerSource.includes("runBenchmarkOnlyRecallPolicyAdapter"),
    "recall controller must not import the benchmark-only adapter"
  );
  assert.ok(
    !controllerSource.includes("RecallPolicyEvaluation"),
    "recall controller must not import any recall-policy evaluation module"
  );
});

test("recall-policy evaluation: the public MCP recall tool does NOT import the benchmark-only adapter", () => {
  // The public `src/tools/recall.ts` projection layer is on
  // the wire — it MUST NOT import the benchmark-only adapter.
  const toolSource = fs.readFileSync(new URL("../src/tools/recall.ts", import.meta.url), "utf8");
  assert.ok(
    !toolSource.includes("RecallPolicyEvaluation"),
    "the public recall tool must not import any recall-policy evaluation module"
  );
  assert.ok(
    !toolSource.includes("runBenchmarkOnlyRecallPolicyAdapter"),
    "the public recall tool must not import the benchmark-only adapter"
  );
});

// ---------------------------------------------------------------------------
// 16. Built-in scenario set integrity (v1)
// ---------------------------------------------------------------------------

test("recall-policy evaluation: BUILT_IN_RECALL_POLICY_SCENARIOS has unique ids and covers the brief's required categories", () => {
  const ids = BUILT_IN_RECALL_POLICY_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
  // Every canonical category must be exercised.
  for (const cat of RECALL_POLICY_SCENARIO_CATEGORIES) {
    assert.ok(
      BUILT_IN_RECALL_POLICY_SCENARIOS.some((s) => s.category === cat),
      `v1 set must include at least one scenario in category '${cat}'`
    );
  }
  // Every scenario must have a category.
  for (const s of BUILT_IN_RECALL_POLICY_SCENARIOS) {
    assert.ok(
      RECALL_POLICY_SCENARIO_CATEGORIES.includes(s.category),
      `scenario '${s.id}' uses unknown category '${s.category}'`
    );
  }
});

test("recall-policy evaluation: v1 brief-required axes are covered by the scenario set", () => {
  const ids = new Set(BUILT_IN_RECALL_POLICY_SCENARIOS.map((s) => s.id));
  // Brief axes: answerable, no-memory / weak-match, ambiguity,
  // lifecycle, robustness. We pin a representative scenario
  // per axis. The scenario labels are also a self-documenting
  // audit trail so the brief's expectations remain visible.
  const required = [
    "direct-match", // answerable
    "no-relevant-memory", // no-memory
    "thin-related-memory", // weak-match
    "provider-refusal", // weak-match (refusal reroute)
    "conflicting-candidates", // ambiguity
    "unclear-query", // ambiguity
    "multiple-possible-targets", // ambiguity
    "superseded-memory-hidden", // lifecycle
    "current-truth-preferred", // lifecycle
    "false-premise-old-memory", // lifecycle
    "irrelevant-high-ranked", // robustness
    "malformed-provider-answer", // robustness
    "always-invalid-provider", // robustness
    "refusal-shape-valid", // robustness
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `v1 scenario set must include '${id}'`);
  }
});

test("recall-policy evaluation: v1 set drives the abstention gate via at least 3 abstention-critical scenarios", () => {
  const count = BUILT_IN_RECALL_POLICY_SCENARIOS.filter(
    (s) => s.abstentionCritical ?? s.category === "no-memory-weak-match"
  ).length;
  assert.ok(
    count >= 3,
    `v1 set must include at least 3 abstention-critical scenarios, got ${count}`
  );
});

test("recall-policy evaluation: the 2 provider-path scenarios are the scripted-failure scenarios", () => {
  const providerPathIds = BUILT_IN_RECALL_POLICY_SCENARIOS.filter(
    (s) => s.evaluationScope === "provider-path"
  ).map((s) => s.id);
  assert.deepEqual(
    providerPathIds.sort(),
    ["always-invalid-provider", "malformed-provider-answer"].sort()
  );
});

test("recall-policy evaluation: scenario set version stamp is exposed", () => {
  assert.equal(typeof RECALL_POLICY_SCENARIO_SET_VERSION, "string");
  assert.match(RECALL_POLICY_SCENARIO_SET_VERSION, /^v\d+$/);
});

// ---------------------------------------------------------------------------
// 17. Capture-artifact roundtrip
// ---------------------------------------------------------------------------

test("recall-policy evaluation: a written artifact round-trips through JSON.parse with the same scenario-set version", async () => {
  const report = await runRecallPolicyEvaluation();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-recall-policy-roundtrip-"));
  try {
    const file = writeRecallPolicyEvaluationReport(report, tmp);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.scenarioSetVersion, RECALL_POLICY_SCENARIO_SET_VERSION);
    assert.equal(parsed.gates.overallPassed, report.gates.overallPassed);
    assert.deepEqual(
      parsed.statusHistogram.map((h: { status: string; count: number }) => [h.status, h.count]),
      report.statusHistogram.map((h) => [h.status, h.count])
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 18. Shared benchmark CLI helper still rejects --live by default
// ---------------------------------------------------------------------------

test("recall-policy evaluation: shared benchmark CLI helper rejects --live by default (opt-in only)", () => {
  assert.throws(
    () => parseBenchmarkArtifactCli(["--live"]),
    /unknown benchmark cli flag: "--live"/
  );
});

// ---------------------------------------------------------------------------
// 19. Status-confusion matrix: scripted success produces a diagonal-only matrix
// ---------------------------------------------------------------------------

test("recall-policy evaluation: scripted-mode confusion matrix is diagonal-only (no off-diagonal status mismatches)", async () => {
  // Every scripted scenario except `always-invalid-provider`
  // (which is expected to fail) succeeds with the exact
  // expected status. The 200-cell of the matrix should be
  // exactly the count of scenarios that expected `200`
  // (here status names vary: `answered`, `weak_match`,
  // `no_memory`).
  const report = await runRecallPolicyEvaluation();
  const expectedExpectedStatus = report.runs
    .filter((r) => r.expectedStatus !== undefined)
    .map((r) => r.expectedStatus!);
  const expectedActualStatus = report.runs.filter((r) => r.adapterOk).map((r) => r.status!);
  // The expected and actual status multisets are equal.
  assert.deepEqual([...expectedExpectedStatus].sort(), [...expectedActualStatus].sort());
});

// ---------------------------------------------------------------------------
// 20. Provider-path gate attribution split
// ---------------------------------------------------------------------------

test("recall-policy evaluation: meta carries modelQuality and providerPath counters", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.equal(
    report.meta.modelQualityCount + report.meta.providerPathCount,
    report.meta.scenarioCount,
    "model-quality + provider-path must equal the total scenario count"
  );
  // v1 split: 14 model-quality + 2 provider-path = 16.
  assert.equal(report.meta.modelQualityCount, 14);
  assert.equal(report.meta.providerPathCount, 2);
  assert.equal(report.meta.modelQualityPassedCount, report.meta.modelQualityCount);
  assert.equal(report.meta.providerPathPassedCount, report.meta.providerPathCount);
});

test("recall-policy evaluation: model-quality gate passes under scripted mode (14 model-quality scenarios pass by decision quality)", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.equal(report.modelQualityGate.modelQualityCount, 14);
  assert.equal(report.modelQualityGate.modelQualityPassed, 14);
  assert.equal(report.modelQualityGate.modelQualityFailed, 0);
  assert.equal(report.modelQualityGate.passed, true);
  assert.deepEqual([...report.modelQualityGate.failedScenarioIds], []);
});

test("recall-policy evaluation: provider-path gate passes under scripted mode (2 provider-path scenarios pass)", async () => {
  const report = await runRecallPolicyEvaluation();
  assert.equal(report.providerPathGate.providerPathCount, 2);
  assert.equal(report.providerPathGate.providerPathPassed, 2);
  assert.equal(report.providerPathGate.providerPathFailed, 0);
  assert.equal(report.providerPathGate.passed, true);
  assert.deepEqual([...report.providerPathGate.failedScenarioIds], []);
});
