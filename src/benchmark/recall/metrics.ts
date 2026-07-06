/**
 * Metrics, report shape, and human formatter for the
 * recall-policy evaluation harness (v1).
 *
 * The shape is intentionally distinct from the existing
 * decision-policy evaluation (`decision-policy-evaluation.ts`)
 * and the adaptive-depth evaluation
 * (`adaptive-depth-evaluation.ts`). The recall-policy evaluation
 * is a SEPARATE study: it evaluates a benchmark-only
 * adapter (no production adapter exists yet), under a
 * different scenario structure (recall-policy evidence
 * packets, not remember-policy evidence packets), and
 * produces a different summary (status histogram,
 * target-id Jaccard match, provider-call stats).
 *
 * What the v1 report carries:
 *
 *   - `meta`: counts + the scripted-config block + the
 *     scenario-set version stamp.
 *
 *   - `categories`: per-category summary table (count,
 *     passed, failed, abstention-critical sub-count).
 *
 *   - `scopes`: per-scope summary table (`model-quality`
 *     vs `provider-path`); drives the gate attribution.
 *
 *   - `statusHistogram` + `reasonHistogram`: full
 *     vocabulary coverage tables with a count of zero when
 *     the slot was not observed.
 *
 *   - `perStatusAccuracy` + `perReasonAccuracy`: per-
 *     vocabulary-slot accuracy over scenarios that set the
 *     slot expectation.
 *
 *   - `statusConfusionMatrix`: rows = expected status,
 *     cols = actual status (including `<failed:kind>` for
 *     non-status failure results).
 *
 *   - `targetMemoryMatch`: aggregate Jaccard (= IoU over
 *     sets) over the scenarios that set
 *     `expectedSourceIds`.
 *
 *   - `providerCallStats`: total calls, primary /
 *     repair / fallback attempt counts, and an
 *     adapter-failed count.
 *
 *   - `abstentionGate`: per the brief, a strict pass
 *     requirement on every abstention-critical scenario.
 *
 *   - `safetyGate`: pass-only-safety-critical gate
 *     (currently always passes — the v1 set does not
 *     exercise a `safety` category; reserved for v2).
 *
 *   - `modelQualityGate`: strict pass requirement on every
 *     `evaluationScope === "model-quality"` scenario.
 *
 *   - `providerPathGate`: strict pass requirement on every
 *     `evaluationScope === "provider-path"` scenario.
 *
 *   - `gates`: structured overall-pass verdict.
 *     `overallPassed` is the conjunction of every gate
 *     passed; a reviewer who wants the headline verdict
 *     reads `gates.overallPassed`.
 *
 *   - `runs`: one entry per scenario with the captured
 *     adapter decision + per-scenario assertions + the
 *     per-scenario Jaccard where applicable.
 *
 *   - `limitations`: the research-only disclosure block.
 *
 * The metrics module is pure: same report → same metrics.
 * No I/O.
 */

import {
  RECALL_POLICY_EVALUATION_SCOPES,
  RECALL_POLICY_REASONS,
  RECALL_POLICY_SCENARIO_CATEGORIES,
  RECALL_POLICY_SCENARIO_SET_VERSION,
  RECALL_POLICY_STATUSES,
  type RecallPolicyEvaluationScope,
  type RecallPolicyReason,
  type RecallPolicyScenarioCategory,
  type RecallPolicyStatus,
} from "./scenarios.js";

// ---------------------------------------------------------------------------
// Per-run captured data
// ---------------------------------------------------------------------------

/**
 * Captured id-array snapshot for the per-scenario Jaccard
 * computation. The harness records the four lists the
 * adapter's success result carries; the metrics module
 * diff-compares them against the scenario's `expected*Ids`
 * block.
 */
export interface RecallPolicyCapturedTargetIds {
  sourceIds: ReadonlyArray<number>;
  conflictIds: ReadonlyArray<number>;
  supersededIds: ReadonlyArray<number>;
  olderVariantIds: ReadonlyArray<number>;
}

/**
 * The data the harness captures for a single scenario. The
 * report surfaces this verbatim so a reviewer can audit what
 * the adapter actually saw and what it actually returned.
 *
 * The `pass` boolean is the conjunction of BOTH groups'
 * per-run assertion passes. The `decisionQualityPass` and
 * `providerPathPass` booleans record each group separately
 * so a reviewer can tell which assertion group fired.
 */
export interface RecallPolicyScenarioRunResult {
  /** Which scenario produced this run. */
  scenarioId: string;
  /** Human-readable label. */
  label: string;
  /** Short description of the scenario. */
  description: string;
  /** The user query the scenario fed into the evidence packet. */
  query: string;
  /** Number of related memories in the evidence packet. */
  relatedCount: number;

  /**
   * Total HTTP calls the adapter actually made. Mirrors the
   * scripted-fetch state machine:
   *   - 1 = primary first (success or hard failure)
   *   - 2 = primary first + repair (success or both-fail)
   *   - 3 = primary first + repair + fallback first
   *   - 4 = primary first + repair + fallback first + fallback repair
   */
  httpCalls: number;
  /** True iff the scenario made at least one same-provider repair call. */
  repairAttempted: boolean;
  /** True iff the scenario invoked the fallback path at least once. */
  fallbackAttempted: boolean;

  /** Whether the scenario returned a successful adapter decision (`true`) or a typed failure (`false`). */
  adapterOk: boolean;
  /**
   * The kind of failure (only set when `adapterOk === false`).
   * Mirrors the recall-policy failure union.
   */
  failureKind?: "missing-config" | "invalid-input" | "invalid-output" | "all-providers-failed";
  /** The successful decision's `status` (only set when `adapterOk === true`). */
  status?: RecallPolicyStatus;
  /** The successful decision's `reason` (only set when `adapterOk === true`). */
  reason?: RecallPolicyReason;
  /** The successful decision's `confidence` (only set when `adapterOk === true`). */
  confidence?: number;
  /** The successful decision's id arrays (only set when `adapterOk === true`). */
  sourceIds?: ReadonlyArray<number>;
  conflictIds?: ReadonlyArray<number>;
  supersededIds?: ReadonlyArray<number>;
  olderVariantIds?: ReadonlyArray<number>;
  /** Trace-only annotation. */
  notes?: string;

  /** The per-scenario category. */
  category: RecallPolicyScenarioCategory;
  /** Whether this scenario participates in the abstention gate. */
  abstentionCritical: boolean;
  /**
   * Whether this scenario participates in the safety gate.
   * The v1 set has no safety category so the field is always
   * `false` in v1; reserved for v2.
   */
  safetyCritical: boolean;
  /** The scenario's evaluation scope. Drives which gate the scenario contributes to. */
  evaluationScope: RecallPolicyEvaluationScope;

  /**
   * Captured id-array snapshot for the per-scenario Jaccard
   * computation. Set to the captured arrays on
   * `adapterOk === true`; set to four empty arrays on
   * `adapterOk === false`.
   */
  capturedTargetIds: RecallPolicyCapturedTargetIds;
  /** Per-scenario Jaccard (= IoU over id sets). `null` if no `expected*Ids` was set. */
  targetMemoryJaccard: number | null;

  /** Expected status the scenario set (used by the perStatusAccuracy builder). */
  expectedStatus?: RecallPolicyStatus;
  /** Expected reason the scenario set. */
  expectedReason?: RecallPolicyReason;
  /**
   * Row label for the status confusion matrix. Mirrors the
   * `expect.expectedStatus` for status expectations and is
   * `<failed:kind>` for failure expectations; `<none>` when
   * neither was set.
   */
  expectedConfusionRowLabel: string;

  /** Per-expectation assertion rows the harness checked. */
  assertions: ReadonlyArray<RecallPolicyAssertionRow>;
  /** True iff every assertion (across both groups) passed. */
  pass: boolean;
  /** True iff every `group === "decision-quality"` assertion passed. */
  decisionQualityPass: boolean;
  /** True iff every `group === "provider-path"` assertion passed. */
  providerPathPass: boolean;
}

/**
 * A single expectation the harness checked. One row per
 * expectation field that was set on the scenario.
 */
export interface RecallPolicyAssertionRow {
  /** Short name of the expectation. */
  name: string;
  /** What the expectation checked. */
  description: string;
  /** Did the expectation hold? */
  pass: boolean;
  /** Free-form note ("got X, expected Y"). */
  note: string;
  /**
   * Which gate the assertion contributes to:
   *   - `"decision-quality"` — reflects the model's structured
   *     decision shape (status, reason, target ids, confidence).
   *     Counted against `modelQualityGate` and `abstentionGate`.
   *   - `"provider-path"` — reflects the adapter's provider
   *     state-machine exercise (httpCalls). Counted against
   *     `providerPathGate`.
   */
  group: "decision-quality" | "provider-path";
}

// ---------------------------------------------------------------------------
// v1 metrics blocks
// ---------------------------------------------------------------------------

/**
 * Per-category summary row. The report carries one row per
 * category in `RECALL_POLICY_SCENARIO_CATEGORIES`.
 */
export interface RecallPolicyCategorySummary {
  category: RecallPolicyScenarioCategory;
  totalScenarios: number;
  passed: number;
  failed: number;
  abstentionCriticalTotal: number;
  abstentionCriticalPassed: number;
  abstentionCriticalFailed: number;
}

/**
 * Per-status accuracy row: how often the adapter's emitted
 * status matched the expected status for scenarios that set
 * an `expectedStatus`.
 */
export interface RecallPolicyStatusAccuracyRow {
  status: RecallPolicyStatus;
  expectedCount: number;
  matchedCount: number;
  /** `matchedCount / expectedCount`. `null` when `expectedCount === 0`. */
  accuracy: number | null;
}

/**
 * Per-reason accuracy row. Mirrors the per-status shape but
 * for `expectedReason`.
 */
export interface RecallPolicyReasonAccuracyRow {
  reason: RecallPolicyReason;
  expectedCount: number;
  matchedCount: number;
  accuracy: number | null;
}

/**
 * Status confusion-matrix shape. Rows are the EXPECTED
 * status (`"<none>"` for scenarios with no
 * `expectedStatus`, `"<failed:kind>"` for scenarios that
 * expected a failure outcome); cols are the ACTUAL status
 * (`"<failed:kind>"` for adapter failures, otherwise the
 * emitted status).
 *
 * The matrix is indexed by `[expectedRowIndex][actualColIndex]`.
 */
export interface RecallPolicyStatusConfusionMatrix {
  rows: ReadonlyArray<string>;
  cols: ReadonlyArray<string>;
  matrix: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Aggregate target-memory Jaccard block. Jaccard over id
 * sets is mathematically equal to IoU over id sets, so we
 * emit a single number under two names for the reviewer's
 * convenience.
 */
export interface RecallPolicyTargetMemoryMatch {
  /** Number of scenarios that set an `expectedSourceIds` block. */
  scenariosWithExpectedIds: number;
  /** Number of those scenarios that produced a perfect Jaccard. */
  perfectMatches: number;
  /** Micro mean Jaccard across `sourceIds` arrays. */
  aggregateJaccard: number;
  /** Alias of `aggregateJaccard`. */
  aggregateIoU: number;
  /** Per-category mean Jaccard. */
  perCategory: ReadonlyArray<{
    category: RecallPolicyScenarioCategory;
    scenariosWithExpectedIds: number;
    meanJaccard: number | null;
  }>;
  /** Per-scenario Jaccard list (for the human report). */
  perScenario: ReadonlyArray<{
    scenarioId: string;
    jaccard: number;
    sourceIdsCount: number;
    expectedSourceIdsCount: number;
  }>;
}

/**
 * Provider-call stats. Aggregate counts the brief asks for.
 */
export interface RecallPolicyProviderCallStats {
  /** Total HTTP calls across all scenarios (sum of per-run `httpCalls`). */
  totalCalls: number;
  /** Total scenarios (== `meta.scenarioCount`). */
  totalScenarios: number;
  /** Scenarios where the same-provider repair path was invoked at least once. */
  repairAttemptedCount: number;
  /** Scenarios where the fallback path was invoked at least once. */
  fallbackAttemptedCount: number;
  /** Scenarios whose adapter result was `ok: false`. */
  adapterFailedCount: number;
}

/**
 * Abstention gate block. The gate passes iff every
 * abstention-critical scenario's `pass === true`. The
 * `failedScenarioIds` array lets a reviewer click through to
 * the failing rows. The gate is the headline signal the
 * brief asks for: a recall-policy decision engine must
 * correctly abstain on no-memory / weak-match conditions.
 */
export interface RecallPolicyAbstentionGate {
  abstentionCriticalCount: number;
  abstentionCriticalPassed: number;
  abstentionCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Safety gate block. The gate passes iff every
 * safety-critical scenario's `pass === true`. The v1 set
 * has no `safety` category so the gate is informational
 * (vacuously passes when 0 safety-critical scenarios are
 * present).
 */
export interface RecallPolicySafetyGate {
  safetyCriticalCount: number;
  safetyCriticalPassed: number;
  safetyCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Model-quality gate block. The gate passes iff every
 * `evaluationScope === "model-quality"` scenario's
 * decision-quality assertions all pass.
 */
export interface RecallPolicyModelQualityGate {
  modelQualityCount: number;
  modelQualityPassed: number;
  modelQualityFailed: number;
  failedScenarioIds: ReadonlyArray<string>;
  passed: boolean;
}

/**
 * Provider-path gate block. The gate passes iff every
 * `evaluationScope === "provider-path"` scenario's
 * `pass === true`. These scenarios exercise the harness's
 * primary → repair → fallback → fallback-repair state
 * machine under scripted hard-failure / parse-failure
 * inputs.
 */
export interface RecallPolicyProviderPathGate {
  providerPathCount: number;
  providerPathPassed: number;
  providerPathFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Overall-gates block. Surfaces the headline pass / fail
 * verdicts the brief asks for, plus the failed-scenario
 * ids.
 *
 * `overallPassed` is the conjunction of every gate
 * passed: abstention + safety + model-quality + provider-path.
 */
export interface RecallPolicyGates {
  /** True iff every abstention-critical scenario passed. */
  abstentionPassed: boolean;
  /** True iff every safety-critical scenario passed. */
  safetyPassed: boolean;
  /** True iff every model-quality scenario passed. */
  modelQualityPassed: boolean;
  /** True iff every provider-path scenario passed. */
  providerPathPassed: boolean;
  /** True iff every scenario passed (across both scopes). */
  allScenariosPassed: boolean;
  /** True iff every gate passed. */
  overallPassed: boolean;
  /** Scenario ids that failed the abstention gate. */
  abstentionFailedScenarioIds: ReadonlyArray<string>;
  /** Scenario ids that failed the safety gate. */
  safetyFailedScenarioIds: ReadonlyArray<string>;
  /** Scenario ids that failed the model-quality gate. */
  modelQualityFailedScenarioIds: ReadonlyArray<string>;
  /** Scenario ids that failed the provider-path gate. */
  providerPathFailedScenarioIds: ReadonlyArray<string>;
  /** Scenario ids that failed any assertion. */
  allFailedScenarioIds: ReadonlyArray<string>;
  /** Human-readable summary of all gate outcomes. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level evaluation report (v1). The JSON artifact is
 * one of these. Same convention as the decision-policy
 * evaluation: the artifact is machine-readable; the human
 * formatter in `formatRecallPolicyEvaluationReport` produces
 * the human text.
 */
export interface RecallPolicyEvaluationReport {
  /** ISO timestamp the report was generated at. */
  generatedAt: string;
  /**
   * Scenario-set version stamp ("v1"). The harness surfaces
   * this verbatim on every artifact so a reviewer can read
   * "this artifact was produced under v1" without re-deriving
   * the count.
   */
  scenarioSetVersion: string;
  /** Metadata block. */
  meta: {
    /** Number of scenarios run. */
    scenarioCount: number;
    /** Number of scenarios that passed all assertions. */
    passedCount: number;
    /** Number of scenarios that failed at least one assertion. */
    failedCount: number;
    /** Number of scenarios whose adapter call returned `ok: true`. */
    adapterOkCount: number;
    /** Number of scenarios whose adapter call returned `ok: false`. */
    adapterFailedCount: number;
    /** Total HTTP calls across all scenarios. */
    totalHttpCalls: number;
    /** Number of scenarios with at least one expected-source-id expectation. */
    scenariosWithTargetMemoryMatchExpectation: number;
    /** Number of scenarios whose target-memory match expectation passed. */
    targetMemoryMatchPassCount: number;
    /** Number of abstention-critical scenarios. */
    abstentionCriticalCount: number;
    /** Number of abstention-critical scenarios that passed. */
    abstentionCriticalPassedCount: number;
    /** Number of `evaluationScope === "model-quality"` scenarios. */
    modelQualityCount: number;
    /** Number of `evaluationScope === "model-quality"` scenarios that passed. */
    modelQualityPassedCount: number;
    /** Number of `evaluationScope === "provider-path"` scenarios. */
    providerPathCount: number;
    /** Number of `evaluationScope === "provider-path"` scenarios that passed. */
    providerPathPassedCount: number;
  };
  /** Per-category summary, one row per `RECALL_POLICY_SCENARIO_CATEGORIES` slot. */
  categories: ReadonlyArray<RecallPolicyCategorySummary>;
  /** Per-scope summary, one row per `RECALL_POLICY_EVALUATION_SCOPES` slot. */
  scopes: ReadonlyArray<{
    scope: RecallPolicyEvaluationScope;
    totalScenarios: number;
    passed: number;
    failed: number;
    abstentionCriticalTotal: number;
    abstentionCriticalPassed: number;
    abstentionCriticalFailed: number;
  }>;
  /** Status histogram (one entry per status vocabulary slot). */
  statusHistogram: ReadonlyArray<{ status: RecallPolicyStatus; count: number }>;
  /** Reason histogram (one entry per reason vocabulary slot). */
  reasonHistogram: ReadonlyArray<{ reason: RecallPolicyReason; count: number }>;
  /** Per-status accuracy. */
  perStatusAccuracy: ReadonlyArray<RecallPolicyStatusAccuracyRow>;
  /** Per-reason accuracy. */
  perReasonAccuracy: ReadonlyArray<RecallPolicyReasonAccuracyRow>;
  /** Status confusion matrix (rows = expected, cols = actual). */
  statusConfusionMatrix: RecallPolicyStatusConfusionMatrix;
  /** Aggregate Jaccard over scenarios with `expectedSourceIds`. */
  targetMemoryMatch: RecallPolicyTargetMemoryMatch;
  /** Provider-call stats. */
  providerCallStats: RecallPolicyProviderCallStats;
  /** Abstention gate block. */
  abstentionGate: RecallPolicyAbstentionGate;
  /** Safety gate block. */
  safetyGate: RecallPolicySafetyGate;
  /** Model-quality gate block. */
  modelQualityGate: RecallPolicyModelQualityGate;
  /** Provider-path gate block. */
  providerPathGate: RecallPolicyProviderPathGate;
  /** Overall-gates block. */
  gates: RecallPolicyGates;
  /** Per-scenario captured data, in scenario declaration order. */
  runs: ReadonlyArray<RecallPolicyScenarioRunResult>;
  /** Limitations block (research-only disclosure). */
  limitations: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the Jaccard index (= IoU) between two id arrays.
 * Returns 0 when both inputs are empty (an under-defined
 * scenario; the harness treats this as "no expectation set"
 * and only counts the Jaccard when at least one side is
 * non-empty).
 */
export function jaccardBetween(
  expected: ReadonlyArray<number>,
  captured: ReadonlyArray<number>
): number {
  const expectedSet = new Set(expected);
  const capturedSet = new Set(captured);
  if (expectedSet.size === 0 && capturedSet.size === 0) {
    return 1;
  }
  if (expectedSet.size === 0 || capturedSet.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const e of expectedSet) {
    if (capturedSet.has(e)) intersection += 1;
  }
  const union = expectedSet.size + capturedSet.size - intersection;
  if (union === 0) return 1;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Metrics builder
// ---------------------------------------------------------------------------

/**
 * Build the v1 metrics block from a list of per-scenario run
 * results. Pure: same input → same output. The histograms
 * always include every status / reason vocabulary slot, with
 * a count of zero when the slot was not observed. The
 * confusion matrix always includes every status row + the
 * `<none>` / `<failed:kind>` extras.
 */
export function buildRecallPolicyEvaluationMetrics(
  runs: ReadonlyArray<RecallPolicyScenarioRunResult>
): Omit<RecallPolicyEvaluationReport, "generatedAt" | "limitations"> {
  let passedCount = 0;
  let failedCount = 0;
  let adapterOkCount = 0;
  let adapterFailedCount = 0;
  let totalHttpCalls = 0;
  let scenariosWithTargetMemoryMatchExpectation = 0;
  let targetMemoryMatchPassCount = 0;
  let abstentionCriticalCount = 0;
  let abstentionCriticalPassedCount = 0;
  let modelQualityCount = 0;
  let modelQualityPassedCount = 0;
  let providerPathCount = 0;
  let providerPathPassedCount = 0;
  let safetyCriticalCount = 0;
  let safetyCriticalPassedCount = 0;
  let repairAttemptedCount = 0;
  let fallbackAttemptedCount = 0;

  const statusCounts = new Map<RecallPolicyStatus, number>();
  const reasonCounts = new Map<RecallPolicyReason, number>();
  for (const status of RECALL_POLICY_STATUSES) statusCounts.set(status, 0);
  for (const reason of RECALL_POLICY_REASONS) reasonCounts.set(reason, 0);

  const statusExpected = new Map<RecallPolicyStatus, number>();
  const statusMatched = new Map<RecallPolicyStatus, number>();
  for (const status of RECALL_POLICY_STATUSES) {
    statusExpected.set(status, 0);
    statusMatched.set(status, 0);
  }
  const reasonExpected = new Map<RecallPolicyReason, number>();
  const reasonMatched = new Map<RecallPolicyReason, number>();
  for (const reason of RECALL_POLICY_REASONS) {
    reasonExpected.set(reason, 0);
    reasonMatched.set(reason, 0);
  }

  // Confusion matrix axes.
  const colLabels = new Set<string>();
  const rowLabels = new Set<string>();
  for (const s of RECALL_POLICY_STATUSES) colLabels.add(s);

  const confusionCells = new Map<string, number>();

  // Per-category Jaccard aggregation.
  const perCategoryJaccardSums = new Map<
    RecallPolicyScenarioCategory,
    { sum: number; count: number }
  >();

  const perScenarioJaccard: Array<{
    scenarioId: string;
    jaccard: number;
    sourceIdsCount: number;
    expectedSourceIdsCount: number;
  }> = [];
  let perfectMatches = 0;

  for (const run of runs) {
    if (run.pass) passedCount += 1;
    else failedCount += 1;
    if (run.adapterOk) {
      adapterOkCount += 1;
      if (run.status) statusCounts.set(run.status, (statusCounts.get(run.status) ?? 0) + 1);
      if (run.reason) reasonCounts.set(run.reason, (reasonCounts.get(run.reason) ?? 0) + 1);
    } else {
      adapterFailedCount += 1;
    }
    totalHttpCalls += run.httpCalls;
    if (run.repairAttempted) repairAttemptedCount += 1;
    if (run.fallbackAttempted) fallbackAttemptedCount += 1;

    if (run.abstentionCritical) {
      abstentionCriticalCount += 1;
      if (run.pass) abstentionCriticalPassedCount += 1;
    }
    if (run.safetyCritical) {
      safetyCriticalCount += 1;
      if (run.pass) safetyCriticalPassedCount += 1;
    }

    if (run.evaluationScope === "provider-path") {
      providerPathCount += 1;
      if (run.pass) providerPathPassedCount += 1;
    } else {
      modelQualityCount += 1;
      if (run.decisionQualityPass) modelQualityPassedCount += 1;
    }

    // Per-status accuracy + per-reason accuracy.
    const statusAssertion = run.assertions.find((a) => a.name === "status");
    if (statusAssertion && run.expectedStatus !== undefined) {
      const expectedStatus = run.expectedStatus;
      statusExpected.set(expectedStatus, (statusExpected.get(expectedStatus) ?? 0) + 1);
      if (statusAssertion.pass && run.status === expectedStatus) {
        statusMatched.set(expectedStatus, (statusMatched.get(expectedStatus) ?? 0) + 1);
      }
    }
    const reasonAssertion = run.assertions.find((a) => a.name === "reason");
    if (reasonAssertion && run.expectedReason !== undefined) {
      const expectedReason = run.expectedReason;
      reasonExpected.set(expectedReason, (reasonExpected.get(expectedReason) ?? 0) + 1);
      if (reasonAssertion.pass && run.reason === expectedReason) {
        reasonMatched.set(expectedReason, (reasonMatched.get(expectedReason) ?? 0) + 1);
      }
    }

    // Confusion matrix.
    const expectedRowLabel = run.expectedConfusionRowLabel;
    const actualColLabel = run.adapterOk
      ? (run.status ?? "<none>")
      : `<failed:${run.failureKind ?? "unknown"}>`;
    rowLabels.add(expectedRowLabel);
    colLabels.add(actualColLabel);
    const cellKey = `${expectedRowLabel}\u0000${actualColLabel}`;
    confusionCells.set(cellKey, (confusionCells.get(cellKey) ?? 0) + 1);

    // Target-memory match (presence / absence + Jaccard).
    const targetMemoryAssertions = run.assertions.filter(
      (a) =>
        a.name.startsWith("sourceIdInAnswer") ||
        a.name.startsWith("sourceIdNotInAnswer") ||
        a.name.startsWith("expectedConflictIds") ||
        a.name.startsWith("expectedSupersededIds") ||
        a.name.startsWith("expectedOlderVariantIds")
    );
    if (targetMemoryAssertions.length > 0) {
      scenariosWithTargetMemoryMatchExpectation += 1;
      const allPass = targetMemoryAssertions.every((a) => a.pass);
      if (allPass) targetMemoryMatchPassCount += 1;
    }

    if (run.targetMemoryJaccard !== null) {
      perScenarioJaccard.push({
        scenarioId: run.scenarioId,
        jaccard: run.targetMemoryJaccard,
        sourceIdsCount: run.capturedTargetIds.sourceIds.length,
        expectedSourceIdsCount: run.expectedStatus !== undefined ? 0 : 0,
      });
      if (run.targetMemoryJaccard === 1) perfectMatches += 1;
      const cat = run.category;
      const cur = perCategoryJaccardSums.get(cat) ?? { sum: 0, count: 0 };
      cur.sum += run.targetMemoryJaccard;
      cur.count += 1;
      perCategoryJaccardSums.set(cat, cur);
    }
  }

  const aggregateJaccard =
    perScenarioJaccard.length > 0
      ? perScenarioJaccard.reduce((s, r) => s + r.jaccard, 0) / perScenarioJaccard.length
      : 0;

  // Confusion matrix dense build.
  const sortedCols = Array.from(colLabels).sort();
  const sortedRows = Array.from(rowLabels).sort();
  const orderedCols: string[] = [];
  for (const s of RECALL_POLICY_STATUSES) {
    if (sortedCols.includes(s)) orderedCols.push(s);
  }
  for (const c of sortedCols) {
    if (!orderedCols.includes(c)) orderedCols.push(c);
  }
  const matrix: number[][] = [];
  for (const r of sortedRows) {
    const row: number[] = [];
    for (const c of orderedCols) {
      row.push(confusionCells.get(`${r}\u0000${c}`) ?? 0);
    }
    matrix.push(row);
  }

  // Per-category summary.
  const categories: RecallPolicyCategorySummary[] = [];
  for (const cat of RECALL_POLICY_SCENARIO_CATEGORIES) {
    const catRuns = runs.filter((r) => r.category === cat);
    const total = catRuns.length;
    const passed = catRuns.filter((r) => r.pass).length;
    const failed = total - passed;
    const abstention = catRuns.filter((r) => r.abstentionCritical);
    const abstentionPass = abstention.filter((r) => r.pass).length;
    categories.push({
      category: cat,
      totalScenarios: total,
      passed,
      failed,
      abstentionCriticalTotal: abstention.length,
      abstentionCriticalPassed: abstentionPass,
      abstentionCriticalFailed: abstention.length - abstentionPass,
    });
  }

  // Per-scope summary.
  const scopes: Array<{
    scope: RecallPolicyEvaluationScope;
    totalScenarios: number;
    passed: number;
    failed: number;
    abstentionCriticalTotal: number;
    abstentionCriticalPassed: number;
    abstentionCriticalFailed: number;
  }> = [];
  for (const scope of RECALL_POLICY_EVALUATION_SCOPES) {
    const scopeRuns = runs.filter((r) => r.evaluationScope === scope);
    const total = scopeRuns.length;
    const passed = scopeRuns.filter((r) => r.pass).length;
    const failed = total - passed;
    const abstention = scopeRuns.filter((r) => r.abstentionCritical);
    const abstentionPass = abstention.filter((r) => r.pass).length;
    scopes.push({
      scope,
      totalScenarios: total,
      passed,
      failed,
      abstentionCriticalTotal: abstention.length,
      abstentionCriticalPassed: abstentionPass,
      abstentionCriticalFailed: abstention.length - abstentionPass,
    });
  }

  const perCategory = RECALL_POLICY_SCENARIO_CATEGORIES.map((c) => {
    const agg = perCategoryJaccardSums.get(c);
    return {
      category: c,
      scenariosWithExpectedIds: agg?.count ?? 0,
      meanJaccard: agg && agg.count > 0 ? agg.sum / agg.count : null,
    };
  });

  const perStatusAccuracy: RecallPolicyStatusAccuracyRow[] = RECALL_POLICY_STATUSES.map(
    (status) => {
      const expected = statusExpected.get(status) ?? 0;
      const matched = statusMatched.get(status) ?? 0;
      return {
        status,
        expectedCount: expected,
        matchedCount: matched,
        accuracy: expected > 0 ? matched / expected : null,
      };
    }
  );
  const perReasonAccuracy: RecallPolicyReasonAccuracyRow[] = RECALL_POLICY_REASONS.map((reason) => {
    const expected = reasonExpected.get(reason) ?? 0;
    const matched = reasonMatched.get(reason) ?? 0;
    return {
      reason,
      expectedCount: expected,
      matchedCount: matched,
      accuracy: expected > 0 ? matched / expected : null,
    };
  });

  const abstentionFailedIds = runs
    .filter((r) => r.abstentionCritical && !r.pass)
    .map((r) => r.scenarioId);
  const safetyFailedIds = runs.filter((r) => r.safetyCritical && !r.pass).map((r) => r.scenarioId);
  const modelQualityFailedIds = runs
    .filter((r) => r.evaluationScope === "model-quality" && !r.decisionQualityPass)
    .map((r) => r.scenarioId);
  const providerPathFailedIds = runs
    .filter((r) => r.evaluationScope === "provider-path" && !r.pass)
    .map((r) => r.scenarioId);

  const abstentionGate: RecallPolicyAbstentionGate = {
    abstentionCriticalCount,
    abstentionCriticalPassed: abstentionCriticalPassedCount,
    abstentionCriticalFailed: abstentionFailedIds.length,
    passed: abstentionFailedIds.length === 0,
    failedScenarioIds: abstentionFailedIds,
  };
  const safetyGate: RecallPolicySafetyGate = {
    safetyCriticalCount,
    safetyCriticalPassed: safetyCriticalPassedCount,
    safetyCriticalFailed: safetyFailedIds.length,
    passed: safetyFailedIds.length === 0,
    failedScenarioIds: safetyFailedIds,
  };
  const modelQualityGate: RecallPolicyModelQualityGate = {
    modelQualityCount,
    modelQualityPassed: modelQualityPassedCount,
    modelQualityFailed: modelQualityFailedIds.length,
    passed: modelQualityFailedIds.length === 0,
    failedScenarioIds: modelQualityFailedIds,
  };
  const providerPathGate: RecallPolicyProviderPathGate = {
    providerPathCount,
    providerPathPassed: providerPathPassedCount,
    providerPathFailed: providerPathFailedIds.length,
    passed: providerPathFailedIds.length === 0,
    failedScenarioIds: providerPathFailedIds,
  };

  const allFailedIds = runs.filter((r) => !r.pass).map((r) => r.scenarioId);
  const allScenariosPassed = allFailedIds.length === 0;
  const overallPassed =
    abstentionGate.passed &&
    safetyGate.passed &&
    modelQualityGate.passed &&
    providerPathGate.passed;
  const gates: RecallPolicyGates = {
    abstentionPassed: abstentionGate.passed,
    safetyPassed: safetyGate.passed,
    modelQualityPassed: modelQualityGate.passed,
    providerPathPassed: providerPathGate.passed,
    allScenariosPassed,
    overallPassed,
    abstentionFailedScenarioIds: abstentionFailedIds,
    safetyFailedScenarioIds: safetyFailedIds,
    modelQualityFailedScenarioIds: modelQualityFailedIds,
    providerPathFailedScenarioIds: providerPathFailedIds,
    allFailedScenarioIds: allFailedIds,
    summary: [
      `abstention gate: ${abstentionGate.passed ? "PASS" : "FAIL"} (${abstentionCriticalCount - abstentionFailedIds.length}/${abstentionCriticalCount} abstention-critical scenarios passed)`,
      `safety gate:     ${safetyGate.passed ? "PASS" : "FAIL"} (${safetyCriticalPassedCount}/${safetyCriticalCount} safety-critical scenarios passed)`,
      `model-quality gate: ${modelQualityGate.passed ? "PASS" : "FAIL"} (${modelQualityPassedCount}/${modelQualityCount} model-quality scenarios passed by decision quality)`,
      `provider-path gate: ${providerPathGate.passed ? "PASS" : "FAIL"} (${providerPathPassedCount}/${providerPathCount} provider-path scenarios passed)`,
      `all-scenarios gate: ${allScenariosPassed ? "PASS" : "FAIL"} (${runs.length - allFailedIds.length}/${runs.length} scenarios passed)`,
      `overall: ${overallPassed ? "PASS" : "FAIL"} (abstention AND safety AND model-quality AND provider-path)`,
    ].join("; "),
  };

  return {
    scenarioSetVersion: RECALL_POLICY_SCENARIO_SET_VERSION,
    meta: {
      scenarioCount: runs.length,
      passedCount,
      failedCount,
      adapterOkCount,
      adapterFailedCount,
      totalHttpCalls,
      scenariosWithTargetMemoryMatchExpectation,
      targetMemoryMatchPassCount,
      abstentionCriticalCount,
      abstentionCriticalPassedCount,
      modelQualityCount,
      modelQualityPassedCount,
      providerPathCount,
      providerPathPassedCount,
    },
    categories,
    scopes,
    statusHistogram: RECALL_POLICY_STATUSES.map((status) => ({
      status,
      count: statusCounts.get(status) ?? 0,
    })),
    reasonHistogram: RECALL_POLICY_REASONS.map((reason) => ({
      reason,
      count: reasonCounts.get(reason) ?? 0,
    })),
    perStatusAccuracy,
    perReasonAccuracy,
    statusConfusionMatrix: {
      rows: sortedRows,
      cols: orderedCols,
      matrix,
    },
    targetMemoryMatch: {
      scenariosWithExpectedIds: perScenarioJaccard.length,
      perfectMatches,
      aggregateJaccard,
      aggregateIoU: aggregateJaccard,
      perCategory,
      perScenario: perScenarioJaccard,
    },
    providerCallStats: {
      totalCalls: totalHttpCalls,
      totalScenarios: runs.length,
      repairAttemptedCount,
      fallbackAttemptedCount,
      adapterFailedCount,
    },
    abstentionGate,
    safetyGate,
    modelQualityGate,
    providerPathGate,
    gates,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Human report formatter
// ---------------------------------------------------------------------------

/**
 * Format the evaluation report as a human-readable string.
 * Pure: same report → same string. Mirrors the layout of the
 * decision-policy evaluation's human report (`meta` →
 * `gates` → per-category summary → per-status / per-reason
 * accuracy → confusion matrix → target-memory match →
 * provider-call stats → abstention / safety gate → per-
 * scenario details → limitations) and adapts the labels to
 * the recall-policy vocabulary.
 */
export function formatRecallPolicyEvaluationReport(report: RecallPolicyEvaluationReport): string {
  const lines: string[] = [];
  lines.push("=== curion recall-policy evaluation ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push(`scenario set version: ${report.scenarioSetVersion}`);
  lines.push("evaluation mode:   scripted (no-network)");
  lines.push("");
  lines.push("--- meta ---");
  lines.push(`  scenarios:                     ${report.meta.scenarioCount}`);
  lines.push(`  passed (all assertions):       ${report.meta.passedCount}`);
  lines.push(`  failed (>=1 assertion):        ${report.meta.failedCount}`);
  lines.push(`  adapter ok:                    ${report.meta.adapterOkCount}`);
  lines.push(`  adapter failed:                ${report.meta.adapterFailedCount}`);
  lines.push(`  total http calls (sum):        ${report.meta.totalHttpCalls}`);
  lines.push(`  abstention-critical scenarios: ${report.meta.abstentionCriticalCount}`);
  lines.push(`  abstention-critical passed:    ${report.meta.abstentionCriticalPassedCount}`);
  if (report.meta.scenariosWithTargetMemoryMatchExpectation > 0) {
    lines.push(
      `  target-memory match:           ${report.meta.targetMemoryMatchPassCount}/${report.meta.scenariosWithTargetMemoryMatchExpectation}`
    );
  }
  lines.push("");
  lines.push("--- gates ---");
  lines.push(`  abstention:    ${report.gates.abstentionPassed ? "PASS" : "FAIL"}`);
  lines.push(`  safety:        ${report.gates.safetyPassed ? "PASS" : "FAIL"}`);
  lines.push(`  model-quality: ${report.gates.modelQualityPassed ? "PASS" : "FAIL"}`);
  lines.push(`  provider-path: ${report.gates.providerPathPassed ? "PASS" : "FAIL"}`);
  lines.push(`  all-scenarios: ${report.gates.allScenariosPassed ? "PASS" : "FAIL"}`);
  lines.push(`  overall:       ${report.gates.overallPassed ? "PASS" : "FAIL"}`);
  if (report.gates.abstentionFailedScenarioIds.length > 0) {
    lines.push(
      `  abstention failed scenarios:    ${report.gates.abstentionFailedScenarioIds.join(", ")}`
    );
  }
  if (report.gates.modelQualityFailedScenarioIds.length > 0) {
    lines.push(
      `  model-quality failed scenarios: ${report.gates.modelQualityFailedScenarioIds.join(", ")}`
    );
  }
  if (report.gates.providerPathFailedScenarioIds.length > 0) {
    lines.push(
      `  provider-path failed scenarios: ${report.gates.providerPathFailedScenarioIds.join(", ")}`
    );
  }
  if (report.gates.allFailedScenarioIds.length > 0) {
    lines.push(`  all-failed scenarios:           ${report.gates.allFailedScenarioIds.join(", ")}`);
  }
  lines.push(`  summary: ${report.gates.summary}`);
  lines.push("");
  lines.push("--- categories ---");
  lines.push("  category                       total  passed  failed  abstention(p/total)");
  for (const c of report.categories) {
    lines.push(
      `  ${pad(c.category, 32)} ${pad(String(c.totalScenarios), 5)} ${pad(
        String(c.passed),
        6
      )} ${pad(String(c.failed), 6)} ${pad(
        `${c.abstentionCriticalPassed}/${c.abstentionCriticalTotal}`,
        18
      )}`
    );
  }
  lines.push("");
  lines.push("--- scopes ---");
  lines.push("  scope              total  passed  failed  abstention(p/total)");
  for (const s of report.scopes) {
    lines.push(
      `  ${pad(s.scope, 18)} ${pad(String(s.totalScenarios), 5)} ${pad(
        String(s.passed),
        6
      )} ${pad(String(s.failed), 6)} ${pad(
        `${s.abstentionCriticalPassed}/${s.abstentionCriticalTotal}`,
        18
      )}`
    );
  }
  lines.push("");
  lines.push("--- status histogram ---");
  for (const row of report.statusHistogram) {
    lines.push(`  ${pad(row.status, 18)} ${row.count}`);
  }
  lines.push("");
  lines.push("--- reason histogram ---");
  for (const row of report.reasonHistogram) {
    lines.push(`  ${pad(row.reason, 28)} ${row.count}`);
  }
  lines.push("");
  lines.push("--- per-status accuracy ---");
  lines.push("  status                 expected  matched  accuracy");
  for (const row of report.perStatusAccuracy) {
    lines.push(
      `  ${pad(row.status, 22)} ${pad(String(row.expectedCount), 8)} ${pad(
        String(row.matchedCount),
        7
      )} ${row.accuracy === null ? "-" : row.accuracy.toFixed(2)}`
    );
  }
  lines.push("");
  lines.push("--- per-reason accuracy ---");
  lines.push("  reason                            expected  matched  accuracy");
  for (const row of report.perReasonAccuracy) {
    lines.push(
      `  ${pad(row.reason, 34)} ${pad(String(row.expectedCount), 8)} ${pad(
        String(row.matchedCount),
        7
      )} ${row.accuracy === null ? "-" : row.accuracy.toFixed(2)}`
    );
  }
  lines.push("");
  lines.push("--- status confusion matrix (rows = expected, cols = actual) ---");
  const colWidths = report.statusConfusionMatrix.cols.map((c) => Math.max(c.length, 8));
  const headerCells = ["expected \\ actual", ...report.statusConfusionMatrix.cols];
  const headerLine =
    "  " +
    headerCells.map((h, i) => pad(h, i === 0 ? h.length : (colWidths[i - 1] ?? 8))).join(" ");
  lines.push(headerLine);
  for (let i = 0; i < report.statusConfusionMatrix.rows.length; i += 1) {
    const r = report.statusConfusionMatrix.rows[i];
    const counts = report.statusConfusionMatrix.matrix[i] ?? [];
    const cells = [r ?? "", ...counts.map((c) => String(c))];
    const formattedCells = cells.map((c, j) =>
      pad(c, j === 0 ? (r ?? "").length : (colWidths[j - 1] ?? 8))
    );
    lines.push("  " + formattedCells.join(" "));
  }
  lines.push("");
  lines.push("--- target-memory match (Jaccard = IoU over id sets) ---");
  lines.push(
    `  scenarios with expected ids:   ${report.targetMemoryMatch.scenariosWithExpectedIds}`
  );
  lines.push(`  perfect matches (=1.00):       ${report.targetMemoryMatch.perfectMatches}`);
  lines.push(
    `  aggregate Jaccard:             ${report.targetMemoryMatch.aggregateJaccard.toFixed(3)}`
  );
  lines.push(
    `  aggregate IoU (alias):         ${report.targetMemoryMatch.aggregateIoU.toFixed(3)}`
  );
  if (report.targetMemoryMatch.perScenario.length > 0) {
    lines.push("  per-scenario Jaccard:");
    for (const r of report.targetMemoryMatch.perScenario) {
      lines.push(
        `    - ${pad(r.scenarioId, 32)} jaccard=${r.jaccard.toFixed(2)} sourceIdsCount=${r.sourceIdsCount}`
      );
    }
  }
  lines.push("  per-category mean Jaccard:");
  for (const r of report.targetMemoryMatch.perCategory) {
    lines.push(
      `    - ${pad(r.category, 28)} ${r.scenariosWithExpectedIds} scenarios${
        r.meanJaccard !== null ? ` mean=${r.meanJaccard.toFixed(3)}` : " (none)"
      }`
    );
  }
  lines.push("");
  lines.push("--- provider call stats ---");
  lines.push(`  total calls (sum):           ${report.providerCallStats.totalCalls}`);
  lines.push(`  total scenarios:             ${report.providerCallStats.totalScenarios}`);
  lines.push(`  repair attempted:            ${report.providerCallStats.repairAttemptedCount}`);
  lines.push(`  fallback attempted:          ${report.providerCallStats.fallbackAttemptedCount}`);
  lines.push(`  adapter failures (ok=false): ${report.providerCallStats.adapterFailedCount}`);
  lines.push("");
  lines.push("--- abstention gate ---");
  lines.push(`  abstention-critical count:  ${report.abstentionGate.abstentionCriticalCount}`);
  lines.push(`  abstention-critical passed: ${report.abstentionGate.abstentionCriticalPassed}`);
  lines.push(`  gate passed:                ${report.abstentionGate.passed ? "yes" : "no"}`);
  if (report.abstentionGate.failedScenarioIds.length > 0) {
    lines.push(
      `  failed scenarios:           ${report.abstentionGate.failedScenarioIds.join(", ")}`
    );
  }
  lines.push("");
  lines.push("--- safety gate ---");
  lines.push(`  safety-critical count:      ${report.safetyGate.safetyCriticalCount}`);
  lines.push(`  safety-critical passed:     ${report.safetyGate.safetyCriticalPassed}`);
  lines.push(`  gate passed:                ${report.safetyGate.passed ? "yes" : "no"}`);
  lines.push("");
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY probe of the");
  lines.push("  recall-side decision vocabulary. It runs a small,");
  lines.push("  deterministic scenario set through the benchmark-only");
  lines.push("  recall-policy adapter with a scripted `fetch` override");
  lines.push("  (no live network). It does NOT touch the production");
  lines.push("  `recall(text)` controller, the public MCP API, or the");
  lines.push("  storage layer. A pass on a scenario means 'the adapter");
  lines.push("  produces the expected structured decision under the");
  lines.push("  scripted provider behaviour', not 'the recall-policy");
  lines.push("  decision engine generalises to production traffic'.");
  lines.push("");
  lines.push("--- per-scenario summary ---");
  lines.push(
    "  scenario                       category             abstn  ok    httpCalls  repair  fallback  status                  reason                   pass"
  );
  for (const r of report.runs) {
    const label = r.scenarioId.length > 28 ? r.scenarioId.slice(0, 25) + "..." : r.scenarioId;
    const cat = r.category.length > 20 ? r.category.slice(0, 17) + "..." : r.category;
    const status = r.adapterOk ? (r.status ?? "-") : "-";
    const reason = r.adapterOk ? (r.reason ?? "-") : "-";
    lines.push(
      `  ${pad(label, 30)} ${pad(cat, 20)} ${pad(r.abstentionCritical ? "yes" : "no", 5)} ${pad(
        r.adapterOk ? "yes" : "no",
        5
      )} ${pad(String(r.httpCalls), 9)} ${pad(r.repairAttempted ? "yes" : "no", 6)} ${pad(
        r.fallbackAttempted ? "yes" : "no",
        8
      )} ${pad(status, 23)} ${pad(reason, 22)} ${r.pass ? "PASS" : "FAIL"}`
    );
  }
  lines.push("");
  for (const r of report.runs) {
    lines.push(`--- scenario: ${r.scenarioId} (${r.label}) ---`);
    lines.push(`  description:    ${r.description}`);
    lines.push(`  category:       ${r.category}`);
    lines.push(`  abstention-critical:${r.abstentionCritical ? " yes" : " no"}`);
    lines.push(`  query:          ${r.query}`);
    lines.push(`  relatedCount:   ${r.relatedCount}`);
    lines.push(`  httpCalls:      ${r.httpCalls}`);
    lines.push(`  repairAttempted:${r.repairAttempted ? " yes" : " no"}`);
    lines.push(`  fallbackAttempted:${r.fallbackAttempted ? " yes" : " no"}`);
    lines.push(
      `  targetJaccard:  ${
        r.targetMemoryJaccard === null ? "n/a" : r.targetMemoryJaccard.toFixed(3)
      }`
    );
    lines.push(`  adapter ok:     ${r.adapterOk ? "yes" : "no"}`);
    if (r.adapterOk) {
      lines.push(`    status:        ${r.status ?? "-"}`);
      lines.push(`    reason:        ${r.reason ?? "-"}`);
      lines.push(`    confidence:    ${r.confidence?.toFixed(2) ?? "-"}`);
      lines.push(`    sourceIds:     [${(r.sourceIds ?? []).join(", ")}]`);
      lines.push(`    conflictIds:   [${(r.conflictIds ?? []).join(", ")}]`);
      lines.push(`    supersededIds: [${(r.supersededIds ?? []).join(", ")}]`);
      lines.push(`    olderVariantIds:[${(r.olderVariantIds ?? []).join(", ")}]`);
    } else {
      lines.push(`    failureKind:   ${r.failureKind ?? "-"}`);
    }
    lines.push(`  assertions:     ${r.pass ? "PASS" : "FAIL"}`);
    lines.push(
      `  decision-quality assertions: ${r.decisionQualityPass ? "PASS" : "FAIL"} (provider-path mismatches are reported separately under the modelQualityGate block)`
    );
    for (const row of r.assertions) {
      lines.push(`    - [${row.group}] ${row.name}: ${row.pass ? "PASS" : "FAIL"}  ${row.note}`);
    }
    lines.push("");
  }
  lines.push("--- limitations (research-only) ---");
  for (const lim of report.limitations) {
    lines.push(`  - ${lim}`);
  }
  lines.push("");
  return lines.join("\n");
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// Re-export the helper used by the harness so callers can
// pre-build the per-scenario captured id arrays.
// `jaccardBetween` is already declared at the top of this
// module as `export function`; no further re-export needed.
