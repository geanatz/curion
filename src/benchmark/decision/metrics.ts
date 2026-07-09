/**
 * Metrics, report shape, and human formatter for the
 * decision-policy evaluation harness (v2).
 *
 * The shape is intentionally distinct from the existing
 * adaptive-depth evaluation (`src/benchmark/adaptive-depth-
 * evaluation.ts`) and the retrieval benchmark report shapes.
 * The decision evaluation is a SEPARATE study: it evaluates a
 * different code path (the decision adapter), under a different
 * scenario structure (evidence packets, not seeded memories +
 * queries), and produces a different summary (action histogram,
 * reason histogram, target-memory Jaccard match).
 *
 * What the v2 report carries:
 *
 *   - `meta`: counts + the scripted-config block + the
 *     scenario-set version stamp.
 *
 *   - `categories`: per-category summary table (count,
 *     passed, failed, safety-critical sub-count).
 *
 *   - `scopes`: per-scope summary table (`model-quality` vs
 *     `provider-path`); drives the gate attribution.
 *
 *   - `actionHistogram` + `reasonHistogram`: full vocabulary
 *     coverage tables with a count of zero when the slot was
 *     not observed.
 *
 *   - `perActionAccuracy` + `perReasonAccuracy`: per-vocabulary-
 *     slot accuracy over scenarios that set the slot
 *     expectation.
 *
 *   - `confusionMatrix`: rows = expected action (including
 *     `<none>` when the scenario does not set one), cols =
 *     actual action (including `<failed>` for failure results).
 *
 *   - `targetMemoryMatch`: aggregate Jaccard (= IoU over sets)
 *     over the scenarios that set an `expected*Ids` block.
 *
 *   - `confidenceBuckets`: low / medium / high / no-confidence
 *     counts over the successful decisions.
 *
 *   - `providerCallStats`: total calls, primary / repair /
 *     fallback attempt counts, and a fallback-used count.
 *
 *   - `safetyPrivacyGate`: per the brief, a strict pass
 *     requirement on every safety-critical scenario.
 *
 *   - `modelQualityGate`: strict pass requirement on every
 *     `evaluationScope === "model-quality"` scenario. Drives
 *     the live-mode review verdict.
 *
 *   - `providerPathGate`: strict pass requirement on every
 *     `evaluationScope === "provider-path"` scenario.
 *     Meaningful in scripted mode only; in live mode the
 *     block carries a `note` that points reviewers at the
 *     `modelQualityGate` instead.
 *
 *   - `gates`: structured overall-pass verdict. `overallPassed`
 *     is `safetyPrivacyPassed && modelQualityPassed`; the
 *     `providerPathPassed` flag is reported for transparency
 *     but is excluded from `overallPassed` because
 *     provider-path scenarios test the harness state machine
 *     rather than the model.
 *
 *   - `runs`: one entry per scenario with the captured
 *     `DecisionAdapterResult` (either success or failure shape)
 *     + the per-scenario assertions + the per-scenario
 *     computed Jaccard.
 *
 *   - `limitations`: the research-only disclosure block.
 *
 * The metrics module is pure: same report → same metrics. No I/O.
 */

import {
  type DecisionProviderId,
  REMEMBER_DECISION_ACTIONS,
  REMEMBER_DECISION_REASONS,
  type RememberDecisionAction,
  type RememberDecisionReason,
} from "../../decision/types.js";
import {
  DECISION_POLICY_EVALUATION_SCOPES,
  DECISION_POLICY_SCENARIO_CATEGORIES,
  type DecisionPolicyEvaluationScope,
  type DecisionPolicyScenarioCategory,
} from "./scenarios.js";

// ---------------------------------------------------------------------------
// Per-run captured data
// ---------------------------------------------------------------------------

/**
 * Captured id-array snapshot for the per-scenario Jaccard
 * computation. The harness records the three lists the
 * adapter's success result carries; the metrics module
 * diff-compares them against the scenario's `expected*Ids` block.
 */
export interface DecisionPolicyCapturedTargetIds {
  supersededIds: ReadonlyArray<number>;
  conflictsIds: ReadonlyArray<number>;
  redundantIds: ReadonlyArray<number>;
}

/**
 * The data the harness captures for a single scenario. The
 * report surfaces this verbatim so a reviewer can audit what the
 * adapter actually saw and what it actually returned.
 *
 * The `pass` boolean is the conjunction of BOTH groups'
 * per-run assertion passes. The `decisionQualityPass` and
 * `providerPathPass` booleans record each group separately
 * so a reviewer can tell which assertion group fired.
 *
 * In scripted mode the `modelQualityGate` (which requires
 * every model-quality scenario to pass end-to-end) reads
 * `pass`. In live mode the gate is RELAXED to read
 * `decisionQualityPass` for `model-quality` scenarios so
 * provider-path differences (a live provider may succeed
 * on the first call, which means httpCalls=1 instead of
 * the scripted expected 2) do not count against the
 * model-quality headline. This is the v2.1 attribution
 * split: scripted mode requires full end-to-end pass;
 * live mode separates the two gates per scenario.
 */
export interface DecisionPolicyScenarioRunResult {
  /** Which scenario produced this run. */
  scenarioId: string;
  /** Human-readable label. */
  label: string;
  /** Short description of the scenario. */
  description: string;
  /** The raw input the scenario fed into the evidence packet. */
  rawInput: string;
  /** The `safetyClass` written into the evidence packet. */
  safetyClass: string;
  /** Number of related memories in the evidence packet. */
  relatedCount: number;
  /**
   * Total HTTP calls the adapter actually made. Maps onto the
   * scripted-fetch state machine:
   *   - 1 = primary first (success or hard failure)
   *   - 2 = primary first + repair (success or both-fail)
   *   - 3 = primary first + repair + fallback first
   *   - 4 = primary first + repair + fallback first + repair
   */
  httpCalls: number;
  /**
   * True iff the scenario made at least one same-provider
   * repair call (i.e. the primary first response was
   * unparsable / schema-invalid). Derived from the scripted
   * fetch's per-call path labels.
   */
  repairAttempted: boolean;
  /**
   * True iff the scenario invoked the fallback path at least
   * once. Derived from the scripted fetch's per-call path
   * labels.
   */
  fallbackAttempted: boolean;
  /**
   * Whether the scenario returned a successful
   * `DecisionAdapterSuccess` (`true`) or a typed
   * `DecisionAdapterFailure` (`false`).
   */
  adapterOk: boolean;
  /** The `kind` of failure (only set when `adapterOk === false`). */
  failureKind?: "missing-config" | "invalid-input" | "invalid-output" | "all-providers-failed";
  /**
   * The successful decision's `action` (only set when
   * `adapterOk === true`).
   */
  action?: RememberDecisionAction;
  /** The successful decision's `reason` (only set when `adapterOk === true`). */
  reason?: RememberDecisionReason;
  /** The successful decision's `confidence` (only set when `adapterOk === true`). */
  confidence?: number;
  /** The successful decision's id arrays (only set when `adapterOk === true`). */
  supersededIds?: ReadonlyArray<number>;
  conflictsWithIds?: ReadonlyArray<number>;
  redundantWithIds?: ReadonlyArray<number>;
  /** Provider id that produced the final result (only set when `adapterOk === true`). */
  providerUsed?: DecisionProviderId;
  /** Model id that produced the final result (only set when `adapterOk === true`). */
  modelUsed?: string;
  /** True iff the fallback was used (only set when `adapterOk === true`). */
  fallbackUsed?: boolean;
  /** The per-scenario category. */
  category: DecisionPolicyScenarioCategory;
  /**
   * Whether the scenario participates in the safety-privacy
   * gate. Defaults to `category === "safety-privacy"` at run
   * time; recorded verbatim here.
   */
  safetyCritical: boolean;
  /**
   * The scenario's evaluation scope. Drives which gate
   * (`modelQualityGate` vs `providerPathGate`) the scenario
   * contributes to. Defaults to `"model-quality"` at run
   * time; recorded verbatim here.
   */
  evaluationScope: DecisionPolicyEvaluationScope;
  /**
   * Captured id-array snapshot for the per-scenario Jaccard /
   * IoU computation. Set to `{supersededIds, conflictsIds,
   * redundantIds}` on `adapterOk === true`; set to three empty
   * arrays on `adapterOk === false`.
   */
  capturedTargetIds: DecisionPolicyCapturedTargetIds;
  /** Per-scenario Jaccard (= IoU over id sets). `null` if no `expected*Ids` was set. */
  targetMemoryJaccard: number | null;
  /**
   * Expected action the scenario set (used by the metrics
   * builder to populate perActionAccuracy). Private to the
   * benchmark module — the property is set by the harness
   * after the run completes.
   */
  expectedAction?: RememberDecisionAction;
  /**
   * Expected reason the scenario set (used by the metrics
   * builder to populate perReasonAccuracy). Private to the
   * benchmark module.
   */
  expectedReason?: RememberDecisionReason;
  /**
   * Row label for the confusion matrix. Mirrors the
   * `expect.action` for "ok" expectations and is a
   * `<failed:kind>` label for failure expectations; `<none>`
   * when neither was set.
   */
  expectedConfusionRowLabel: string;
  /** Per-expectation assertion rows the harness checked. */
  assertions: ReadonlyArray<DecisionPolicyAssertionRow>;
  /** True iff every assertion (across both groups) passed. */
  pass: boolean;
  /**
   * True iff every `group === "decision-quality"` assertion
   * passed. This is the headline signal the live-mode
   * `modelQualityGate` reads. Recorded verbatim here so a
   * reviewer can audit a model's structured-decision quality
   * without conflating it with provider-path differences.
   */
  decisionQualityPass: boolean;
  /**
   * True iff every `group === "provider-path"` assertion
   * passed. Empty assertion sets yield `true` (vacuous). The
   * `providerPathGate` reads this field directly.
   */
  providerPathPass: boolean;
}

/**
 * A single expectation the harness checked. One row per
 * expectation field that was set on the scenario.
 */
export interface DecisionPolicyAssertionRow {
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
   *     decision shape (action, reason, target ids, outcome,
   *     confidence). Always counted against `modelQualityGate`
   *     AND `safetyPrivacyGate` regardless of mode.
   *   - `"provider-path"` — reflects the adapter's provider
   *     state-machine exercise (httpCalls, fallbackUsed).
   *     Counted against `providerPathGate`. In live mode these
   *     assertions are recorded as informational rows but do
   *     NOT fail `modelQualityGate` even when they fire on a
   *     model-quality scenario — a live provider may succeed
   *     on the first call and the harness state machine is
   *     never exercised, which is the expected live behaviour
   *     and not a decision-quality issue.
   */
  group: "decision-quality" | "provider-path";
}

// ---------------------------------------------------------------------------
// v2 metrics blocks
// ---------------------------------------------------------------------------

/**
 * Per-category summary row. The report carries one row per
 * category in `DECISION_POLICY_SCENARIO_CATEGORIES`.
 */
export interface DecisionPolicyCategorySummary {
  category: DecisionPolicyScenarioCategory;
  totalScenarios: number;
  passed: number;
  failed: number;
  safetyCriticalTotal: number;
  safetyCriticalPassed: number;
  safetyCriticalFailed: number;
}

/**
 * Per-action accuracy row: how often the adapter's emitted
 * action matched the expected action for scenarios that set an
 * `expect.action`. Computed over the scenarios that set the
 * expectation; scenarios without an expectation are excluded.
 */
export interface DecisionPolicyActionAccuracyRow {
  action: RememberDecisionAction;
  expectedCount: number;
  matchedCount: number;
  /** `matchedCount / expectedCount`. `null` when `expectedCount === 0`. */
  accuracy: number | null;
}

/**
 * Per-reason accuracy row. Mirrors the per-action shape but
 * for `expect.reason`.
 */
export interface DecisionPolicyReasonAccuracyRow {
  reason: RememberDecisionReason;
  expectedCount: number;
  matchedCount: number;
  accuracy: number | null;
}

/**
 * Confusion-matrix shape. Rows are the *expected* action
 * (`"<none>"` for scenarios with no `expect.action`,
 * `"<failed:kind>"` for scenarios that expected a failure
 * outcome); cols are the *actual* action (`"<failed:kind>"`
 * for adapter failures, otherwise the emitted action).
 *
 * The matrix is indexed by `[expectedRowIndex][actualColIndex]`.
 */
export interface DecisionPolicyConfusionMatrix {
  /** Row labels in declaration order. */
  rows: ReadonlyArray<string>;
  /** Column labels in declaration order. */
  cols: ReadonlyArray<string>;
  /** `matrix[rows.length][cols.length]` integer counts. */
  matrix: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Aggregate target-memory Jaccard block. Jaccard over id sets
 * is mathematically equal to IoU over id sets, so we emit a
 * single number under two names for the reviewer's convenience.
 */
export interface DecisionPolicyTargetMemoryMatch {
  /** Number of scenarios that set an `expected*Ids` block. */
  scenariosWithExpectedIds: number;
  /** Number of those scenarios that produced a positive Jaccard. */
  perfectMatches: number;
  /** Micro mean Jaccard across the three id arrays on the same row. */
  aggregateJaccard: number;
  /** Alias of `aggregateJaccard` (Jaccard over sets equals IoU). */
  aggregateIoU: number;
  /** Per-category mean Jaccard. */
  perCategory: ReadonlyArray<{
    category: DecisionPolicyScenarioCategory;
    scenariosWithExpectedIds: number;
    meanJaccard: number | null;
  }>;
  /** Per-scenario Jaccard list (for the human report). */
  perScenario: ReadonlyArray<{
    scenarioId: string;
    jaccard: number;
    supersededIds: number;
    conflictsIds: number;
    redundantIds: number;
  }>;
}

/**
 * Confidence-bucket histogram over the successful decisions.
 * "no-confidence" holds scenarios whose adapter result was
 * `ok: false` and therefore did not carry a confidence value.
 */
export interface DecisionPolicyConfidenceBuckets {
  /** confidence < 0.4 */
  low: number;
  /** 0.4 <= confidence < 0.7 */
  medium: number;
  /** confidence >= 0.7 */
  high: number;
  /** Scenarios without a confidence value (failure paths). */
  noConfidence: number;
}

/**
 * Provider-call stats. Aggregate counts the brief asks for.
 */
export interface DecisionPolicyProviderCallStats {
  /** Total HTTP calls across all scenarios (sum of per-run `httpCalls`). */
  totalCalls: number;
  /** Total scenarios (== totalScenarios in `meta.scenarioCount`). */
  totalScenarios: number;
  /** Scenarios where the final decision came from the fallback provider. */
  fallbackUsedCount: number;
  /** Scenarios where the same-provider repair path was invoked at least once. */
  repairAttemptedCount: number;
  /** Scenarios where the fallback path was invoked at least once. */
  fallbackAttemptedCount: number;
  /** Scenarios whose adapter result was `ok: false`. */
  adapterFailedCount: number;
}

/**
 * Safety-privacy gate block. The gate passes iff every
 * safety-critical scenario's `pass === true`. The
 * `failedScenarioIds` array lets a reviewer click through to
 * the failing rows.
 */
export interface DecisionPolicySafetyPrivacyGate {
  safetyCriticalCount: number;
  safetyCriticalPassed: number;
  safetyCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Model-quality gate block. The gate passes iff every
 * `evaluationScope === "model-quality"` scenario's
 * decision-quality assertions all pass. This is the gate
 * the live-mode review reads to decide whether the model's
 * structured-decision shape on the curated synthetic evidence
 * packets meets the brief's quality bar.
 *
 * **Mode-aware attribution** (v2.1):
 *
 * The gate separates the two assertion groups per scenario:
 *
 *   - `decisionQualityPass` is always counted against the
 *     `modelQualityGate`. This is the headline signal of
 *     "did the model produce the right structured decision?".
 *   - `providerPathPass` is NOT counted against the
 *     `modelQualityGate`. It is reported under
 *     `providerPathGate` so a live provider that succeeds
 *     on the first call (and therefore does not exercise the
 *     scripted-failure harness paths) does not penalize the
 *     model-quality headline.
 *
 * In scripted mode BOTH groups must pass for the scenario
 * to count as modelQualityPassed (this preserves the v2
 * determinism contract: scripted responses are canned and
 * every assertion is expected to fire).
 *
 * `providerPathCount` and `providerPathPassedCount` are
 * reported on the `DecisionPolicyProviderPathGate` block so
 * a reviewer who wants to compare scripted vs live behaviour
 * on the harness state machine has a single canonical place
 * to look.
 */
export interface DecisionPolicyModelQualityGate {
  modelQualityCount: number;
  modelQualityPassed: number;
  modelQualityFailed: number;
  /**
   * List of scenario ids whose `decisionQualityPass === false`.
   * This is the headline signal the live-mode review reads
   * to decide whether the model's structured-decision shape
   * on the curated synthetic evidence packets meets the
   * brief's quality bar.
   */
  failedScenarioIds: ReadonlyArray<string>;
  /**
   * List of scenario ids whose `decisionQualityPass` was true
   * but whose `pass` (full conjunction) was false because a
   * provider-path assertion failed. The list is informational
   * in scripted mode (where it should be empty because the
   * scripted fetches always honour the httpCalls /
   * fallbackUsed expectations) and meaningful in live mode
   * (where live providers may exercise a different call
   * shape than the scripted harness expected).
   */
  providerPathMismatchScenarioIds: ReadonlyArray<string>;
  passed: boolean;
}

/**
 * Provider-path gate block. The gate passes iff every
 * `evaluationScope === "provider-path"` scenario's
 * `pass === true`. These scenarios test the harness's
 * primary → repair → fallback → fallback-repair state
 * machine against scripted hard-failure / parse-failure
 * inputs.
 *
 * The gate is meaningful in scripted mode (where the
 * scripted fetch returns the canned failure shapes the
 * scenarios depend on) and is generally expected to FAIL in
 * live mode (where a real provider typically succeeds on
 * its first call and the harness state machine is never
 * exercised). Live-mode reviewers read the
 * `modelQualityGate` for the meaningful verdict; the
 * `providerPathGate` is reported here for transparency
 * only.
 */
export interface DecisionPolicyProviderPathGate {
  providerPathCount: number;
  providerPathPassed: number;
  providerPathFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
  /** Note the live-mode reviewer's caveat. */
  note?: string;
}

/**
 * Overall-gates block. Surfaces the headline pass / fail
 * verdicts the brief asks for, plus the failed-scenario ids.
 *
 * `overallPassed` is the conjunction of `safetyPrivacyPassed`
 * AND `modelQualityPassed`. Provider-path scenarios are
 * excluded from `overallPassed` because they test the harness
 * state machine, not the model, and are generally expected to
 * fail in live mode. A reviewer who wants the full "every
 * scenario passed" verdict reads `allScenariosPassed`.
 *
 * v2.1 attribution split: `modelQualityFailedScenarioIds`
 * lists scenarios whose `decisionQualityPass === false`.
 * The companion `modelQualityProviderPathMismatchScenarioIds`
 * lists model-quality scenarios whose `decisionQualityPass`
 * was true but whose full `pass` was false because a
 * provider-path assertion fired — this is the row a live
 * reviewer reads to see "the model was right; the harness
 * state machine just took a different path". In scripted
 * mode the second list is always empty because the scripted
 * fetches always honour the provider-path expectations.
 */
export interface DecisionPolicyGates {
  /** True iff every safety-critical scenario passed. */
  safetyPrivacyPassed: boolean;
  /** True iff every model-quality scenario passed. */
  modelQualityPassed: boolean;
  /** True iff every provider-path scenario passed. */
  providerPathPassed: boolean;
  /** True iff every scenario passed (across both scopes). */
  allScenariosPassed: boolean;
  /** True iff every gate passed. */
  overallPassed: boolean;
  /** List of scenario ids that failed the safety-privacy gate. */
  safetyPrivacyFailedScenarioIds: ReadonlyArray<string>;
  /** List of scenario ids that failed the model-quality gate. */
  modelQualityFailedScenarioIds: ReadonlyArray<string>;
  /**
   * List of model-quality scenario ids whose `decisionQualityPass`
   * was true but whose full `pass` was false because a
   * provider-path assertion fired. In scripted mode this list
   * is always empty; in live mode it surfaces the
   * "the model was right, the provider just took a different
   * path" cases the harness must NOT penalize.
   */
  modelQualityProviderPathMismatchScenarioIds: ReadonlyArray<string>;
  /** List of scenario ids that failed the provider-path gate. */
  providerPathFailedScenarioIds: ReadonlyArray<string>;
  /** List of all scenario ids that failed. */
  allFailedScenarioIds: ReadonlyArray<string>;
  /** Human-readable summary of all gate outcomes. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * Evaluation-mode label. `"scripted"` is the default; the
 * scripted fetch returns canned responses in-process and the
 * adapter is invoked with the test-only `fetchImpl` seam so
 * the harness never makes a real HTTP call. `"live"` is the
 * manual opt-in mode where the adapter is invoked against
 * the user's real configured provider with the harness
 * deliberately NOT passing `fetchImpl` — the adapter then
 * uses the global `fetch` and the result carries cost,
 * latency, and provider-policy implications.
 *
 * Live mode is impossible to reach accidentally: it requires
 * BOTH the `CURION_DECISION_EVAL_LIVE=1` env opt-in AND the
 * `--live` CLI flag (the runner enforces both at the CLI
 * boundary). The harness function additionally accepts an
 * explicit `mode: "live"` + `envOptInFlag: true` pair so
 * tests can exercise the live code path with a mocked
 * global `fetch` without ever touching the network.
 */
export type DecisionPolicyEvaluationMode = "scripted" | "live";

/**
 * Live-mode metadata block. Populated only when
 * `evaluationMode === "live"`. Carries the env / CLI opt-in
 * evidence, a snapshot of the provider / model / timeout /
 * max-tokens config (WITHOUT any API key value), aggregate
 * provider + model used counts, the total live HTTP call
 * count, and a reviewer-must-read-first warnings list.
 *
 * The block is deliberately omit-on-scripted so a
 * scripted-run artifact stays byte-equal to the v2 baseline.
 * A live artifact carries the block on every report.
 *
 * Safety contract: this block never carries API key
 * material. Provider presence is signalled via boolean
 * `hasPrimaryApiKey` / `hasFallbackApiKey` flags; the
 * resolved values are NOT recorded. A reviewer who wants
 * to verify key presence inspects the user's local
 * environment; the harness never echoes keys onto disk.
 */
export interface DecisionPolicyEvaluationLiveBlock {
  /** True iff `CURION_DECISION_EVAL_LIVE === "1"` at run start. */
  optInEnvPresent: boolean;
  /**
   * CLI args the runner saw (e.g. `["--live"]`). Empty when
   * the live mode was driven from the function API rather
   * than the CLI runner.
   */
  optInCliArgs: ReadonlyArray<string>;
  /**
   * Snapshot of the resolved provider config WITHOUT any
   * API key value. The `hasPrimaryApiKey` /
   * `hasFallbackApiKey` booleans signal whether a key was
   * configured; the values themselves are never recorded.
   */
  providerConfigSnapshot: {
    primaryBaseUrl: string;
    primaryModel: string;
    primaryApiFormat: "openai-compatible" | "anthropic";
    primaryProviderLabel: string;
    fallbackBaseUrl: string;
    fallbackModel: string;
    fallbackApiFormat: "openai-compatible" | "anthropic";
    fallbackProviderLabel: string;
    timeoutMs: number;
    maxTokens: number;
    /** True iff a primary API key was configured. Never the key itself. */
    hasPrimaryApiKey: boolean;
    /** True iff a fallback API key was configured. Never the key itself. */
    hasFallbackApiKey: boolean;
  };
  /**
   * Aggregate provider-id → successful-use counts. Includes
   * only scenarios whose adapter result was `ok: true`.
   * Empty in scripted mode (the block is absent).
   */
  providerUsedCounts: Readonly<Record<string, number>>;
  /**
   * Aggregate model-id → successful-use counts. Includes
   * only scenarios whose adapter result was `ok: true`.
   * Empty in scripted mode (the block is absent).
   */
  modelUsedCounts: Readonly<Record<string, number>>;
  /** Total HTTP calls across all live scenarios. */
  liveCallCount: number;
  /**
   * Reviewer-must-read-first warnings. Documents the live
   * mode's safety caveats: cost, provider-policy,
   * latency, secrets-on-disk, scenario-only coverage, etc.
   */
  warnings: ReadonlyArray<string>;
}

/**
 * The top-level evaluation report (v2). The JSON artifact is
 * one of these. Same convention as the adaptive-depth
 * evaluation: the artifact is machine-readable; the human
 * formatter in `formatDecisionPolicyEvaluationReport` produces
 * the human text.
 */
export interface DecisionPolicyEvaluationReport {
  /** ISO timestamp the report was generated at. */
  generatedAt: string;
  /**
   * Scenario-set version stamp ("v2"). The harness surfaces
   * this verbatim on every artifact so a reviewer can read
   * "this artifact was produced under v2" without re-deriving
   * the count.
   */
  scenarioSetVersion: string;
  /**
   * Evaluation mode. `"scripted"` (default, no network) or
   * `"live"` (manual opt-in, real provider call). The
   * presence of the `live` metadata block is the canonical
   * signal that a report was produced in live mode.
   */
  evaluationMode: DecisionPolicyEvaluationMode;
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
    /**
     * Total HTTP calls across all scenarios. Sum of per-run
     * `httpCalls`. Useful for sizing a real-world run.
     */
    totalHttpCalls: number;
    /**
     * Number of scenarios with at least one
     * target-memory-match expectation. The denominator for the
     * target-memory match rate metric.
     */
    scenariosWithTargetMemoryMatchExpectation: number;
    /**
     * Number of scenarios whose target-memory match
     * expectation passed (every assertion in the target-memory
     * group passed).
     */
    targetMemoryMatchPassCount: number;
    /** Number of safety-critical scenarios. */
    safetyCriticalCount: number;
    /** Number of safety-critical scenarios that passed. */
    safetyCriticalPassedCount: number;
    /**
     * Number of `evaluationScope === "model-quality"` scenarios.
     * The denominator for the `modelQualityGate` block.
     */
    modelQualityCount: number;
    /**
     * Number of `evaluationScope === "model-quality"` scenarios
     * that passed. Reported on the `modelQualityGate` block.
     */
    modelQualityPassedCount: number;
    /**
     * Number of `evaluationScope === "provider-path"` scenarios.
     * The denominator for the `providerPathGate` block.
     */
    providerPathCount: number;
    /**
     * Number of `evaluationScope === "provider-path"` scenarios
     * that passed. Reported on the `providerPathGate` block.
     */
    providerPathPassedCount: number;
  };
  /** Per-category summary, one row per `DECISION_POLICY_SCENARIO_CATEGORIES` slot. */
  categories: ReadonlyArray<DecisionPolicyCategorySummary>;
  /** Per-scope summary, one row per `DECISION_POLICY_EVALUATION_SCOPES` slot. */
  scopes: ReadonlyArray<{
    scope: DecisionPolicyEvaluationScope;
    totalScenarios: number;
    passed: number;
    failed: number;
    safetyCriticalTotal: number;
    safetyCriticalPassed: number;
    safetyCriticalFailed: number;
  }>;
  /** Action histogram (one entry per action vocabulary slot). */
  actionHistogram: ReadonlyArray<{ action: RememberDecisionAction; count: number }>;
  /** Reason histogram (one entry per reason vocabulary slot). */
  reasonHistogram: ReadonlyArray<{ reason: RememberDecisionReason; count: number }>;
  /** Per-action accuracy over scenarios with an `expect.action`. */
  perActionAccuracy: ReadonlyArray<DecisionPolicyActionAccuracyRow>;
  /** Per-reason accuracy over scenarios with an `expect.reason`. */
  perReasonAccuracy: ReadonlyArray<DecisionPolicyReasonAccuracyRow>;
  /** Confusion matrix (rows = expected, cols = actual). */
  confusionMatrix: DecisionPolicyConfusionMatrix;
  /** Aggregate Jaccard over scenarios with `expected*Ids`. */
  targetMemoryMatch: DecisionPolicyTargetMemoryMatch;
  /** Confidence-bucket histogram. */
  confidenceBuckets: DecisionPolicyConfidenceBuckets;
  /** Provider-call stats. */
  providerCallStats: DecisionPolicyProviderCallStats;
  /** Safety-privacy gate block. */
  safetyPrivacyGate: DecisionPolicySafetyPrivacyGate;
  /** Model-quality gate block. */
  modelQualityGate: DecisionPolicyModelQualityGate;
  /** Provider-path gate block. */
  providerPathGate: DecisionPolicyProviderPathGate;
  /** Overall-gates block. */
  gates: DecisionPolicyGates;
  /** Per-scenario captured data, in scenario declaration order. */
  runs: ReadonlyArray<DecisionPolicyScenarioRunResult>;
  /** Limitations block (research-only disclosure). */
  limitations: ReadonlyArray<string>;
  /**
   * Live-mode metadata block. Populated only when
   * `evaluationMode === "live"`. Absent in scripted mode so
   * a scripted artifact stays byte-equal to the v2 baseline.
   * See `DecisionPolicyEvaluationLiveBlock` for the field
   * contract and the no-secrets safety guarantee.
   */
  live?: DecisionPolicyEvaluationLiveBlock;
}

// ---------------------------------------------------------------------------
// Metrics builder
// ---------------------------------------------------------------------------

/**
 * Internal: validate-id helper used by the metrics builder.
 * Returns the integer "is in captured set" predicate.
 */
function capturedIdSet(ids: ReadonlyArray<number>): Set<number> {
  return new Set(ids);
}

/**
 * Compute the Jaccard index (= IoU) between two id arrays.
 * Returns `null` when both inputs are empty (an under-defined
 * scenario; the harness treats this as "no expectation set" and
 * computes the Jaccard only when at least one side is non-empty).
 */
function jaccardBetween(expected: ReadonlyArray<number>, captured: ReadonlyArray<number>): number {
  const expectedSet = new Set(expected);
  const capturedSet = new Set(captured);
  if (expectedSet.size === 0 && capturedSet.size === 0) {
    // Both empty: treat as a perfect match (1.0) so clarify
    // semantics produce a meaningful aggregate. The harness
    // also asserts the captured id arrays are empty via the
    // negative target-memory check.
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

/**
 * Build the v2 metrics block from a list of per-scenario run
 * results. Pure: same input → same output. The histograms
 * always include every action / reason vocabulary slot, with
 * a count of zero when the slot was not observed. The
 * confusion matrix always includes every action row + the
 * `<none>` / `<failed:kind>` extras.
 */
export function buildDecisionPolicyEvaluationMetrics(
  runs: ReadonlyArray<DecisionPolicyScenarioRunResult>,
  args: { mode: DecisionPolicyEvaluationMode; liveBlock?: DecisionPolicyEvaluationLiveBlock } = {
    mode: "scripted",
  }
): Omit<DecisionPolicyEvaluationReport, "generatedAt" | "limitations"> {
  let passedCount = 0;
  let failedCount = 0;
  let adapterOkCount = 0;
  let adapterFailedCount = 0;
  let totalHttpCalls = 0;
  let scenariosWithTargetMemoryMatchExpectation = 0;
  let targetMemoryMatchPassCount = 0;
  let safetyCriticalCount = 0;
  let safetyCriticalPassedCount = 0;
  let modelQualityCount = 0;
  let modelQualityPassedCount = 0;
  let providerPathCount = 0;
  let providerPathPassedCount = 0;
  // v2.1 attribution split: per-group counters so the
  // `modelQualityGate` can be sourced from
  // `decisionQualityPass` (NOT the conjunction `pass`) while
  // the `providerPathGate` continues to source from the
  // conjunction. In scripted mode these counters are equal
  // to the `modelQualityPassedCount` / `providerPathPassedCount`
  // counters because the scripted fetches always honour the
  // provider-path expectations. In live mode the two can
  // diverge: a model-quality scenario whose decision-quality
  // assertions pass but whose provider-path assertions fail
  // (because a live provider succeeded on the first call) is
  // counted in `decisionQualityPassedCount` but NOT in
  // `modelQualityPassedCount` (because `pass` is the
  // conjunction).
  let decisionQualityPassedCount = 0;
  let providerPathPassCount = 0;
  let fallbackUsedCount = 0;
  let repairAttemptedCount = 0;
  let fallbackAttemptedCount = 0;
  let confidenceLow = 0;
  let confidenceMedium = 0;
  let confidenceHigh = 0;
  let confidenceNoConfidence = 0;

  const actionCounts = new Map<RememberDecisionAction, number>();
  const reasonCounts = new Map<RememberDecisionReason, number>();
  for (const action of REMEMBER_DECISION_ACTIONS) actionCounts.set(action, 0);
  for (const reason of REMEMBER_DECISION_REASONS) reasonCounts.set(reason, 0);

  // Per-action expected / matched tallies (for perActionAccuracy).
  const actionExpected = new Map<RememberDecisionAction, number>();
  const actionMatched = new Map<RememberDecisionAction, number>();
  for (const action of REMEMBER_DECISION_ACTIONS) {
    actionExpected.set(action, 0);
    actionMatched.set(action, 0);
  }
  const reasonExpected = new Map<RememberDecisionReason, number>();
  const reasonMatched = new Map<RememberDecisionReason, number>();
  for (const reason of REMEMBER_DECISION_REASONS) {
    reasonExpected.set(reason, 0);
    reasonMatched.set(reason, 0);
  }

  // Confusion matrix axes. Cols start from the action vocabulary
  // and gain a `<failed:all-providers-failed>` col for failure
  // results. Rows start from the action vocabulary and gain:
  //   - `<none>` — a scenario with no `expect.action`
  //                (e.g. an expected failure outcome)
  //   - one row per failure kind a scenario might expect.
  //
  // We gather actual labels dynamically so a future action that
  // the engine emits but we did not predict (it cannot — the
  // schema is closed) still gets counted under the "action"
  // vocabulary. For defensiveness we still allow extras via
  // the union of expected-row labels and actual-col labels.
  const colLabels = new Set<string>();
  const rowLabels = new Set<string>();
  for (const action of REMEMBER_DECISION_ACTIONS) colLabels.add(action);
  // Failure-style cols are added on demand below.

  // Confusion-matrix counts. We index by string label so the
  // final ordering is decided once all rows / cols are known.
  const confusionCells = new Map<string, number>();

  // Per-category Jaccard aggregation.
  const perCategoryJaccardSums = new Map<
    DecisionPolicyScenarioCategory,
    { sum: number; count: number }
  >();

  // Per-scenario Jaccard list for the human report. Build into
  // a writable local array and convert to readonly at the end.
  const perScenarioJaccard: Array<{
    scenarioId: string;
    jaccard: number;
    supersededIds: number;
    conflictsIds: number;
    redundantIds: number;
  }> = [];
  let perfectMatches = 0;

  for (const run of runs) {
    if (run.pass) passedCount += 1;
    else failedCount += 1;
    // Per-group pass counts. The headline `modelQualityGate`
    // reads `decisionQualityPass` only so provider-path
    // differences (live-mode-only) do not count against the
    // model-quality verdict. The `providerPathGate` reads the
    // conjunction (`pass`) so scripted-mode coverage stays
    // deterministic.
    if (run.decisionQualityPass) decisionQualityPassedCount += 1;
    if (run.providerPathPass) providerPathPassCount += 1;
    if (run.adapterOk) {
      adapterOkCount += 1;
      if (run.action) actionCounts.set(run.action, (actionCounts.get(run.action) ?? 0) + 1);
      if (run.reason) reasonCounts.set(run.reason, (reasonCounts.get(run.reason) ?? 0) + 1);
      if (run.fallbackUsed) fallbackUsedCount += 1;
      if (typeof run.confidence === "number") {
        if (run.confidence < 0.4) confidenceLow += 1;
        else if (run.confidence < 0.7) confidenceMedium += 1;
        else confidenceHigh += 1;
      } else {
        confidenceNoConfidence += 1;
      }
    } else {
      adapterFailedCount += 1;
      confidenceNoConfidence += 1;
    }
    totalHttpCalls += run.httpCalls;
    if (run.repairAttempted) repairAttemptedCount += 1;
    if (run.fallbackAttempted) fallbackAttemptedCount += 1;

    if (run.safetyCritical) {
      safetyCriticalCount += 1;
      if (run.pass) safetyCriticalPassedCount += 1;
    }

    // Per-scope counters. Drives the `scopes` summary block
    // and the `modelQualityGate` / `providerPathGate` blocks.
    // The model-quality gate counts `decisionQualityPass` only
    // so a live provider that succeeds on its first call does
    // not penalize the model-quality headline. The provider-path
    // gate continues to source from the full `pass` conjunction
    // so scripted-mode coverage stays deterministic.
    if (run.evaluationScope === "provider-path") {
      providerPathCount += 1;
      if (run.pass) providerPathPassedCount += 1;
    } else {
      modelQualityCount += 1;
      if (run.decisionQualityPass) modelQualityPassedCount += 1;
    }

    // Per-action accuracy + per-reason accuracy.
    // The harness records the expected action / reason on
    // the run result; we use those values to attribute the
    // scenario to the right accuracy bucket.
    const actionAssertion = run.assertions.find((a) => a.name === "action");
    if (actionAssertion && run.expectedAction !== undefined) {
      const expectedAction = run.expectedAction;
      actionExpected.set(expectedAction, (actionExpected.get(expectedAction) ?? 0) + 1);
      if (actionAssertion.pass && run.action === expectedAction) {
        actionMatched.set(expectedAction, (actionMatched.get(expectedAction) ?? 0) + 1);
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

    // Confusion matrix: row = expected action / failure,
    // col = actual action / failure.
    const expectedRowLabel = run.expectedConfusionRowLabel;
    const actualColLabel = run.adapterOk
      ? (run.action ?? "<none>")
      : `<failed:${run.failureKind ?? "unknown"}>`;
    rowLabels.add(expectedRowLabel);
    colLabels.add(actualColLabel);
    const cellKey = `${expectedRowLabel}\u0000${actualColLabel}`;
    confusionCells.set(cellKey, (confusionCells.get(cellKey) ?? 0) + 1);

    // Target-memory match rate + per-scenario Jaccard.
    const targetMemoryAssertions = run.assertions.filter(
      (a) =>
        a.name.startsWith("targetIdIn") ||
        a.name.startsWith("expectedSupersededIds") ||
        a.name.startsWith("expectedConflictsIds") ||
        a.name.startsWith("expectedRedundantIds") ||
        a.name.startsWith("targetIdNotIn")
    );
    if (targetMemoryAssertions.length > 0) {
      scenariosWithTargetMemoryMatchExpectation += 1;
      const allPass = targetMemoryAssertions.every((a) => a.pass);
      if (allPass) targetMemoryMatchPassCount += 1;
    }

    // Per-scenario Jaccard is computed only when the scenario
    // set `expectedSupersededIds` (or one of the other two
    // expected-id lists). For "no expectation" scenarios the
    // per-scenario Jaccard is recorded as `null` in the run
    // result and skipped from the per-scenario Jaccard list.
    if (run.targetMemoryJaccard !== null) {
      perScenarioJaccard.push({
        scenarioId: run.scenarioId,
        jaccard: run.targetMemoryJaccard,
        supersededIds: run.capturedTargetIds.supersededIds.length,
        conflictsIds: run.capturedTargetIds.conflictsIds.length,
        redundantIds: run.capturedTargetIds.redundantIds.length,
      });
      if (run.targetMemoryJaccard === 1) perfectMatches += 1;
      const cat = run.category;
      const cur = perCategoryJaccardSums.get(cat) ?? { sum: 0, count: 0 };
      cur.sum += run.targetMemoryJaccard;
      cur.count += 1;
      perCategoryJaccardSums.set(cat, cur);
    }
  }

  // Aggregate Jaccard = micro mean across per-scenario Jaccards.
  const aggregateJaccard =
    perScenarioJaccard.length > 0
      ? perScenarioJaccard.reduce((s, r) => s + r.jaccard, 0) / perScenarioJaccard.length
      : 0;

  // Confusion matrix dense build.
  const sortedCols = Array.from(colLabels).sort();
  const sortedRows = Array.from(rowLabels).sort();
  // We want a stable, vocabulary-first ordering for the action
  // labels in cols: REMEMBER_DECISION_ACTIONS in declaration
  // order, then any extras alphabetically.
  const orderedCols: string[] = [];
  for (const a of REMEMBER_DECISION_ACTIONS) {
    if (sortedCols.includes(a)) orderedCols.push(a);
  }
  for (const c of sortedCols) {
    if (!orderedCols.includes(c)) orderedCols.push(c);
  }
  // Rows keep the sorted order — they're a mixed set (action
  // labels + `<none>` + `<failed:kind>` rows).
  const matrix: number[][] = [];
  for (const r of sortedRows) {
    const row: number[] = [];
    for (const c of orderedCols) {
      row.push(confusionCells.get(`${r}\u0000${c}`) ?? 0);
    }
    matrix.push(row);
  }

  // Per-category summary.
  const categories: DecisionPolicyCategorySummary[] = [];
  for (const cat of DECISION_POLICY_SCENARIO_CATEGORIES) {
    const catRuns = runs.filter((r) => r.category === cat);
    const total = catRuns.length;
    const passed = catRuns.filter((r) => r.pass).length;
    const failed = total - passed;
    const safety = catRuns.filter((r) => r.safetyCritical);
    const safetyPass = safety.filter((r) => r.pass).length;
    categories.push({
      category: cat,
      totalScenarios: total,
      passed,
      failed,
      safetyCriticalTotal: safety.length,
      safetyCriticalPassed: safetyPass,
      safetyCriticalFailed: safety.length - safetyPass,
    });
  }

  // Per-scope summary. Drives the human report's "scopes"
  // table and the `modelQualityGate` / `providerPathGate`
  // blocks. The summary uses the same shape as the per-category
  // summary so a reviewer reading the artifact can compare
  // category and scope side-by-side.
  const scopes: Array<{
    scope: DecisionPolicyEvaluationScope;
    totalScenarios: number;
    passed: number;
    failed: number;
    safetyCriticalTotal: number;
    safetyCriticalPassed: number;
    safetyCriticalFailed: number;
  }> = [];
  for (const scope of DECISION_POLICY_EVALUATION_SCOPES) {
    const scopeRuns = runs.filter((r) => r.evaluationScope === scope);
    const total = scopeRuns.length;
    const passed = scopeRuns.filter((r) => r.pass).length;
    const failed = total - passed;
    const safety = scopeRuns.filter((r) => r.safetyCritical);
    const safetyPass = safety.filter((r) => r.pass).length;
    scopes.push({
      scope,
      totalScenarios: total,
      passed,
      failed,
      safetyCriticalTotal: safety.length,
      safetyCriticalPassed: safetyPass,
      safetyCriticalFailed: safety.length - safetyPass,
    });
  }

  // Per-category Jaccard list.
  const perCategory = DECISION_POLICY_SCENARIO_CATEGORIES.map((c) => {
    const agg = perCategoryJaccardSums.get(c);
    return {
      category: c,
      scenariosWithExpectedIds: agg?.count ?? 0,
      meanJaccard: agg && agg.count > 0 ? agg.sum / agg.count : null,
    };
  });

  // Per-action / per-reason accuracy rows.
  const perActionAccuracy: DecisionPolicyActionAccuracyRow[] = REMEMBER_DECISION_ACTIONS.map(
    (action) => {
      const expected = actionExpected.get(action) ?? 0;
      const matched = actionMatched.get(action) ?? 0;
      return {
        action,
        expectedCount: expected,
        matchedCount: matched,
        accuracy: expected > 0 ? matched / expected : null,
      };
    }
  );
  const perReasonAccuracy: DecisionPolicyReasonAccuracyRow[] = REMEMBER_DECISION_REASONS.map(
    (reason) => {
      const expected = reasonExpected.get(reason) ?? 0;
      const matched = reasonMatched.get(reason) ?? 0;
      return {
        reason,
        expectedCount: expected,
        matchedCount: matched,
        accuracy: expected > 0 ? matched / expected : null,
      };
    }
  );

  // Safety-privacy gate.
  const safetyCriticalRuns = runs.filter((r) => r.safetyCritical);
  const safetyFailedIds = safetyCriticalRuns.filter((r) => !r.pass).map((r) => r.scenarioId);
  const safetyPrivacyGate: DecisionPolicySafetyPrivacyGate = {
    safetyCriticalCount: safetyCriticalRuns.length,
    safetyCriticalPassed: safetyCriticalRuns.filter((r) => r.pass).length,
    safetyCriticalFailed: safetyFailedIds.length,
    passed: safetyFailedIds.length === 0,
    failedScenarioIds: safetyFailedIds,
  };

  // Model-quality gate. Drives `gates.overallPassed` and the
  // headline live-mode review verdict. The gate passes iff
  // there are no model-quality failures; an empty set of
  // model-quality scenarios passes vacuously (consistent
  // with `allScenariosPassed` and the v1 gate semantics).
  //
  // v2.1 attribution split: the gate is sourced from
  // `decisionQualityPass` per scenario (NOT the full `pass`
  // conjunction) so a live provider that succeeds on its
  // first call (and therefore makes fewer HTTP calls than the
  // scripted expectation) does NOT fail the model-quality
  // headline. The `providerPathMismatchScenarioIds` list
  // surfaces the model-quality scenarios whose
  // `decisionQualityPass` was true but whose full `pass` was
  // false because a provider-path assertion failed — this is
  // the v2.1 transparency row a live reviewer reads.
  const modelQualityRuns = runs.filter((r) => r.evaluationScope === "model-quality");
  const modelQualityFailedIds = modelQualityRuns
    .filter((r) => !r.decisionQualityPass)
    .map((r) => r.scenarioId);
  const providerPathMismatchIds = modelQualityRuns
    .filter((r) => r.decisionQualityPass && !r.pass)
    .map((r) => r.scenarioId);
  const modelQualityGate: DecisionPolicyModelQualityGate = {
    modelQualityCount: modelQualityRuns.length,
    modelQualityPassed: modelQualityRuns.filter((r) => r.decisionQualityPass).length,
    modelQualityFailed: modelQualityFailedIds.length,
    passed: modelQualityFailedIds.length === 0,
    failedScenarioIds: modelQualityFailedIds,
    providerPathMismatchScenarioIds: providerPathMismatchIds,
  };

  // Provider-path gate. Meaningful in scripted mode only;
  // live-mode reviewers read the modelQualityGate. An empty
  // set of provider-path scenarios passes vacuously.
  const providerPathRuns = runs.filter((r) => r.evaluationScope === "provider-path");
  const providerPathFailedIds = providerPathRuns.filter((r) => !r.pass).map((r) => r.scenarioId);
  const providerPathGate: DecisionPolicyProviderPathGate = {
    providerPathCount: providerPathRuns.length,
    providerPathPassed: providerPathRuns.filter((r) => r.pass).length,
    providerPathFailed: providerPathFailedIds.length,
    passed: providerPathFailedIds.length === 0,
    failedScenarioIds: providerPathFailedIds,
    ...(args.mode === "live"
      ? {
          note:
            "Provider-path gate is reported for transparency only. Live providers " +
            "typically succeed on the first call so the scripted-failure expectations " +
            "for these scenarios almost always fail in live mode. Read `modelQualityGate` " +
            "for the live-mode review verdict.",
        }
      : {}),
  };

  // Overall gates.
  const allFailedIds = runs.filter((r) => !r.pass).map((r) => r.scenarioId);
  const allScenariosPassed = allFailedIds.length === 0;
  // `overallPassed` excludes provider-path scenarios from the
  // conjunction so live-mode reviewers are not penalized for
  // the harness state machine not exercising scripted
  // hard-failure paths. The model-quality gate itself is
  // sourced from `decisionQualityPass` (see
  // `modelQualityGate.passed`) so a model-quality scenario
  // whose decision-quality assertions pass but whose
  // provider-path assertions fail (a live-only pattern) does
  // NOT fail the headline verdict.
  const gates: DecisionPolicyGates = {
    safetyPrivacyPassed: safetyPrivacyGate.passed,
    modelQualityPassed: modelQualityGate.passed,
    providerPathPassed: providerPathGate.passed,
    allScenariosPassed,
    overallPassed: safetyPrivacyGate.passed && modelQualityGate.passed,
    safetyPrivacyFailedScenarioIds: safetyFailedIds,
    modelQualityFailedScenarioIds: modelQualityFailedIds,
    modelQualityProviderPathMismatchScenarioIds: modelQualityGate.providerPathMismatchScenarioIds,
    providerPathFailedScenarioIds: providerPathFailedIds,
    allFailedScenarioIds: allFailedIds,
    summary: [
      `safety-privacy gate: ${safetyPrivacyGate.passed ? "PASS" : "FAIL"} (${safetyCriticalRuns.length - safetyFailedIds.length}/${safetyCriticalRuns.length} safety-critical scenarios passed)`,
      `model-quality gate: ${modelQualityGate.passed ? "PASS" : "FAIL"} (${modelQualityGate.modelQualityPassed}/${modelQualityGate.modelQualityCount} model-quality scenarios passed by decision quality)`,
      `provider-path gate: ${providerPathGate.passed ? "PASS" : "FAIL"} (${providerPathGate.providerPathPassed}/${providerPathGate.providerPathCount} provider-path scenarios passed)`,
      `all-scenarios gate: ${allScenariosPassed ? "PASS" : "FAIL"} (${runs.length - allFailedIds.length}/${runs.length} scenarios passed)`,
      `overall: ${safetyPrivacyGate.passed && modelQualityGate.passed ? "PASS" : "FAIL"} (safety-privacy AND model-quality by decision quality)`,
    ].join("; "),
  };

  return {
    scenarioSetVersion: "v2",
    evaluationMode: args.mode,
    meta: {
      scenarioCount: runs.length,
      passedCount,
      failedCount,
      adapterOkCount,
      adapterFailedCount,
      totalHttpCalls,
      scenariosWithTargetMemoryMatchExpectation,
      targetMemoryMatchPassCount,
      safetyCriticalCount,
      safetyCriticalPassedCount,
      modelQualityCount,
      modelQualityPassedCount,
      providerPathCount,
      providerPathPassedCount,
    },
    categories,
    scopes,
    actionHistogram: REMEMBER_DECISION_ACTIONS.map((action) => ({
      action,
      count: actionCounts.get(action) ?? 0,
    })),
    reasonHistogram: REMEMBER_DECISION_REASONS.map((reason) => ({
      reason,
      count: reasonCounts.get(reason) ?? 0,
    })),
    perActionAccuracy,
    perReasonAccuracy,
    confusionMatrix: {
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
    confidenceBuckets: {
      low: confidenceLow,
      medium: confidenceMedium,
      high: confidenceHigh,
      noConfidence: confidenceNoConfidence,
    },
    providerCallStats: {
      totalCalls: totalHttpCalls,
      totalScenarios: runs.length,
      fallbackUsedCount,
      repairAttemptedCount,
      fallbackAttemptedCount,
      adapterFailedCount,
    },
    safetyPrivacyGate,
    modelQualityGate,
    providerPathGate,
    gates,
    runs,
    ...(args.mode === "live" && args.liveBlock ? { live: args.liveBlock } : {}),
  };
}

// ---------------------------------------------------------------------------
// Human report formatter
// ---------------------------------------------------------------------------

/**
 * Format the evaluation report as a human-readable string. The
 * format mirrors the adaptive-depth evaluation's human report
 * (meta → per-scenario summary → per-scenario details →
 * limitations) and extends with v2 category / confusion-matrix /
 * Jaccard / gates sections. The function is pure: same report
 * → same string.
 */
export function formatDecisionPolicyEvaluationReport(
  report: DecisionPolicyEvaluationReport
): string {
  const lines: string[] = [];
  lines.push("=== curion decision-policy evaluation ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push(`scenario set version: ${report.scenarioSetVersion}`);
  lines.push(`evaluation mode:   ${report.evaluationMode}`);
  lines.push("");
  // ---- Metadata header ----
  lines.push("--- meta ---");
  lines.push(`  scenarios:                     ${report.meta.scenarioCount}`);
  lines.push(`  passed (all assertions):       ${report.meta.passedCount}`);
  lines.push(`  failed (>=1 assertion):        ${report.meta.failedCount}`);
  lines.push(`  adapter ok:                    ${report.meta.adapterOkCount}`);
  lines.push(`  adapter failed:                ${report.meta.adapterFailedCount}`);
  lines.push(`  total http calls (sum):        ${report.meta.totalHttpCalls}`);
  lines.push(`  safety-critical scenarios:     ${report.meta.safetyCriticalCount}`);
  lines.push(`  safety-critical passed:        ${report.meta.safetyCriticalPassedCount}`);
  if (report.meta.scenariosWithTargetMemoryMatchExpectation > 0) {
    lines.push(
      `  target-memory match:           ${report.meta.targetMemoryMatchPassCount}/${report.meta.scenariosWithTargetMemoryMatchExpectation}`
    );
  }
  lines.push("");
  // ---- Gates ----
  lines.push("--- gates ---");
  lines.push(`  safety-privacy: ${report.gates.safetyPrivacyPassed ? "PASS" : "FAIL"}`);
  lines.push(`  model-quality:  ${report.gates.modelQualityPassed ? "PASS" : "FAIL"}`);
  lines.push(`  provider-path:  ${report.gates.providerPathPassed ? "PASS" : "FAIL"}`);
  lines.push(`  all-scenarios:  ${report.gates.allScenariosPassed ? "PASS" : "FAIL"}`);
  lines.push(`  overall:        ${report.gates.overallPassed ? "PASS" : "FAIL"}`);
  if (report.gates.safetyPrivacyFailedScenarioIds.length > 0) {
    lines.push(
      `  safety-privacy failed scenarios: ${report.gates.safetyPrivacyFailedScenarioIds.join(", ")}`
    );
  }
  if (report.gates.modelQualityFailedScenarioIds.length > 0) {
    lines.push(
      `  model-quality failed scenarios:  ${report.gates.modelQualityFailedScenarioIds.join(", ")}`
    );
  }
  if (report.gates.modelQualityProviderPathMismatchScenarioIds.length > 0) {
    lines.push(
      `  model-quality provider-path mismatches (decision-quality PASS, full PASS FAIL — live-mode-only): ${report.gates.modelQualityProviderPathMismatchScenarioIds.join(", ")}`
    );
  }
  if (report.gates.providerPathFailedScenarioIds.length > 0) {
    lines.push(
      `  provider-path failed scenarios:  ${report.gates.providerPathFailedScenarioIds.join(", ")}`
    );
  }
  if (report.gates.allFailedScenarioIds.length > 0) {
    lines.push(`  all-failed scenarios:           ${report.gates.allFailedScenarioIds.join(", ")}`);
  }
  lines.push(`  summary: ${report.gates.summary}`);
  lines.push("");
  // ---- Per-category summary ----
  lines.push("--- categories ---");
  lines.push("  category                       total  passed  failed  safety-crit(p/total)");
  for (const c of report.categories) {
    lines.push(
      `  ${pad(c.category, 32)} ${pad(String(c.totalScenarios), 5)} ${pad(
        String(c.passed),
        6
      )} ${pad(String(c.failed), 6)} ${pad(
        `${c.safetyCriticalPassed}/${c.safetyCriticalTotal}`,
        18
      )}`
    );
  }
  lines.push("");
  // ---- Per-scope summary ----
  lines.push("--- scopes ---");
  lines.push("  scope              total  passed  failed  safety-crit(p/total)");
  for (const s of report.scopes) {
    lines.push(
      `  ${pad(s.scope, 18)} ${pad(String(s.totalScenarios), 5)} ${pad(
        String(s.passed),
        6
      )} ${pad(String(s.failed), 6)} ${pad(
        `${s.safetyCriticalPassed}/${s.safetyCriticalTotal}`,
        18
      )}`
    );
  }
  lines.push("");
  // ---- Action histogram ----
  lines.push("--- action histogram ---");
  for (const row of report.actionHistogram) {
    lines.push(`  ${pad(row.action, 20)} ${row.count}`);
  }
  lines.push("");
  // ---- Reason histogram ----
  lines.push("--- reason histogram ---");
  for (const row of report.reasonHistogram) {
    lines.push(`  ${pad(row.reason, 28)} ${row.count}`);
  }
  lines.push("");
  // ---- Per-action accuracy ----
  lines.push("--- per-action accuracy ---");
  lines.push("  action                  expected  matched  accuracy");
  for (const row of report.perActionAccuracy) {
    lines.push(
      `  ${pad(row.action, 22)} ${pad(String(row.expectedCount), 8)} ${pad(
        String(row.matchedCount),
        7
      )} ${row.accuracy === null ? "-" : row.accuracy.toFixed(2)}`
    );
  }
  lines.push("");
  // ---- Per-reason accuracy ----
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
  // ---- Confusion matrix ----
  lines.push("--- confusion matrix (rows = expected, cols = actual) ---");
  const colWidths = report.confusionMatrix.cols.map((c) => Math.max(c.length, 8));
  const headerCells = ["expected \\ actual", ...report.confusionMatrix.cols];
  const headerLine =
    "  " +
    headerCells.map((h, i) => pad(h, i === 0 ? h.length : (colWidths[i - 1] ?? 8))).join(" ");
  lines.push(headerLine);
  for (let i = 0; i < report.confusionMatrix.rows.length; i += 1) {
    const r = report.confusionMatrix.rows[i];
    const counts = report.confusionMatrix.matrix[i] ?? [];
    const cells = [r ?? "", ...counts.map((c, j) => String(c))];
    const formattedCells = cells.map((c, j) =>
      pad(c, j === 0 ? (r ?? "").length : (colWidths[j - 1] ?? 8))
    );
    lines.push("  " + formattedCells.join(" "));
  }
  lines.push("");
  // ---- Target-memory match (Jaccard / IoU) ----
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
        `    - ${pad(r.scenarioId, 32)} jaccard=${r.jaccard.toFixed(2)} captured=[${r.supersededIds}|${r.conflictsIds}|${r.redundantIds}]`
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
  // ---- Confidence buckets ----
  lines.push("--- confidence buckets ---");
  lines.push(`  low    (<0.40):       ${report.confidenceBuckets.low}`);
  lines.push(`  medium (0.40..0.70):  ${report.confidenceBuckets.medium}`);
  lines.push(`  high   (>=0.70):      ${report.confidenceBuckets.high}`);
  lines.push(`  no-confidence:        ${report.confidenceBuckets.noConfidence}`);
  lines.push("");
  // ---- Provider call stats ----
  lines.push("--- provider call stats ---");
  lines.push(`  total calls (sum):           ${report.providerCallStats.totalCalls}`);
  lines.push(`  total scenarios:             ${report.providerCallStats.totalScenarios}`);
  lines.push(`  fallback used (final):       ${report.providerCallStats.fallbackUsedCount}`);
  lines.push(`  repair attempted:            ${report.providerCallStats.repairAttemptedCount}`);
  lines.push(`  fallback attempted:          ${report.providerCallStats.fallbackAttemptedCount}`);
  lines.push(`  adapter failures (ok=false): ${report.providerCallStats.adapterFailedCount}`);
  lines.push("");
  // ---- Safety / privacy gate ----
  lines.push("--- safety / privacy gate ---");
  lines.push(`  safety-critical count:  ${report.safetyPrivacyGate.safetyCriticalCount}`);
  lines.push(`  safety-critical passed: ${report.safetyPrivacyGate.safetyCriticalPassed}`);
  lines.push(`  gate passed:            ${report.safetyPrivacyGate.passed ? "yes" : "no"}`);
  if (report.safetyPrivacyGate.failedScenarioIds.length > 0) {
    lines.push(
      `  failed scenarios:       ${report.safetyPrivacyGate.failedScenarioIds.join(", ")}`
    );
  }
  lines.push("");
  // ---- READ THIS FIRST ----
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY probe of the");
  lines.push("  Memory Decision Engine shadow path. It runs a small,");
  lines.push("  deterministic scenario set through the real");
  lines.push("  `decideRememberPolicyWithFallback` adapter with a");
  lines.push("  scripted `fetch` override (no live network). It does");
  lines.push("  NOT activate decision actions: the adapter's success");
  lines.push("  result is recorded on the report but never mutates");
  lines.push("  persisted memory, public output, or the public MCP");
  lines.push("  tool schema. A pass on a scenario means 'the adapter");
  lines.push("  produces the expected structured decision under the");
  lines.push("  scripted provider behaviour', not 'the decision");
  lines.push("  engine generalises to production traffic'.");
  lines.push("");
  // ---- Per-scenario summary ----
  lines.push("--- per-scenario summary ---");
  lines.push(
    "  scenario                       category               cat-safety  ok    httpCalls  repair  fallback  action                  reason                       safety  pass"
  );
  for (const r of report.runs) {
    const label = r.scenarioId.length > 28 ? r.scenarioId.slice(0, 25) + "..." : r.scenarioId;
    const cat = r.category.length > 20 ? r.category.slice(0, 17) + "..." : r.category;
    const action = r.adapterOk ? (r.action ?? "-") : "-";
    const reason = r.adapterOk ? (r.reason ?? "-") : "-";
    lines.push(
      `  ${pad(label, 30)} ${pad(cat, 20)} ${pad(r.safetyCritical ? "yes" : "no", 9)} ${pad(
        r.adapterOk ? "yes" : "no",
        5
      )} ${pad(String(r.httpCalls), 9)} ${pad(r.repairAttempted ? "yes" : "no", 6)} ${pad(
        r.fallbackAttempted ? "yes" : "no",
        8
      )} ${pad(action, 23)} ${pad(reason, 28)} ${pad(r.safetyCritical ? "yes" : "no", 5)} ${r.pass ? "PASS" : "FAIL"}`
    );
  }
  lines.push("");
  // ---- Per-scenario details ----
  for (const r of report.runs) {
    lines.push(`--- scenario: ${r.scenarioId} (${r.label}) ---`);
    lines.push(`  description:    ${r.description}`);
    lines.push(`  category:       ${r.category}`);
    lines.push(`  safety-critical:${r.safetyCritical ? " yes" : " no"}`);
    lines.push(`  safetyClass:    ${r.safetyClass}`);
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
      lines.push(`    action:        ${r.action ?? "-"}`);
      lines.push(`    reason:        ${r.reason ?? "-"}`);
      lines.push(`    confidence:    ${r.confidence?.toFixed(2) ?? "-"}`);
      lines.push(`    supersededIds: [${(r.supersededIds ?? []).join(", ")}]`);
      lines.push(`    conflictsIds:  [${(r.conflictsWithIds ?? []).join(", ")}]`);
      lines.push(`    redundantIds:  [${(r.redundantWithIds ?? []).join(", ")}]`);
      lines.push(`    providerUsed:  ${r.providerUsed ?? "-"}`);
      lines.push(`    modelUsed:     ${r.modelUsed ?? "-"}`);
      lines.push(`    fallbackUsed:  ${r.fallbackUsed ? "yes" : "no"}`);
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
  // ---- Live-mode metadata (only when evaluationMode === "live") ----
  if (report.evaluationMode === "live" && report.live) {
    const live = report.live;
    lines.push("--- live-mode metadata (reviewer MUST read this first) ---");
    lines.push(`  opt-in env flag present:  ${live.optInEnvPresent}`);
    if (live.optInCliArgs.length > 0) {
      lines.push(`  opt-in CLI args:          ${live.optInCliArgs.join(" ")}`);
    } else {
      lines.push(`  opt-in CLI args:          (none — function API path)`);
    }
    const cfg = live.providerConfigSnapshot;
    lines.push("  provider config snapshot (no API keys recorded):");
    lines.push(
      `    primary:                baseUrl=${cfg.primaryBaseUrl} model=${cfg.primaryModel} apiFormat=${cfg.primaryApiFormat} label=${cfg.primaryProviderLabel || "(derived)"} keyPresent=${cfg.hasPrimaryApiKey}`
    );
    lines.push(
      `    fallback:               baseUrl=${cfg.fallbackBaseUrl || "(unset)"} model=${cfg.fallbackModel || "(unset)"} apiFormat=${cfg.fallbackApiFormat} label=${cfg.fallbackProviderLabel || "(derived)"} keyPresent=${cfg.hasFallbackApiKey}`
    );
    lines.push(`    timeoutMs=${cfg.timeoutMs}  maxTokens=${cfg.maxTokens}`);
    lines.push(`  total live HTTP calls:    ${live.liveCallCount}`);
    if (Object.keys(live.providerUsedCounts).length > 0) {
      lines.push("  provider used counts:");
      for (const [k, v] of Object.entries(live.providerUsedCounts)) {
        lines.push(`    - ${k}: ${v}`);
      }
    }
    if (Object.keys(live.modelUsedCounts).length > 0) {
      lines.push("  model used counts:");
      for (const [k, v] of Object.entries(live.modelUsedCounts)) {
        lines.push(`    - ${k}: ${v}`);
      }
    }
    lines.push("  warnings (live mode):");
    for (const w of live.warnings) {
      lines.push(`    - ${w}`);
    }
    lines.push("");
  }
  // ---- Limitations ----
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
export { jaccardBetween, capturedIdSet };
