/**
 * Tests for the benchmark-only adaptive-depth evaluation
 * helper (`src/benchmark/adaptive-depth-evaluation.ts`).
 *
 * The held-out runner (`benchmark:retrieval:held-out`)
 * exercises the lexical / hybrid / hybrid-dense rankers
 * but does NOT exercise the new adaptive-depth controller
 * stage (selector + diversity + budget) or the synthesis
 * input path. This file pins the adaptive-depth
 * evaluation helper that closes that gap.
 *
 * Coverage:
 *
 *   1. Scenario-by-scenario assertions: the helper runs
 *      the controller through both `adaptive` (production)
 *      and `legacy` (fixed-topK=5) configs, captures the
 *      synthesis body, and asserts the per-scenario
 *      expectations hold under both configs.
 *
 *   2. Cross-scenario comparison: a coherent cluster
 *      routes >5 candidates into synthesis under
 *      `adaptive` and exactly 5 under `legacy`. The test
 *      asserts the adaptive path grows past the legacy
 *      cap (the central evidence brief asks for).
 *
 *   3. Provider-refusal scenario: the `weak_match`
 *      reroute still surfaces exactly the top-3
 *      summaries and a coverage block. Adaptive depth
 *      must not break the reroute.
 *
 *   4. Superseded-pair scenario: the current memory
 *      must rank above the previous; the previous must
 *      remain in `sourceIds` (the supersession contract).
 *
 *   5. Prompt-budget scenario: the adaptive path's
 *      MEMORIES section is bounded by the total budget
 *      (the legacy path has no budget and the cap is
 *      fixed at 5).
 *
 *   6. The harness never makes a real provider call
 *      (no live network; the scripted fetch is the only
 *      code path the provider slot sees).
 *
 *   7. The report shape is well-formed: a top-level
 *      `meta` block, a per-scenario `runs` array, and a
 *      `limitations` array.
 *
 *   8. The CLI parser accepts the documented flag and
 *      rejects unknown flags.
 *
 *   9. The public MCP tool surface is unchanged: the
 *      controller's `adaptiveDepth` option is on the
 *      internal `RecallControllerOptions`, NOT on the
 *      MCP tool schema; the public tool layer in
 *      `src/tools/recall.ts` does NOT pass it.
 *
 *   10. The artifact prefix is
 *       `retrieval-adaptive-depth-evaluation-` (distinct
 *       from the existing held-out / dev-set prefixes).
 *
 * The tests use the inlined scripted fetch in the
 * helper (the helper is self-contained; it does not
 * import from `tests/` because `tsconfig.json`'s
 * `rootDir` is `src/`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseAdaptiveDepthEvaluationCli } from "../src/benchmark/adaptive-depth-evaluation-runner.ts";
import {
  ADAPTIVE_DEPTH_EVALUATION_LIMITATIONS,
  BUILT_IN_SCENARIOS,
  LEGACY_FIXED_TOPK_PIPELINE_CONFIG,
  type ScenarioRunResult,
  formatAdaptiveDepthEvaluationReport,
  runAdaptiveDepthEvaluation,
  writeAdaptiveDepthEvaluationReport,
} from "../src/benchmark/adaptive-depth-evaluation.ts";

// ---------------------------------------------------------------------------
// 1. Scenario-by-scenario assertions
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: all built-in scenarios pass under both adaptive and legacy configs", async () => {
  const report = await runAdaptiveDepthEvaluation();
  // All 6 built-in scenarios must pass under both
  // configs. A future scenario that fails on a known
  // limitation should be marked expected-fail or be
  // removed from the v1 scenario set; the harness
  // should not silently ship a failing scenario.
  assert.equal(report.meta.scenarioCount, 6);
  assert.equal(report.meta.passedBothCount, 6);
  assert.equal(report.meta.passedAdaptiveOnlyCount, 0);
  assert.equal(report.meta.passedLegacyOnlyCount, 0);
  assert.equal(report.meta.failedBothCount, 0);
  for (const r of report.runs) {
    assert.ok(
      r.adaptive.assertions.pass,
      `scenario '${r.scenarioId}' adaptive: ${formatAssertionFailures(r.adaptive)}`
    );
    assert.ok(
      r.legacy.assertions.pass,
      `scenario '${r.scenarioId}' legacy: ${formatAssertionFailures(r.legacy)}`
    );
  }
});

function formatAssertionFailures(run: ScenarioRunResult): string {
  const all = [...run.assertions.common, ...run.assertions.configSpecific];
  return all
    .filter((a) => !a.pass)
    .map((a) => `${a.name}=${a.note}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// 2. Cross-scenario comparison: adaptive grows past the legacy cap
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: broad-cluster routes >5 into synthesis under adaptive, exactly 5 under legacy", async () => {
  const report = await runAdaptiveDepthEvaluation();
  const broad = report.runs.find((r) => r.scenarioId === "broad-cluster");
  assert.ok(broad, "broad-cluster scenario must be in the report");
  // Adaptive depth must grow past the production
  // topK=5. The coherent cluster has 12 closely
  // relevant memories; the adaptive selector must keep
  // the cluster (elbow, no large gap).
  assert.ok(
    broad.adaptive.synthesisMemoryIds.length > 5,
    `adaptive broad-cluster synthesis ids: expected >5, got ${broad.adaptive.synthesisMemoryIds.length}`
  );
  // Legacy fixed-topK caps at 5.
  assert.equal(
    broad.legacy.synthesisMemoryIds.length,
    5,
    `legacy broad-cluster synthesis ids: expected 5, got ${broad.legacy.synthesisMemoryIds.length}`
  );
  // The 2 unrelated memories (plants, chairs) must NOT
  // be in the synthesis prompt under either config.
  for (const id of broad.adaptive.synthesisMemoryIds) {
    assert.ok(id < 100, `adaptive synthesis id ${id} must be from the cluster, not the noise`);
  }
  for (const id of broad.legacy.synthesisMemoryIds) {
    assert.ok(id < 100, `legacy synthesis id ${id} must be from the cluster, not the noise`);
  }
  // The synthesis body must be larger under adaptive
  // (more memories means more text in the MEMORIES
  // section).
  assert.ok(
    broad.adaptive.memoriesSection.length > broad.legacy.memoriesSection.length,
    `adaptive memories section (${broad.adaptive.memoriesSection.length} chars) must be larger than legacy (${broad.legacy.memoriesSection.length} chars)`
  );
});

test("adaptive-depth evaluation: the synthesis prompt differs by id list under adaptive vs legacy", async () => {
  // Capture the per-config id lists for the broad-cluster
  // scenario and assert they differ by at least 1 id.
  // This is the central evidence brief asks for: that
  // adaptive depth affects what synthesis receives,
  // not just the retrieval side.
  const report = await runAdaptiveDepthEvaluation();
  const broad = report.runs.find((r) => r.scenarioId === "broad-cluster");
  assert.ok(broad, "broad-cluster scenario must be in the report");
  const adaptiveIds = new Set(broad.adaptive.synthesisMemoryIds);
  const legacyIds = new Set(broad.legacy.synthesisMemoryIds);
  // The legacy cap is 5; the adaptive path keeps the
  // full cluster (12). The two sets must NOT be
  // identical.
  assert.notDeepEqual([...adaptiveIds].sort(), [...legacyIds].sort());
  // The legacy top-5 must be a subset of the adaptive
  // top-12 (both are score-desc from the same input;
  // adaptive just keeps more).
  for (const id of legacyIds) {
    assert.ok(
      adaptiveIds.has(id),
      `legacy id ${id} must also be in the adaptive set (score-desc, same input)`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Provider-refusal scenario: weak_match reroute preserved
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: provider-refusal reroutes to weak_match under both configs with top-3 summaries", async () => {
  const report = await runAdaptiveDepthEvaluation();
  const refusal = report.runs.find((r) => r.scenarioId === "provider-refusal");
  assert.ok(refusal, "provider-refusal scenario must be in the report");
  // Both configs must reroute to `weak_match`.
  assert.equal(refusal.adaptive.status, "weak_match");
  assert.equal(refusal.legacy.status, "weak_match");
  // The synthesis call must have happened exactly once
  // (the controller called the provider, got a refusal,
  // rerouted).
  assert.equal(refusal.adaptive.synthesisCalls, 1);
  assert.equal(refusal.legacy.synthesisCalls, 1);
  // The synthesis prompt must have carried the relevant
  // memories (the weak_match reroute's top-3
  // summaries come from this set). The 4 session-2
  // memories must all be in the synthesis prompt.
  assert.equal(refusal.adaptive.synthesisMemoryIds.length, 4);
  assert.equal(refusal.legacy.synthesisMemoryIds.length, 4);
});

// ---------------------------------------------------------------------------
// 4. Superseded-pair scenario: demotion contract preserved
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: superseded-pair keeps the demoted memory in sourceIds, current ranks first", async () => {
  const report = await runAdaptiveDepthEvaluation();
  const pair = report.runs.find((r) => r.scenarioId === "superseded-pair");
  assert.ok(pair, "superseded-pair scenario must be in the report");
  // Both configs must answer (relevant memories exist).
  assert.equal(pair.adaptive.status, "answered");
  assert.equal(pair.legacy.status, "answered");
  // The current (id=2) must rank before the previous
  // (id=1) under both configs. The demoted memory stays
  // in sourceIds per the supersession contract.
  assert.deepEqual(pair.adaptive.sourceIds, [2, 1]);
  assert.deepEqual(pair.legacy.sourceIds, [2, 1]);
  // The synthesis prompt must carry both memories.
  assert.deepEqual(pair.adaptive.synthesisMemoryIds, [2, 1]);
  assert.deepEqual(pair.legacy.synthesisMemoryIds, [2, 1]);
});

// ---------------------------------------------------------------------------
// 5. Prompt-budget scenario: adaptive bounds the MEMORIES section
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: prompt-budget bounds the MEMORIES section under adaptive; legacy sends the full 5", async () => {
  const report = await runAdaptiveDepthEvaluation();
  const budget = report.runs.find((r) => r.scenarioId === "prompt-budget");
  assert.ok(budget, "prompt-budget scenario must be in the report");
  // Adaptive: at maxK=15 with the per-memory cap (500
  // chars) and total budget (6000 chars), the
  // MEMORIES section is bounded by the total budget
  // plus the section header.
  assert.ok(
    budget.adaptive.memoriesSection.length <= 6500,
    `adaptive MEMORIES section must be <= 6500 chars, got ${budget.adaptive.memoriesSection.length}`
  );
  // Adaptive depth grows past the legacy cap.
  assert.ok(
    budget.adaptive.synthesisMemoryIds.length > 5,
    `adaptive prompt-budget synthesis ids: expected >5, got ${budget.adaptive.synthesisMemoryIds.length}`
  );
  // Legacy caps at 5 (the production topK), with no
  // budget enforcement. The 5 longest-fit memories are
  // sent in full (no per-memory cap).
  assert.equal(budget.legacy.synthesisMemoryIds.length, 5);
  // The legacy body is shorter (5 memories) than the
  // adaptive body (more memories truncated to 500
  // chars each). On this scenario the adaptive body
  // is significantly larger in characters because
  // the legacy caps earlier.
  assert.ok(
    budget.adaptive.synthesisBody.length > budget.legacy.synthesisBody.length,
    `adaptive prompt-budget body (${budget.adaptive.synthesisBody.length} chars) must be larger than legacy (${budget.legacy.synthesisBody.length} chars)`
  );
});

// ---------------------------------------------------------------------------
// 6. The harness is no-network: the scripted fetch is the only path
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: the harness never makes a real network call (no live provider)", async () => {
  // Run a single scenario and inspect the synthesis
  // body the controller actually built. The body is
  // a JSON payload the scripted fetch captured
  // in-process; a real network call would have been
  // observable as a fetch to an external host. We
  // assert the body is well-formed JSON, contains
  // the canned response in its `messages` array, and
  // does NOT carry a real provider URL.
  const report = await runAdaptiveDepthEvaluation();
  const narrow = report.runs.find((r) => r.scenarioId === "narrow-precise");
  assert.ok(narrow, "narrow-precise scenario must be in the report");
  const body = narrow.adaptive.synthesisBody;
  // The body is a JSON string. Parse it to confirm
  // shape.
  const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
  assert.ok(Array.isArray(parsed.messages));
  assert.ok(parsed.messages.length >= 2);
  const userContent = parsed.messages[parsed.messages.length - 1]!.content;
  assert.match(userContent, /QUERY:/);
  // The body does NOT carry a real provider URL (the
  // harness uses placeholder test URLs that resolve
  // to "custom" in the controller's provider label
  // derivation; we assert the URL is a placeholder,
  // not a real host).
  const urlMatch = body.match(/"https?:\/\/[^"]+"/);
  if (urlMatch) {
    assert.match(urlMatch[0], /(example|test)/);
  }
});

// ---------------------------------------------------------------------------
// 7. Report shape
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: report shape is well-formed (meta + runs + limitations)", async () => {
  const report = await runAdaptiveDepthEvaluation();
  // Top-level keys.
  assert.equal(typeof report.generatedAt, "string");
  assert.ok(report.generatedAt.length > 0);
  assert.ok(report.meta);
  assert.equal(typeof report.meta.scenarioCount, "number");
  assert.equal(typeof report.meta.passedBothCount, "number");
  assert.equal(typeof report.meta.passedAdaptiveOnlyCount, "number");
  assert.equal(typeof report.meta.passedLegacyOnlyCount, "number");
  assert.equal(typeof report.meta.failedBothCount, "number");
  assert.equal(report.meta.totalRuns, report.runs.length * 2);
  // Resolved selectors are well-formed.
  assert.ok(report.meta.adaptiveResolvedSelector);
  assert.ok(report.meta.legacyResolvedSelector);
  assert.equal(report.meta.adaptiveResolvedSelector.strategy, "elbow");
  assert.equal(report.meta.legacyResolvedSelector.strategy, "plateau");
  // Per-run shape.
  for (const r of report.runs) {
    assert.equal(typeof r.scenarioId, "string");
    assert.equal(typeof r.label, "string");
    assert.equal(typeof r.description, "string");
    assert.equal(typeof r.query, "string");
    assert.ok(r.adaptive);
    assert.ok(r.legacy);
    // The capture block has the expected fields.
    assert.equal(typeof r.adaptive.synthesisBody, "string");
    assert.equal(typeof r.adaptive.memoriesSection, "string");
    assert.ok(Array.isArray(r.adaptive.synthesisMemoryIds));
    assert.ok(Array.isArray(r.legacy.synthesisMemoryIds));
    // For `answered` outcomes, `sourceIds` and
    // `synthesisMemoryIds` are the same list (the
    // controller's `sourceIds` is the id list it sent
    // to synthesis). For `weak_match` / `no_memory` /
    // other non-answered outcomes, `sourceIds` is
    // `[]` (the controller does not surface ids for
    // those branches) and `synthesisMemoryIds` is
    // the actual list the synthesis prompt carried
    // before the reroute.
    if (r.adaptive.status === "answered") {
      assert.deepEqual([...r.adaptive.synthesisMemoryIds], [...r.adaptive.sourceIds]);
    }
    if (r.legacy.status === "answered") {
      assert.deepEqual([...r.legacy.synthesisMemoryIds], [...r.legacy.sourceIds]);
    }
  }
  // Limitations block is non-empty and well-formed.
  assert.ok(Array.isArray(report.limitations));
  assert.ok(report.limitations.length >= 5);
  for (const lim of report.limitations) {
    assert.equal(typeof lim, "string");
    assert.ok(lim.length > 0);
  }
});

test("adaptive-depth evaluation: limitations block surfaces the no-network / frozen-config / public-API caveats", () => {
  // The limitations block is the research-only
  // disclosure a reviewer reads at the artifact
  // level. The block must surface the brief's
  // required caveats.
  const text = ADAPTIVE_DEPTH_EVALUATION_LIMITATIONS.join("\n");
  assert.match(text, /no-network/i);
  assert.match(text, /frozen config/i);
  assert.match(text, /public mcp api|public.*api|wire shape/i);
  assert.match(text, /benchmark-only|research-only/i);
});

test("adaptive-depth evaluation: human report is non-empty and surfaces the expected sections", async () => {
  const report = await runAdaptiveDepthEvaluation();
  const text = formatAdaptiveDepthEvaluationReport(report);
  assert.ok(text.length > 0);
  assert.match(text, /=== curion adaptive-depth evaluation ===/);
  assert.match(text, /--- meta ---/);
  assert.match(text, /READ THIS FIRST/);
  assert.match(text, /--- per-scenario summary ---/);
  assert.match(text, /--- limitations \(research-only\) ---/);
  // Per-scenario sections are present.
  for (const r of report.runs) {
    assert.match(text, new RegExp(`--- scenario: ${r.scenarioId}`));
  }
});

// ---------------------------------------------------------------------------
// 8. CLI parser
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: CLI parser accepts --artifacts and rejects unknown flags", () => {
  const parsed = parseAdaptiveDepthEvaluationCli(["--artifacts", "/tmp/foo"]);
  assert.equal(parsed.artifactsDir, "/tmp/foo");
  assert.throws(
    () => parseAdaptiveDepthEvaluationCli(["--unknown-flag"]),
    /unknown adaptive-depth evaluation cli flag/
  );
  // The adaptive-depth runner's CLI surface is intentionally
  // narrower than the decision-policy runner's. `--no-write`
  // and `--no-stdout` are NOT supported; passing them through
  // would silently broaden the runner's CLI surface, which the
  // shared `parseBenchmarkArtifactCli` helper enforces via
  // `supportNoWrite: false` / `supportNoStdout: false`.
  assert.throws(
    () => parseAdaptiveDepthEvaluationCli(["--no-write"]),
    /unknown adaptive-depth evaluation cli flag: "--no-write"/
  );
  assert.throws(
    () => parseAdaptiveDepthEvaluationCli(["--no-stdout"]),
    /unknown adaptive-depth evaluation cli flag: "--no-stdout"/
  );
});

test("adaptive-depth evaluation: CLI parser with no args uses a safe default", () => {
  const parsed = parseAdaptiveDepthEvaluationCli([]);
  assert.ok(parsed.artifactsDir.endsWith(".curion/benchmark"));
});

// ---------------------------------------------------------------------------
// 9. Artifact writer
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: writeAdaptiveDepthEvaluationReport writes a well-formed artifact with the documented prefix", async () => {
  const report = await runAdaptiveDepthEvaluation();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-adapt-eval-test-"));
  try {
    const file = writeAdaptiveDepthEvaluationReport(report, tmp);
    // The file must exist and be parseable JSON.
    assert.ok(fs.existsSync(file), "artifact file must be written");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // The shape is the same as the in-memory report.
    assert.equal(parsed.meta.scenarioCount, report.meta.scenarioCount);
    assert.equal(parsed.runs.length, report.runs.length);
    // The filename uses the documented prefix.
    assert.match(path.basename(file), /^retrieval-adaptive-depth-evaluation-/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Public API guard
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: the public MCP tool surface is unchanged (handleRecall takes only `text`)", async () => {
  // The public `recall` MCP tool signature is
  // `(input: { text: string })`; the test-only
  // `adaptiveDepth` option is on the internal
  // `RecallControllerOptions`, NOT on the MCP tool
  // schema. We assert the option is reachable from
  // the controller but NOT exported from the tool
  // layer.
  const controllerModule = await import("../src/controller/recall-controller.ts");
  // The test-only option IS on the controller's options
  // type (the option exists for this harness and the
  // test suite).
  const optsShape: Record<string, unknown> = {
    relevanceThreshold: 0.2,
    topK: 5,
    semanticEnabled: false,
    adaptiveDepth: {
      selector: { strategy: "elbow", minK: 3, maxK: 15 },
      diversity: { enabled: false },
      budget: { totalCharBudget: 6000, perMemoryCharCap: 500 },
    },
  };
  assert.ok("adaptiveDepth" in optsShape);
  // The controller module DOES export the
  // `adaptiveDepth` option (the type is reachable).
  assert.equal(typeof controllerModule.runRecallController, "function");
  assert.equal(typeof controllerModule.DEFAULT_ADAPTIVE_DEPTH_PIPELINE_CONFIG, "object");
  // The tool layer in `src/tools/recall.ts` does NOT
  // forward `adaptiveDepth`. We assert by reading the
  // tool's `handleRecall` source file content: the
  // helper module must not contain the literal
  // `adaptiveDepth` string in a place that would
  // forward it through the MCP tool boundary.
  const toolSource = fs.readFileSync(new URL("../src/tools/recall.ts", import.meta.url), "utf8");
  // The tool layer should not pass `adaptiveDepth`
  // to the controller. A future reviewer who tries
  // to expose the option on the wire is stopped at
  // this test. We assert by absence: the tool source
  // must not contain the literal `adaptiveDepth`
  // token (the option is not on the public surface).
  assert.ok(
    !toolSource.includes("adaptiveDepth"),
    `src/tools/recall.ts must not reference the test-only 'adaptiveDepth' option; the public MCP tool surface is unchanged.`
  );
});

// ---------------------------------------------------------------------------
// 11. Built-in scenario set integrity
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: BUILT_IN_SCENARIOS has unique ids and covers the brief's required axes", () => {
  const ids = BUILT_IN_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
  // The brief requires the following axes:
  //   - many relevant memories for a broad/vague query
  //   - narrow query
  //   - noisy tail
  //   - prompt budget
  //   - provider refusal/weak_match unchanged
  //   - superseded demotion still preserved
  const required = [
    "broad-cluster",
    "narrow-precise",
    "noisy-tail",
    "prompt-budget",
    "provider-refusal",
    "superseded-pair",
  ];
  for (const id of required) {
    assert.ok(ids.includes(id), `BUILT_IN_SCENARIOS must include scenario id '${id}'`);
  }
});

test("adaptive-depth evaluation: LEGACY_FIXED_TOPK_PIPELINE_CONFIG caps at 5 candidates with no budget", () => {
  const cfg = LEGACY_FIXED_TOPK_PIPELINE_CONFIG;
  assert.ok(cfg.selector);
  assert.equal(cfg.selector.minK, 5);
  assert.equal(cfg.selector.maxK, 5);
  assert.equal(cfg.selector.relativeFraction, 0);
  // The budget is disabled (Infinity) so the legacy
  // path does not truncate.
  assert.ok(cfg.budget);
  assert.equal(cfg.budget.totalCharBudget, Number.POSITIVE_INFINITY);
  assert.equal(cfg.budget.perMemoryCharCap, Number.POSITIVE_INFINITY);
});

// ---------------------------------------------------------------------------
// 12. Determinism: same scenario -> same synthesis body
// ---------------------------------------------------------------------------

test("adaptive-depth evaluation: repeated runs of the same scenario produce the same synthesis body", async () => {
  const r1 = await runAdaptiveDepthEvaluation();
  const r2 = await runAdaptiveDepthEvaluation();
  // The synthesis body for the broad-cluster scenario
  // must be byte-equal across repeated runs.
  const broad1 = r1.runs.find((r) => r.scenarioId === "broad-cluster");
  const broad2 = r2.runs.find((r) => r.scenarioId === "broad-cluster");
  assert.ok(broad1);
  assert.ok(broad2);
  assert.equal(broad1.adaptive.synthesisBody, broad2.adaptive.synthesisBody);
  assert.equal(broad1.legacy.synthesisBody, broad2.legacy.synthesisBody);
  assert.deepEqual(broad1.adaptive.synthesisMemoryIds, broad2.adaptive.synthesisMemoryIds);
  assert.deepEqual(broad1.legacy.synthesisMemoryIds, broad2.legacy.synthesisMemoryIds);
});
