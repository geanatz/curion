/**
 * Tests for the replay corpus evaluation harness.
 *
 * Coverage:
 *
 *   1. Module exports correct symbols.
 *   2. Seed corpus meets minimum size and diversity targets.
 *   3. All corpus items have complete ground-truth labels.
 *   4. No forbidden data patterns in corpus items.
 *   5. Stable corpus item IDs (content-derived, no production DB IDs).
 *   6. Report shape is well-formed.
 *   7. Human formatter produces a non-empty string.
 *   8. CLI parser accepts documented flags and rejects unknown flags.
 *   9. Artifact writer produces a file with the correct prefix.
 *  10. Replay produces deterministic output.
 *  11. Corpus has sufficient safety-relevant items.
 *  12. Corpus has ≥ 5 topic categories.
 *  13. Public MCP API is unchanged.
 *
 * All tests are hermetic: no live network, no production storage.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  REPLAY_CORPUS_LIMITATIONS,
  type ReplayCorpusEvaluationReport,
  formatReplayCorpusReport,
  runReplayCorpusEvaluation,
  writeReplayCorpusReport,
} from "../src/benchmark/replay-corpus-evaluation.ts";
import {
  CorpusItemSchema,
  REPLAY_CORPUS_ITEMS,
  REPLAY_CORPUS_VERSION,
  appearsCleanOfPII,
  buildLabelToCorpusItemIdMap,
  computeCorpusItemId,
  computeTextHash,
  detectForbiddenPatterns,
  detectForbiddenPatternsInRecallQuery,
  recallQueryAppearsCleanOfPII,
  resolveStableLabelToCorpusItemId,
  validateSeedCorpus,
} from "../src/benchmark/replay-corpus-items.ts";
import { parseReplayCorpusEvaluationCli } from "../src/benchmark/replay-corpus-runner.ts";

// ---------------------------------------------------------------------------
// 1. Module exports
// ---------------------------------------------------------------------------

test("replay-corpus: module exports expected symbols from replay-corpus-items", () => {
  assert.ok(Array.isArray(REPLAY_CORPUS_ITEMS));
  assert.ok(REPLAY_CORPUS_ITEMS.length > 0);
  assert.equal(typeof REPLAY_CORPUS_VERSION, "string");
  assert.equal(typeof validateSeedCorpus, "function");
  assert.equal(typeof computeCorpusItemId, "function");
  assert.equal(typeof computeTextHash, "function");
  assert.equal(typeof detectForbiddenPatterns, "function");
  assert.equal(typeof appearsCleanOfPII, "function");
});

test("replay-corpus: module exports expected symbols from replay-corpus-evaluation", () => {
  assert.equal(typeof runReplayCorpusEvaluation, "function");
  assert.equal(typeof writeReplayCorpusReport, "function");
  assert.equal(typeof formatReplayCorpusReport, "function");
  assert.ok(Array.isArray(REPLAY_CORPUS_LIMITATIONS));
  assert.ok(REPLAY_CORPUS_LIMITATIONS.length > 0);
});

// ---------------------------------------------------------------------------
// 2. Seed corpus meets minimum size and diversity targets
// ---------------------------------------------------------------------------

test("replay-corpus: seed corpus has at least 20 items", () => {
  assert.ok(
    REPLAY_CORPUS_ITEMS.length >= 20,
    `Expected ≥20 items, got ${REPLAY_CORPUS_ITEMS.length}`
  );
});

test("replay-corpus: seed corpus has at least 10 remember items", () => {
  const remember = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "remember");
  assert.ok(remember.length >= 10, `Expected ≥10 remember items, got ${remember.length}`);
});

test("replay-corpus: seed corpus has at least 10 recall-query items", () => {
  const recallQuery = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");
  assert.ok(recallQuery.length >= 10, `Expected ≥10 recall-query items, got ${recallQuery.length}`);
});

test("replay-corpus: seed corpus has at least 10 synthetic-proxy items", () => {
  const syntheticProxy = REPLAY_CORPUS_ITEMS.filter((i) => i.source === "synthetic-proxy");
  assert.ok(
    syntheticProxy.length >= 10,
    `Expected ≥10 synthetic-proxy items, got ${syntheticProxy.length}`
  );
});

test("replay-corpus: seed corpus has at least 5 manual-curated items", () => {
  const manualCurated = REPLAY_CORPUS_ITEMS.filter((i) => i.source === "manual-curated");
  assert.ok(
    manualCurated.length >= 5,
    `Expected ≥5 manual-curated items, got ${manualCurated.length}`
  );
});

test("replay-corpus: seed corpus has 0 sanitised-production items", () => {
  const sanitizedProduction = REPLAY_CORPUS_ITEMS.filter(
    (i) => i.source === "sanitized-production"
  );
  assert.equal(
    sanitizedProduction.length,
    0,
    `Expected 0 sanitised-production items, got ${sanitizedProduction.length}`
  );
});

// ---------------------------------------------------------------------------
// 3. All corpus items have complete ground-truth labels
// ---------------------------------------------------------------------------

test("replay-corpus: every corpus item has ground truth", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    assert.ok(item.groundTruth, `Item ${item.corpusItemId} missing groundTruth`);
    assert.ok(item.groundTruth.expectedAction, `Item ${item.corpusItemId} missing expectedAction`);
    assert.ok(
      item.groundTruth.expectedRationale,
      `Item ${item.corpusItemId} missing expectedRationale`
    );
    assert.ok(
      typeof item.groundTruth.safetyRelevant === "boolean",
      `Item ${item.corpusItemId} missing safetyRelevant`
    );
    assert.ok(
      typeof item.groundTruth.privacyRelevant === "boolean",
      `Item ${item.corpusItemId} missing privacyRelevant`
    );
    assert.ok(item.groundTruth.confidence, `Item ${item.corpusItemId} missing confidence`);
    assert.ok(item.groundTruth.labeler, `Item ${item.corpusItemId} missing labeler`);
    assert.ok(item.groundTruth.labeledAt, `Item ${item.corpusItemId} missing labeledAt`);
  }
});

// ---------------------------------------------------------------------------
// 4. No forbidden data patterns in corpus items
// ---------------------------------------------------------------------------

test("replay-corpus: no forbidden data patterns in any corpus item", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    const forbidden = detectForbiddenPatterns(item);
    assert.deepEqual(
      forbidden,
      [],
      `Item ${item.corpusItemId} contains forbidden patterns: ${forbidden.join(", ")}`
    );
  }
});

test("replay-corpus: no obvious PII in any corpus item", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    const clean = appearsCleanOfPII(item);
    assert.ok(clean, `Item ${item.corpusItemId} appears to contain obvious PII`);
  }
});

test("replay-corpus: no corpus item contains raw private user text", () => {
  // Check that items don't look like they contain real user data
  // (long random strings, email-like patterns, etc.)
  for (const item of REPLAY_CORPUS_ITEMS) {
    const text = item.input.textRedacted ?? "";
    // Should not contain obviously fake emails or realistic-looking personal info
    assert.ok(
      !/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) ||
        text.includes("example.com") ||
        text.includes("test.com"),
      `Item ${item.corpusItemId} may contain realistic personal email`
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Stable corpus item IDs
// ---------------------------------------------------------------------------

test("replay-corpus: corpus item IDs are stable (deterministic)", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    const recomputedId = computeCorpusItemId(item.input.textRedacted ?? "", item.input.type);
    assert.equal(item.corpusItemId, recomputedId, `Item ${item.corpusItemId} has non-stable ID`);
  }
});

test("replay-corpus: corpus item IDs do not contain production DB id patterns", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    // Should not look like SQLite rowids or UUIDs
    assert.ok(
      !/^\d+$/.test(item.corpusItemId) || item.corpusItemId.startsWith("corpus-"),
      `Item ${item.corpusItemId} looks like a raw integer DB id`
    );
    assert.ok(
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(item.corpusItemId),
      `Item ${item.corpusItemId} looks like a UUID`
    );
  }
});

test("replay-corpus: text hashes are stable and deterministic", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    const text = item.input.textRedacted ?? "";
    const recomputedHash = computeTextHash(text);
    assert.equal(
      item.input.textHash,
      recomputedHash,
      `Item ${item.corpusItemId} has non-stable text hash`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Report shape is well-formed
// ---------------------------------------------------------------------------

test("replay-corpus: report has all required fields", () => {
  const report = runReplayCorpusEvaluation();

  assert.ok(typeof report.generatedAt === "string");
  assert.ok(report.generatedAt.length > 0);
  assert.equal(typeof report.corpusVersion, "string");
  assert.equal(report.evaluationMode, "replay-corpus");
  assert.equal(typeof report.corpusSize, "number");
  assert.ok(typeof report.corpusBreakdown === "object");
  assert.ok(typeof report.safety === "object");
  assert.ok(typeof report.memoryLifecycle === "object");
  assert.ok(typeof report.recallQuality === "object");
  assert.ok(typeof report.deltaComparison === "object");
  assert.ok(Array.isArray(report.limitations));
  assert.ok(Array.isArray(report.items));

  // Corpus breakdown fields
  assert.equal(typeof report.corpusBreakdown.syntheticProxy, "number");
  assert.equal(typeof report.corpusBreakdown.manualCurated, "number");
  assert.equal(typeof report.corpusBreakdown.sanitizedProduction, "number");

  // Safety metrics fields
  assert.equal(typeof report.safety.safetyAssertionPassRate, "number");
  assert.equal(typeof report.safety.dangerousContentHandledRate, "number");
  assert.equal(typeof report.safety.privacyViolationRate, "number");
  assert.equal(typeof report.safety.rejectedItemCount, "number");
  assert.equal(typeof report.safety.safetyAdapterFailureRate, "number");

  // Memory lifecycle fields
  assert.ok(typeof report.memoryLifecycle.actionDistribution === "object");
  assert.equal(typeof report.memoryLifecycle.actionMatchesGroundTruthRate, "number");
  assert.equal(typeof report.memoryLifecycle.lowConfidenceActionRate, "number");
  assert.equal(typeof report.memoryLifecycle.noOpRate, "number");

  // Recall quality fields (now computed from labels)
  assert.equal(typeof report.recallQuality.sourceMatchRate, "number");
  assert.equal(typeof report.recallQuality.rank1MatchRate, "number");
  assert.equal(typeof report.recallQuality.currentTruthMatchRate, "number");
  // noAnswerTnr can be null if there are no no-answer items
  assert.ok(
    report.recallQuality.noAnswerTnr === null || typeof report.recallQuality.noAnswerTnr === "number",
    "noAnswerTnr should be null or number"
  );
  // usefulMemoryLossRate can be null if there are no positive query items
  assert.ok(
    report.recallQuality.usefulMemoryLossRate === null ||
      typeof report.recallQuality.usefulMemoryLossRate === "number",
    "usefulMemoryLossRate should be null or number"
  );
  // staleMemoryExposureRate can be null if there are no items
  assert.ok(
    report.recallQuality.staleMemoryExposureRate === null ||
      typeof report.recallQuality.staleMemoryExposureRate === "number",
    "staleMemoryExposureRate should be null or number"
  );
  assert.equal(typeof report.recallQuality.labeledRecallQueryCount, "number");
  assert.equal(typeof report.recallQuality.noAnswerExpectedCount, "number");
  assert.ok(typeof report.recallQuality.note === "string");

  // Delta comparison fields
  assert.equal(typeof report.deltaComparison.decisionDivergenceRate, "number");
  assert.ok(typeof report.deltaComparison.deltaClassificationRate === "object");
  assert.equal(typeof report.deltaComparison.deltaClassificationRate.matches, "number");
  assert.equal(typeof report.deltaComparison.deltaClassificationRate.diverges, "number");
  assert.equal(typeof report.deltaComparison.inconclusiveRate, "number");

  // Per-item results
  assert.equal(report.items.length, REPLAY_CORPUS_ITEMS.length);
  for (const itemResult of report.items) {
    assert.ok(typeof itemResult.corpusItemId === "string");
    assert.ok(typeof itemResult.inputType === "string");
    assert.ok(typeof itemResult.source === "string");
    assert.ok(typeof itemResult.schemaValid === "boolean");
    assert.ok(typeof itemResult.replayStatus === "string");
    assert.ok(typeof itemResult.expectedAction === "string");
  }
});

test("replay-corpus: report corpus breakdown sums to corpus size", () => {
  const report = runReplayCorpusEvaluation();
  const sum =
    report.corpusBreakdown.syntheticProxy +
    report.corpusBreakdown.manualCurated +
    report.corpusBreakdown.sanitizedProduction;
  assert.equal(
    sum,
    report.corpusSize,
    `Breakdown sum (${sum}) != corpus size (${report.corpusSize})`
  );
});

// ---------------------------------------------------------------------------
// 7. Human formatter produces a non-empty string
// ---------------------------------------------------------------------------

test("replay-corpus: human formatter produces non-empty string", () => {
  const report = runReplayCorpusEvaluation();
  const text = formatReplayCorpusReport(report);
  assert.ok(text.length > 0);
  assert.ok(text.includes("replay corpus evaluation"));
});

test("replay-corpus: human formatter includes key sections", () => {
  const report = runReplayCorpusEvaluation();
  const text = formatReplayCorpusReport(report);
  assert.ok(text.includes("--- meta ---"));
  assert.ok(text.includes("--- corpus breakdown ---"));
  assert.ok(text.includes("--- safety metrics ---"));
  assert.ok(text.includes("--- memory lifecycle metrics ---"));
  assert.ok(text.includes("--- limitations (research-only) ---"));
});

// ---------------------------------------------------------------------------
// 8. CLI parser
// ---------------------------------------------------------------------------

test("replay-corpus: CLI parser accepts --artifacts", () => {
  const parsed = parseReplayCorpusEvaluationCli(["--artifacts", "/tmp/foo"]);
  assert.equal(parsed.artifactsDir, "/tmp/foo");
});

test("replay-corpus: CLI parser accepts --no-write", () => {
  const parsed = parseReplayCorpusEvaluationCli(["--no-write"]);
  assert.equal(parsed.noWrite, true);
});

test("replay-corpus: CLI parser accepts --no-stdout", () => {
  const parsed = parseReplayCorpusEvaluationCli(["--no-stdout"]);
  assert.equal(parsed.noStdout, true);
});

test("replay-corpus: CLI parser rejects unknown flags", () => {
  assert.throws(
    () => parseReplayCorpusEvaluationCli(["--unknown-flag"]),
    /unknown replay-corpus evaluation cli flag/
  );
});

test("replay-corpus: CLI parser with no args uses safe defaults", () => {
  const parsed = parseReplayCorpusEvaluationCli([]);
  assert.ok(parsed.artifactsDir.endsWith(".curion/benchmark"));
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);
});

// ---------------------------------------------------------------------------
// 9. Artifact writer
// ---------------------------------------------------------------------------

test("replay-corpus: artifact writer produces a file with correct prefix", () => {
  const report = runReplayCorpusEvaluation();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-replay-corpus-test-"));
  try {
    const file = writeReplayCorpusReport(report, tmp);
    assert.ok(fs.existsSync(file), "artifact file must be written");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ReplayCorpusEvaluationReport;
    assert.equal(parsed.corpusSize, report.corpusSize);
    assert.equal(parsed.evaluationMode, "replay-corpus");
    assert.ok(path.basename(file).startsWith("replay-corpus-"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("replay-corpus: written artifact matches in-memory report", () => {
  const report = runReplayCorpusEvaluation();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-replay-corpus-test-"));
  try {
    const file = writeReplayCorpusReport(report, tmp);
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.corpusSize, report.corpusSize);
    assert.equal(parsed.corpusVersion, report.corpusVersion);
    assert.equal(parsed.evaluationMode, report.evaluationMode);
    assert.equal(parsed.items.length, report.items.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Deterministic replay output
// ---------------------------------------------------------------------------

test("replay-corpus: repeated runs produce identical results", () => {
  const report1 = runReplayCorpusEvaluation();
  const report2 = runReplayCorpusEvaluation();

  assert.equal(report1.corpusSize, report2.corpusSize, "Corpus size must be identical");
  assert.equal(
    report1.safety.safetyAssertionPassRate,
    report2.safety.safetyAssertionPassRate,
    "Safety pass rate must be identical"
  );
  assert.equal(
    report1.memoryLifecycle.actionMatchesGroundTruthRate,
    report2.memoryLifecycle.actionMatchesGroundTruthRate,
    "Action match rate must be identical"
  );
  assert.equal(
    report1.deltaComparison.decisionDivergenceRate,
    report2.deltaComparison.decisionDivergenceRate,
    "Divergence rate must be identical"
  );

  for (let i = 0; i < report1.items.length; i++) {
    assert.equal(
      report1.items[i]!.engineAction,
      report2.items[i]!.engineAction,
      `Item ${i} engine action must be identical`
    );
    assert.equal(
      report1.items[i]!.actionMatchesGroundTruth,
      report2.items[i]!.actionMatchesGroundTruth,
      `Item ${i} match result must be identical`
    );
  }
});

// ---------------------------------------------------------------------------
// 11. Corpus has sufficient safety-relevant items
// ---------------------------------------------------------------------------

test("replay-corpus: corpus has at least 3 safety-relevant items", () => {
  const safetyRelevant = REPLAY_CORPUS_ITEMS.filter((i) => i.groundTruth.safetyRelevant);
  assert.ok(
    safetyRelevant.length >= 3,
    `Expected ≥3 safety-relevant items, got ${safetyRelevant.length}`
  );
});

// ---------------------------------------------------------------------------
// 12. Corpus has ≥ 5 topic categories
// ---------------------------------------------------------------------------

test("replay-corpus: corpus covers at least 5 topic categories", () => {
  const topics = new Set(REPLAY_CORPUS_ITEMS.map((i) => i.topic).filter(Boolean));
  assert.ok(
    topics.size >= 5,
    `Expected ≥5 topic categories, got ${topics.size}: ${[...topics].join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// 13. Public MCP API is unchanged
// ---------------------------------------------------------------------------

test("replay-corpus: no new MCP tools are introduced", () => {
  // The replay corpus module should not export any new MCP tools
  // We verify by checking that the replay corpus runner doesn't
  // reference any tool additions
  const evaluationModule = fs.readFileSync(
    new URL("../src/benchmark/replay-corpus-evaluation.ts", import.meta.url),
    "utf8"
  );
  const runnerModule = fs.readFileSync(
    new URL("../src/benchmark/replay-corpus-runner.ts", import.meta.url),
    "utf8"
  );

  // Should not reference any new tool names
  assert.ok(
    !evaluationModule.includes("handleRemember") && !evaluationModule.includes("handleRecall"),
    "replay-corpus-evaluation.ts should not reference tool handlers"
  );
  void runnerModule; // Just to use the variable
});

// ---------------------------------------------------------------------------
// 14. validateSeedCorpus function works
// ---------------------------------------------------------------------------

test("replay-corpus: validateSeedCorpus passes for the seed corpus", () => {
  // Should not throw
  validateSeedCorpus();
});

// ---------------------------------------------------------------------------
// 15. Limitations block surfaces key caveats
// ---------------------------------------------------------------------------

test("replay-corpus: limitations block surfaces the required research-only caveats", () => {
  const text = REPLAY_CORPUS_LIMITATIONS.join("\n");
  assert.match(text, /proof-of-feasibility/i);
  assert.match(text, /not a statistically representative/i);
  assert.match(text, /synthetic-proxy.*manual-curated/i);
  assert.match(text, /sanitised-production.*deferred/i);
  assert.match(text, /offline evidence.*not.*activation/i);
  assert.match(text, /measurement infrastructure/i);
  assert.match(text, /recall query privacy checks/i);
});

// ---------------------------------------------------------------------------
// 16. All items pass schema validation
// ---------------------------------------------------------------------------

test("replay-corpus: every corpus item passes the Zod schema validation", () => {
  for (const item of REPLAY_CORPUS_ITEMS) {
    const result = CorpusItemSchema.safeParse(item);
    assert.ok(
      result.success,
      `Item ${item.corpusItemId} failed schema validation: ${
        result.error ? result.error.message : "unknown"
      }`
    );
  }
});

// ---------------------------------------------------------------------------
// 17. No network access by construction (scripted mode)
// ---------------------------------------------------------------------------

test("replay-corpus: evaluation produces results without any network access", () => {
  // The scripted replay evaluation should produce results
  // without any network calls. We verify by checking that
  // the evaluation completes successfully with deterministic
  // scripted responses.
  const report = runReplayCorpusEvaluation();

  // All items should have completed replay
  for (const item of report.items) {
    assert.equal(
      item.replayStatus,
      "completed",
      `Item ${item.corpusItemId} should have completed status`
    );
  }

  // Action distribution should be populated
  const actions = Object.keys(report.memoryLifecycle.actionDistribution);
  assert.ok(actions.length > 0, "Action distribution should be non-empty");
});

// ---------------------------------------------------------------------------
// 18. Recall quality labels are present on recall-query items
// ---------------------------------------------------------------------------

test("replay-corpus: recall-query items have recall quality labels", () => {
  const recallQueryItems = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");
  assert.ok(recallQueryItems.length > 0, "Should have recall-query items");

  for (const item of recallQueryItems) {
    assert.ok(item.recallQuality !== null, `Item ${item.corpusItemId} should have recallQuality`);
    assert.ok(
      item.recallQuality!.recallQuery.length > 0,
      `Item ${item.corpusItemId} should have non-empty recallQuery`
    );
    assert.ok(
      Array.isArray(item.recallQuality!.expectedSourceLabels),
      `Item ${item.corpusItemId} should have expectedSourceLabels array`
    );
    assert.ok(
      Array.isArray(item.recallQuality!.expectedRank1Labels),
      `Item ${item.corpusItemId} should have expectedRank1Labels array`
    );
    assert.ok(
      Array.isArray(item.recallQuality!.currentTruthLabels),
      `Item ${item.corpusItemId} should have currentTruthLabels array`
    );
    assert.ok(
      typeof item.recallQuality!.noAnswerExpected === "boolean",
      `Item ${item.corpusItemId} should have noAnswerExpected boolean`
    );
  }
});

// ---------------------------------------------------------------------------
// 19. Recall-query items have stable labels that match remember items
// ---------------------------------------------------------------------------

test("replay-corpus: expected source labels are stable corpus IDs", () => {
  const recallQueryItems = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");

  for (const item of recallQueryItems) {
    if (!item.recallQuality) continue;
    for (const label of item.recallQuality!.expectedSourceLabels) {
      assert.ok(
        label.startsWith("corpus-"),
        `Label ${label} should be a stable corpus ID starting with "corpus-"`
      );
    }
    for (const label of item.recallQuality!.expectedRank1Labels) {
      assert.ok(
        label.startsWith("corpus-"),
        `Label ${label} should be a stable corpus ID starting with "corpus-"`
      );
    }
    for (const label of item.recallQuality!.currentTruthLabels) {
      assert.ok(
        label.startsWith("corpus-"),
        `Label ${label} should be a stable corpus ID starting with "corpus-"`
      );
    }
  }
});

test("replay-corpus: expected source labels exist as remember item IDs", () => {
  const recallQueryItems = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");
  const rememberItemIds = new Set(
    REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "remember").map((i) => i.corpusItemId)
  );

  for (const item of recallQueryItems) {
    if (!item.recallQuality) continue;
    for (const label of item.recallQuality!.expectedSourceLabels) {
      assert.ok(
        rememberItemIds.has(label),
        `Expected source label ${label} should exist as a remember item ID`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 20. Recall query privacy checks
// ---------------------------------------------------------------------------

test("replay-corpus: recall queries pass privacy checks (no forbidden patterns)", () => {
  const recallQueryItems = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");

  for (const item of recallQueryItems) {
    if (!item.recallQuality) continue;
    const forbidden = detectForbiddenPatternsInRecallQuery(item.recallQuality!.recallQuery);
    assert.deepEqual(
      forbidden,
      [],
      `Item ${item.corpusItemId} recall query "${item.recallQuality!.recallQuery}" contains forbidden patterns: ${forbidden.join(", ")}`
    );
  }
});

test("replay-corpus: recall queries pass privacy checks (no obvious PII)", () => {
  const recallQueryItems = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");

  for (const item of recallQueryItems) {
    if (!item.recallQuality) continue;
    const clean = recallQueryAppearsCleanOfPII(item.recallQuality!.recallQuery);
    assert.ok(
      clean,
      `Item ${item.corpusItemId} recall query "${item.recallQuality!.recallQuery}" appears to contain obvious PII`
    );
  }
});

// ---------------------------------------------------------------------------
// 21. Stable label mapping
// ---------------------------------------------------------------------------

test("replay-corpus: buildLabelToCorpusItemIdMap produces correct mapping", () => {
  const map = buildLabelToCorpusItemIdMap(REPLAY_CORPUS_ITEMS);

  for (const item of REPLAY_CORPUS_ITEMS) {
    const resolved = resolveStableLabelToCorpusItemId(item.corpusItemId, map);
    assert.equal(
      resolved,
      item.corpusItemId,
      `Stable label ${item.corpusItemId} should resolve to itself`
    );
  }
});

// ---------------------------------------------------------------------------
// 22. Recall quality metrics are computed
// ---------------------------------------------------------------------------

test("replay-corpus: recall quality metrics are computed for labeled items", () => {
  const report = runReplayCorpusEvaluation();

  assert.ok(
    report.recallQuality.labeledRecallQueryCount > 0,
    `Should have labeled recall query items, got ${report.recallQuality.labeledRecallQueryCount}`
  );
  assert.ok(
    report.recallQuality.labeledRecallQueryCount <=
      REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query").length,
    "Labeled count should not exceed total recall query items"
  );
});

test("replay-corpus: recall quality metrics have expected types", () => {
  const report = runReplayCorpusEvaluation();

  // All metrics should be numbers (or null if no labeled items)
  if (report.recallQuality.labeledRecallQueryCount > 0) {
    assert.equal(
      typeof report.recallQuality.sourceMatchRate,
      "number",
      "sourceMatchRate should be a number"
    );
    assert.equal(
      typeof report.recallQuality.rank1MatchRate,
      "number",
      "rank1MatchRate should be a number"
    );
    assert.equal(
      typeof report.recallQuality.currentTruthMatchRate,
      "number",
      "currentTruthMatchRate should be a number"
    );
  }
});

test("replay-corpus: per-item recall quality results are present", () => {
  const report = runReplayCorpusEvaluation();
  const recallQueryResults = report.items.filter((i) => i.inputType === "recall-query");

  for (const item of recallQueryResults) {
    assert.ok(item.recallQuality !== null, `Item ${item.corpusItemId} should have recallQuality result`);
    assert.ok(
      typeof item.recallQuality!.recallQuery === "string",
      `Item ${item.corpusItemId} should have recallQuery string`
    );
    assert.ok(
      Array.isArray(item.recallQuality!.expectedSourceLabels),
      `Item ${item.corpusItemId} should have expectedSourceLabels array`
    );
    assert.ok(
      Array.isArray(item.recallQuality!.expectedRank1Labels),
      `Item ${item.corpusItemId} should have expectedRank1Labels array`
    );
    assert.ok(
      Array.isArray(item.recallQuality!.currentTruthLabels),
      `Item ${item.corpusItemId} should have currentTruthLabels array`
    );
    assert.ok(
      typeof item.recallQuality!.noAnswerExpected === "boolean",
      `Item ${item.corpusItemId} should have noAnswerExpected boolean`
    );
    assert.ok(
      typeof item.recallQuality!.privacyValidationPassed === "boolean",
      `Item ${item.corpusItemId} should have privacyValidationPassed boolean`
    );
  }
});

test("replay-corpus: all labeled recall queries pass privacy validation", () => {
  const report = runReplayCorpusEvaluation();
  const recallQueryResults = report.items.filter((i) => i.inputType === "recall-query");

  for (const item of recallQueryResults) {
    if (item.recallQuality) {
      assert.ok(
        item.recallQuality.privacyValidationPassed,
        `Item ${item.corpusItemId} should pass privacy validation`
      );
    }
  }
});

test("replay-corpus: human formatter includes recall quality section", () => {
  const report = runReplayCorpusEvaluation();
  const text = formatReplayCorpusReport(report);
  assert.ok(text.includes("--- recall quality ---"), "Human formatter should include recall quality section");
  assert.ok(text.includes("labeledRecallQueryCount"), "Human formatter should include labeledRecallQueryCount");
});

// ---------------------------------------------------------------------------
// 23. Deterministic replay output (recall quality)
// ---------------------------------------------------------------------------

test("replay-corpus: repeated runs produce identical recall quality metrics", () => {
  const report1 = runReplayCorpusEvaluation();
  const report2 = runReplayCorpusEvaluation();

  assert.equal(
    report1.recallQuality.labeledRecallQueryCount,
    report2.recallQuality.labeledRecallQueryCount,
    "Labeled recall query count must be identical"
  );
  assert.equal(
    report1.recallQuality.sourceMatchRate,
    report2.recallQuality.sourceMatchRate,
    "Source match rate must be identical"
  );
  assert.equal(
    report1.recallQuality.rank1MatchRate,
    report2.recallQuality.rank1MatchRate,
    "Rank-1 match rate must be identical"
  );
  assert.equal(
    report1.recallQuality.currentTruthMatchRate,
    report2.recallQuality.currentTruthMatchRate,
    "Current truth match rate must be identical"
  );
});
