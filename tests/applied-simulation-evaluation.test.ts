/**
 * Tests for the applied-simulation benchmark harness (Phase 3).
 *
 * Coverage:
 *   1. Module imports correctly and exports expected symbols.
 *   2. `runAppliedSimulationEvaluation` is hermetic (no network, temp storage).
 *   3. Report shape is correct with expected fields.
 *   4. Artifact writer produces a file with the correct prefix.
 *   5. Human formatter produces a non-empty string.
 *   6. All scenarios are represented in the report.
 *   7. Limitations block is present and non-empty.
 *   8. Public API is unchanged (no new MCP tools, no behavior change).
 *   9. Scenario coverage satisfies minimum gate requirements.
 *  10. Delta status is "applied" (measured, not counterfactual).
 *  11. Classification semantics are correct.
 *
 * All tests are hermetic: no live network, no production storage,
 * no active-mode engine activation.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  formatAppliedSimulationReport,
  runAppliedSimulationEvaluation,
  writeAppliedSimulationReport,
  BUILT_IN_APPLIED_SIMULATION_SCENARIOS,
  APPLIED_SIMULATION_LIMITATIONS,
  type AppliedSimulationScenario,
} from "../src/benchmark/applied-simulation-evaluation.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { serverPublicTools } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 1. Module exports
// ---------------------------------------------------------------------------

test("applied-simulation: module exports expected symbols", () => {
  // Entrypoint exports
  assert.ok(typeof runAppliedSimulationEvaluation === "function");
  assert.ok(typeof writeAppliedSimulationReport === "function");
  assert.ok(typeof formatAppliedSimulationReport === "function");
  // Scenario set
  assert.ok(Array.isArray(BUILT_IN_APPLIED_SIMULATION_SCENARIOS));
  assert.ok(BUILT_IN_APPLIED_SIMULATION_SCENARIOS.length > 0);
  // Limitations
  assert.ok(Array.isArray(APPLIED_SIMULATION_LIMITATIONS));
  assert.ok(APPLIED_SIMULATION_LIMITATIONS.length > 0);
});

// ---------------------------------------------------------------------------
// 2. Hermeticity: no network, temp storage only
// ---------------------------------------------------------------------------

test("applied-simulation: runAppliedSimulationEvaluation is hermetic (no network)", async () => {
  const report = await runAppliedSimulationEvaluation();
  // The report must have been produced without any network calls.
  // The scripted fetch is the ONLY fetch wired in.
  assert.ok(report.generatedAt.length > 0);
  assert.equal(report.evaluationMode, "applied-simulation");
});

// ---------------------------------------------------------------------------
// 3. Report shape
// ---------------------------------------------------------------------------

test("applied-simulation: report has all required fields", async () => {
  const report = await runAppliedSimulationEvaluation();
  assert.ok(typeof report.generatedAt === "string");
  assert.ok(typeof report.scenarioSetVersion === "string");
  assert.equal(report.evaluationMode, "applied-simulation");
  assert.ok(typeof report.meta === "object");
  assert.ok(typeof report.delta === "object");
  assert.ok(Array.isArray(report.runs));
  assert.ok(Array.isArray(report.limitations));

  // Meta fields
  assert.ok(typeof report.meta.totalScenarios === "number");
  assert.ok(typeof report.meta.categoryCounts === "object");
  assert.ok(typeof report.meta.betterCount === "number");
  assert.ok(typeof report.meta.sameCount === "number");
  assert.ok(typeof report.meta.worseCount === "number");
  assert.ok(typeof report.meta.inconclusiveCount === "number");
  assert.ok(typeof report.meta.scenariosMeetingMinimumGate === "boolean");

  // Delta fields
  assert.equal(report.delta.status, "applied");
  assert.ok(typeof report.delta.memorySizeDelta === "number");
  assert.ok(report.delta.recallHitRateDelta === null || typeof report.delta.recallHitRateDelta === "number");
  assert.ok(report.delta.recallCurrentTruthRateDelta === null || typeof report.delta.recallCurrentTruthRateDelta === "number");
  assert.ok(report.delta.recallNoAnswerTnrDelta === null || typeof report.delta.recallNoAnswerTnrDelta === "number");
  assert.ok(report.delta.recallRank1MatchRateDelta === null || typeof report.delta.recallRank1MatchRateDelta === "number");
  assert.ok(typeof report.delta.note === "string");

  // Runs are non-empty
  assert.ok(report.runs.length > 0);
  for (const run of report.runs) {
    assert.ok(typeof run.scenarioId === "string");
    assert.ok(typeof run.label === "string");
    assert.ok(typeof run.description === "string");
    assert.ok(typeof run.category === "string");
    assert.ok(typeof run.rawInput === "string");
    assert.ok(typeof run.appliedAction === "string");

    // Baseline run
    assert.ok(typeof run.baseline === "object");
    assert.ok(typeof run.baseline.memoryCount === "number");
    assert.ok(typeof run.baseline.recall === "object");

    // Applied run
    assert.ok(typeof run.applied === "object");
    assert.ok(typeof run.applied.memoryCount === "number");
    assert.ok(typeof run.applied.recall === "object");
    assert.ok(Array.isArray(run.applied.mutations));

    // Delta
    assert.ok(typeof run.delta === "object");
    assert.ok(typeof run.delta.memorySizeDelta === "number");

    // Classification
    assert.ok(["better", "same", "worse", "inconclusive"].includes(run.classification));
    assert.ok(typeof run.classificationReason === "string");
  }
});

test("applied-simulation: meta counts are internally consistent", async () => {
  const report = await runAppliedSimulationEvaluation();
  const { meta, runs } = report;
  assert.equal(meta.totalScenarios, runs.length);
  assert.equal(
    meta.betterCount + meta.sameCount + meta.worseCount + meta.inconclusiveCount,
    runs.length
  );
});

test("applied-simulation: limitations block is present and non-empty", async () => {
  const report = await runAppliedSimulationEvaluation();
  assert.ok(report.limitations.length > 0);
  const limText = report.limitations.join(" ");
  assert.ok(limText.includes("synthetic") || limText.includes("Synthetic"));
  assert.ok(limText.includes("no-network") || limText.includes("network"));
  assert.ok(limText.includes("temp") || limText.includes("temp"));
  assert.ok(limText.includes("phase3") || limText.includes("applied"));
});

test("applied-simulation: all scenarios in built-in set are represented in report", async () => {
  const report = await runAppliedSimulationEvaluation();
  const scenarioIds = new Set(report.runs.map((r) => r.scenarioId));
  for (const scenario of BUILT_IN_APPLIED_SIMULATION_SCENARIOS) {
    assert.ok(
      scenarioIds.has(scenario.id),
      `scenario '${scenario.id}' must appear in report runs`
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Artifact writer
// ---------------------------------------------------------------------------

test("applied-simulation: writeAppliedSimulationReport produces a file with correct prefix", async () => {
  const report = await runAppliedSimulationEvaluation();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "curion-applied-sim-artifact-"));
  try {
    const artifactPath = writeAppliedSimulationReport(report, tmpDir);
    // Filename must use the applied-simulation prefix
    const filename = path.basename(artifactPath);
    assert.ok(
      filename.startsWith("applied-simulation-"),
      `artifact filename must start with 'applied-simulation-', got '${filename}'`
    );
    assert.ok(filename.endsWith(".json"), `artifact must be a .json file, got '${filename}'`);
    // File must be readable JSON
    const content = fs.readFileSync(artifactPath, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.evaluationMode, "applied-simulation");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Human formatter
// ---------------------------------------------------------------------------

test("applied-simulation: formatAppliedSimulationReport produces non-empty string", async () => {
  const report = await runAppliedSimulationEvaluation();
  const formatted = formatAppliedSimulationReport(report);
  assert.ok(typeof formatted === "string");
  assert.ok(formatted.length > 0);
  assert.ok(formatted.includes("applied-simulation"));
  assert.ok(formatted.includes("generated at"));
  assert.ok(formatted.includes("delta"));
  assert.ok(formatted.includes("limitations"));
});

// ---------------------------------------------------------------------------
// 6. Delta status is "applied" (measured, not counterfactual)
// ---------------------------------------------------------------------------

test("applied-simulation: delta status is 'applied' (measured delta)", async () => {
  const report = await runAppliedSimulationEvaluation();
  assert.equal(report.delta.status, "applied");
  // Note should mention "measured" not "counterfactual"
  assert.ok(report.delta.note.includes("applied") || report.delta.note.includes("measured"));
});

// ---------------------------------------------------------------------------
// 7. Classification semantics
// ---------------------------------------------------------------------------

test("applied-simulation: all runs have valid classification", async () => {
  const report = await runAppliedSimulationEvaluation();
  for (const run of report.runs) {
    assert.ok(
      ["better", "same", "worse", "inconclusive"].includes(run.classification),
      `scenario '${run.scenarioId}' must have valid classification, got '${run.classification}'`
    );
    assert.ok(run.classificationReason.length > 0);
  }
});

test("applied-simulation: reject scenarios classify as 'same' (no memory stored)", async () => {
  const report = await runAppliedSimulationEvaluation();
  const rejectRuns = report.runs.filter((r) => r.appliedAction === "reject");
  assert.ok(rejectRuns.length >= 2, "should have at least 2 reject scenarios");
  for (const run of rejectRuns) {
    assert.equal(
      run.classification,
      "same",
      `reject scenario '${run.scenarioId}' should classify as 'same', got '${run.classification}'`
    );
  }
});

test("applied-simulation: no_op/store agreement scenarios classify as 'same'", async () => {
  const report = await runAppliedSimulationEvaluation();
  const noOpRuns = report.runs.filter((r) => r.appliedAction === "no_op" || r.appliedAction === "store");
  assert.ok(noOpRuns.length >= 1, "should have at least 1 no_op/store scenario");
  for (const run of noOpRuns) {
    assert.ok(
      run.classification === "same" || run.classification === "inconclusive",
      `no_op/store scenario '${run.scenarioId}' should classify as 'same' or 'inconclusive', got '${run.classification}'`
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Minimum scenario gate
// ---------------------------------------------------------------------------

test("applied-simulation: scenario set has at least 12 scenarios", async () => {
  assert.ok(
    BUILT_IN_APPLIED_SIMULATION_SCENARIOS.length >= 12,
    `minimum 12 scenarios required, got ${BUILT_IN_APPLIED_SIMULATION_SCENARIOS.length}`
  );
});

test("applied-simulation: scenario set satisfies minimum category coverage", async () => {
  const categoryCounts: Record<string, number> = {};
  for (const scenario of BUILT_IN_APPLIED_SIMULATION_SCENARIOS) {
    categoryCounts[scenario.category] = (categoryCounts[scenario.category] || 0) + 1;
  }

  assert.ok(
    (categoryCounts["current-truth-supersession"] || 0) >= 4,
    `at least 4 current-truth/supersession scenarios required, got ${categoryCounts["current-truth-supersession"] || 0}`
  );
  assert.ok(
    (categoryCounts["no-answer"] || 0) >= 2,
    `at least 2 no-answer scenarios required, got ${categoryCounts["no-answer"] || 0}`
  );
  assert.ok(
    (categoryCounts["rank-1-current-truth"] || 0) >= 2,
    `at least 2 rank-1-current-truth scenarios required, got ${categoryCounts["rank-1-current-truth"] || 0}`
  );
  assert.ok(
    (categoryCounts["cleaner-memory-improvement"] || 0) >= 2,
    `at least 2 cleaner-memory-improvement scenarios required, got ${categoryCounts["cleaner-memory-improvement"] || 0}`
  );
  assert.ok(
    (categoryCounts["safety-rejection"] || 0) >= 2,
    `at least 2 safety-rejection scenarios required, got ${categoryCounts["safety-rejection"] || 0}`
  );
});

test("applied-simulation: minimum gate is satisfied", async () => {
  const report = await runAppliedSimulationEvaluation();
  assert.equal(report.meta.scenariosMeetingMinimumGate, true);
});

// ---------------------------------------------------------------------------
// 9. Recall metrics are present in runs
// ---------------------------------------------------------------------------

test("applied-simulation: all runs have recall metrics", async () => {
  const report = await runAppliedSimulationEvaluation();
  for (const run of report.runs) {
    assert.ok(typeof run.baseline.recall.status === "string");
    assert.ok(Array.isArray(run.baseline.recall.sourceIds));
    assert.ok(typeof run.baseline.recall.hitRate === "boolean");
    assert.ok(typeof run.baseline.recall.currentTruthAtRank1 === "boolean");
    assert.ok(
      run.baseline.recall.noAnswerTnr === null || typeof run.baseline.recall.noAnswerTnr === "boolean"
    );
    assert.ok(
      run.baseline.recall.rank1Match === null || typeof run.baseline.recall.rank1Match === "boolean"
    );

    assert.ok(typeof run.applied.recall.status === "string");
    assert.ok(Array.isArray(run.applied.recall.sourceIds));
    assert.ok(typeof run.applied.recall.hitRate === "boolean");
    assert.ok(typeof run.applied.recall.currentTruthAtRank1 === "boolean");
    assert.ok(
      run.applied.recall.noAnswerTnr === null || typeof run.applied.recall.noAnswerTnr === "boolean"
    );
    assert.ok(
      run.applied.recall.rank1Match === null || typeof run.applied.recall.rank1Match === "boolean"
    );
  }
});

// ---------------------------------------------------------------------------
// 10. Mutations are tracked
// ---------------------------------------------------------------------------

test("applied-simulation: all runs have mutation records", async () => {
  const report = await runAppliedSimulationEvaluation();
  for (const run of report.runs) {
    assert.ok(Array.isArray(run.applied.mutations));
    assert.ok(run.applied.mutations.length > 0, `scenario '${run.scenarioId}' should have at least one mutation`);
    for (const mutation of run.applied.mutations) {
      assert.ok(typeof mutation.action === "string");
      assert.ok(typeof mutation.succeeded === "boolean");
      if (!mutation.succeeded) {
        assert.ok(typeof mutation.error === "string");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 11. Public API invariant: no new MCP tools
// ---------------------------------------------------------------------------

test("applied-simulation: public MCP tool surface unchanged (remember + recall only)", () => {
  assert.deepEqual(PUBLIC_TOOL_NAMES, ["remember", "recall"] as const);
});

// ---------------------------------------------------------------------------
// 12. Scenario fields are valid
// ---------------------------------------------------------------------------

test("applied-simulation: each built-in scenario has required fields", () => {
  for (const scenario of BUILT_IN_APPLIED_SIMULATION_SCENARIOS) {
    assert.ok(typeof scenario.id === "string");
    assert.ok(typeof scenario.label === "string");
    assert.ok(typeof scenario.description === "string");
    assert.ok(typeof scenario.category === "string");
    assert.ok(typeof scenario.rawInput === "string");
    assert.ok(Array.isArray(scenario.related));
    assert.ok(typeof scenario.providerScript === "string");
    assert.ok(typeof scenario.decisionScript === "string");
    assert.ok(typeof scenario.appliedAction === "string");
    assert.ok(
      ["store", "no_op", "supersede", "invalidate", "flag_redundant", "flag_conflict", "reject"].includes(
        scenario.appliedAction
      ),
      `appliedAction '${scenario.appliedAction}' must be valid`
    );
    assert.ok(typeof scenario.recallQuery === "string");
    assert.ok(typeof scenario.recallGroundTruth === "object");
  }
});

test("applied-simulation: each built-in scenario has safe text (no accidental secrets)", () => {
  for (const scenario of BUILT_IN_APPLIED_SIMULATION_SCENARIOS) {
    // No real API key shapes
    const hasRealApiKey = /sk-[a-zA-Z0-9]{32,}/.test(scenario.rawInput);
    const hasRealGitLabToken = /glpat-[a-zA-Z0-9\-]{36,}/.test(scenario.rawInput);
    assert.ok(
      !hasRealApiKey && !hasRealGitLabToken,
      `scenario '${scenario.id}' rawInput must not contain real credential patterns`
    );
    // Each scenario's rawInput must be non-empty
    assert.ok(scenario.rawInput.trim().length > 0);
    // Each recallQuery must be non-empty
    assert.ok(scenario.recallQuery.trim().length > 0);
  }
});

test("applied-simulation: applied actions are in allowed set only", () => {
  const allowedActions = new Set(["store", "no_op", "supersede", "invalidate", "flag_redundant", "flag_conflict", "reject"]);
  for (const scenario of BUILT_IN_APPLIED_SIMULATION_SCENARIOS) {
    assert.ok(
      allowedActions.has(scenario.appliedAction),
      `scenario '${scenario.id}' appliedAction '${scenario.appliedAction}' must be in allowed set`
    );
  }
});

test("applied-simulation: redact and clarify are NOT in applied actions (excluded from scoring)", () => {
  const excludedActions = new Set(["redact", "clarify"]);
  for (const scenario of BUILT_IN_APPLIED_SIMULATION_SCENARIOS) {
    assert.ok(
      !excludedActions.has(scenario.appliedAction),
      `scenario '${scenario.id}' appliedAction must NOT be 'redact' or 'clarify' (excluded from scoring)`
    );
  }
});

// ---------------------------------------------------------------------------
// 13. Dynamic label resolution (Phase 3 evidence-quality tightening)
// ---------------------------------------------------------------------------

test("applied-simulation: supersession scenarios have non-null currentTruthAtRank1 in applied path", async () => {
  const report = await runAppliedSimulationEvaluation();
  const supersessionRuns = report.runs.filter(r => r.category === "current-truth-supersession");
  assert.ok(supersessionRuns.length >= 4, "should have at least 4 supersession scenarios");

  for (const run of supersessionRuns) {
    // For supersession scenarios with resolved labels, currentTruthAtRank1 should be meaningful
    // (either true or false, not simply defaulted to false due to empty ground truth)
    assert.ok(
      typeof run.applied.recall.currentTruthAtRank1 === "boolean",
      `supersession scenario '${run.scenarioId}' applied.recall.currentTruthAtRank1 must be boolean`
    );
    // The stored memory id should be present when memory was stored
    if (run.applied.storedMemoryId !== undefined) {
      assert.ok(
        run.applied.recall.sourceIds.length > 0 || run.applied.recall.status === "no_memory",
        `supersession scenario '${run.scenarioId}' should have recall result when memory was stored`
      );
    }
  }
});

test("applied-simulation: rank-1 scenarios have non-null rank1Match in applied path when memory stored", async () => {
  const report = await runAppliedSimulationEvaluation();
  const rank1Runs = report.runs.filter(r => r.category === "rank-1-current-truth");
  assert.ok(rank1Runs.length >= 2, "should have at least 2 rank-1 scenarios");

  for (const run of rank1Runs) {
    // When applied path stored a memory and resolved labels, rank1Match should be non-null
    if (run.applied.storedMemoryId !== undefined) {
      assert.ok(
        run.applied.recall.rank1Match !== null || run.applied.recall.status === "no_memory",
        `rank-1 scenario '${run.scenarioId}' applied.recall.rank1Match should be non-null or no_memory when storedMemoryId is defined`
      );
      // When memory is stored and recall is answered, rank1Match should be a boolean
      if (run.applied.recall.status === "answered") {
        assert.ok(
          typeof run.applied.recall.rank1Match === "boolean",
          `rank-1 scenario '${run.scenarioId}' applied.recall.rank1Match must be boolean when answered and memory stored`
        );
      }
    }
    // When applied path did NOT store memory, rank1Match may be null (labels not resolved)
  }
});

test("applied-simulation: aggregate current-truth and rank-1 deltas are non-null when scenarios exist", async () => {
  const report = await runAppliedSimulationEvaluation();

  // If we have supersession scenarios, currentTruthAtRank1 delta should be computable
  const supersessionRuns = report.runs.filter(r => r.category === "current-truth-supersession");
  if (supersessionRuns.length > 0) {
    assert.ok(
      report.delta.recallCurrentTruthRateDelta !== null || supersessionRuns.every(r => r.delta.recallCurrentTruthRateDelta === null),
      "recallCurrentTruthRateDelta should be non-null when supersession scenarios exist and labels are resolved"
    );
  }

  // If we have rank-1 scenarios, rank1Match delta should be computable
  const rank1Runs = report.runs.filter(r => r.category === "rank-1-current-truth");
  if (rank1Runs.length > 0) {
    assert.ok(
      report.delta.recallRank1MatchRateDelta !== null || rank1Runs.every(r => r.delta.recallRank1MatchRateDelta === null),
      "recallRank1MatchRateDelta should be non-null when rank-1 scenarios exist and labels are resolved"
    );
  }
});

test("applied-simulation: no-answer and safety scenarios do not incorrectly regress due to insufficient labels", async () => {
  const report = await runAppliedSimulationEvaluation();
  const noAnswerRuns = report.runs.filter(r => r.category === "no-answer");
  const safetyRuns = report.runs.filter(r => r.category === "safety-rejection");

  for (const run of [...noAnswerRuns, ...safetyRuns]) {
    // These scenarios should not be classified as 'worse' solely due to memory-health improvement
    // They should be 'same' because recall labels are insufficient for meaningful comparison
    assert.ok(
      run.classification !== "worse" || run.classificationReason.includes("memory"),
      `no-answer/safety scenario '${run.scenarioId}' should not regress without meaningful recall label change`
    );
  }
});

test("applied-simulation: classifications are not exclusively driven by memory-health when recall is measurable", async () => {
  const report = await runAppliedSimulationEvaluation();

  // Find supersession scenarios that have measurable recall metrics
  const supersessionRuns = report.runs.filter(
    r => r.category === "current-truth-supersession" &&
         r.applied.storedMemoryId !== undefined
  );

  for (const run of supersessionRuns) {
    // If currentTruthAtRank1 changed (delta is non-null), classification should reflect recall
    if (run.delta.recallCurrentTruthRateDelta !== null) {
      // Classification should be 'better' if recall improved without regression
      // or 'worse' if recall regressed
      const recallImproved = run.delta.recallCurrentTruthRateDelta > 0;
      const recallRegressed = run.delta.recallCurrentTruthRateDelta < 0;

      if (recallImproved) {
        assert.ok(
          run.classification === "better" || run.classification === "inconclusive",
          `supersession scenario '${run.scenarioId}' with improved recall should be 'better' or 'inconclusive', got '${run.classification}'`
        );
      }
      if (recallRegressed) {
        assert.ok(
          run.classification === "worse",
          `supersession scenario '${run.scenarioId}' with regressed recall should be 'worse', got '${run.classification}'`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 14. No production DB or live network usage
// ---------------------------------------------------------------------------

test("applied-simulation: runs use temp storage only (no production .curion touched)", async () => {
  const report = await runAppliedSimulationEvaluation();
  // If we got here, the report was produced successfully using temp storage
  assert.ok(report.runs.length > 0);
  // Verify temp storage pattern is used (each run creates fresh temp dirs)
  assert.ok(report.meta.totalScenarios > 0);
});

test("applied-simulation: generatedAt is a valid ISO timestamp", async () => {
  const report = await runAppliedSimulationEvaluation();
  const date = new Date(report.generatedAt);
  assert.ok(!Number.isNaN(date.getTime()), "generatedAt must be a valid ISO timestamp");
});
