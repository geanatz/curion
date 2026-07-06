/**
 * Metrics, report shape, and human formatter for the
 * long-horizon memory evaluation benchmark (v1).
 *
 * The shape is intentionally distinct from the existing
 * decision-policy / recall-policy / adaptive-depth
 * evaluation shapes. The long-horizon benchmark is a
 * SEPARATE study: it evaluates the production storage
 * lifecycle seams (`insertMemoryRecord`,
 * `transitionMemoryState`, `addSupersededByToMemory`,
 * `updateMemoryMetadata`, `listActiveMemorySummaries`,
 * `listMemoryTransitions`) under scripted multi-step
 * evolution, and produces a different summary (per-memory
 * state accuracy, current-truth recall correctness, stale-
 * memory exclusion correctness, conflict-preservation
 * correctness, audit-row count correctness).
 *
 * What the v1 report carries:
 *
 *   - `meta`: counts + the scenario-set version stamp.
 *
 *   - `categories`: per-category summary table (count,
 *     passed, failed, current-truth-critical and
 *     conflict-critical sub-counts).
 *
 *   - `lifecycleStateAccuracy`: aggregate state-accuracy
 *     over every tracked-memory final-state expectation.
 *     A perfect score is the contract: every tracked
 *     memory's final `state` matches the expected state
 *     after the multi-step evolution.
 *
 *   - `currentTruthAccuracy`: aggregate correctness of the
 *     final `finalExpectedCurrentIds` expectations. The
 *     score is the fraction of `current-truth-critical`
 *     scenarios whose final active-memory id set matches
 *     the expected set exactly.
 *
 *   - `staleExclusionAccuracy`: aggregate correctness of
 *     the final `finalExpectedStaleExcluded` expectations.
 *     The score is the fraction of `stale-exclusion-
 *     critical` scenarios whose final active-memory id
 *     set excludes every expected stale id.
 *
 *   - `conflictPreservationAccuracy`: aggregate correctness
 *     of the `conflictPreservedActive` expectations. The
 *     score is the fraction of `conflict-critical`
 *     scenarios where BOTH conflicting labels are still
 *     `active` at the end (i.e., the conflict pointer did
 *     NOT trigger an auto-invalidation).
 *
 *   - `auditAccuracy`: aggregate correctness of the
 *     `expectedTransitions` expectations. The score is the
 *     fraction of scenarios where the captured audit-row
 *     count equals the expected count.
 *
 *   - `gates`: structured overall-pass verdict. The
 *     `overallPassed` is the conjunction of every gate
 *     passed; a reviewer who wants the headline verdict
 *     reads `gates.overallPassed`.
 *
 *   - `runs`: one entry per scenario with the captured
 *     per-step data + per-expectation assertion rows.
 *
 *   - `limitations`: the research-only disclosure block.
 *
 * The metrics module is pure: same captured data →
 * same metrics. No I/O.
 */

import type { MemoryState } from "../../storage/storage.js";
import {
  LONG_HORIZON_SCENARIO_CATEGORIES,
  type LongHorizonCategory,
  type LongHorizonExpectations,
} from "./scenarios.js";

// ---------------------------------------------------------------------------
// Per-step captured data
// ---------------------------------------------------------------------------

/**
 * A single captured state snapshot (the harness captures
 * one per `recall` step in the scenario).
 *
 * The `activeMemoryIds` is the active-memory id set at
 * the time of the snapshot — this is the "current
 * truth at this step" the harness checks against the
 * snapshot's `expectedCurrentIds`.
 *
 * The `transitionsSoFar` is the audit-row count up to
 * the snapshot — the harness surfaces this on the
 * per-snapshot detail so a reviewer can audit "how many
 * transitions happened by step X?" without re-reading
 * the audit table.
 */
export interface LongHorizonCapturedSnapshot {
  /** Snapshot label from the scenario's `recall` step. */
  snapshotLabel: string;
  /** Active-memory id set at the time of the snapshot. */
  activeMemoryIds: ReadonlyArray<number>;
  /** Audit-row count up to the snapshot. */
  transitionsSoFar: number;
}

/**
 * A single captured per-memory final state. The harness
 * captures this for every tracked memory the scenario
 * inserts (via `insert` / `supersede.newLabel`) and
 * asserts the captured state matches the
 * `LongHorizonExpectations.finalStates` expectation.
 */
export interface LongHorizonCapturedFinalState {
  /** Memory label (matches the scenario's tracking label). */
  label: string;
  /** Memory id (assigned by `insertMemoryRecord`). */
  id: number;
  /** Memory content. */
  memoryContent: string;
  /** Captured final `state` from the storage row. */
  state: MemoryState;
  /**
   * Captured `metadata.relationship` block (parsed). The
   * shape mirrors the production
   * `listActiveMemoryRelationshipBlocks` projection
   * (which projects the safe-empty defaults for missing
   * keys). For superseded / invalidated rows the harness
   * reads the block directly from the DB.
   */
  relationship: {
    supersedes: number[];
    supersededBy: number[];
    olderVariantsOf: number[];
    conflictsWith: number[];
    detectionConfidence: number;
    resolvedAt: number;
  };
  /**
   * Captured audit history for this memory (chronological).
   * The harness populates this from `listMemoryTransitions`
   * regardless of state (the audit history is preserved
   * even after the memory transitions to superseded /
   * invalidated).
   */
  auditHistory: ReadonlyArray<{
    id: number;
    fromState: MemoryState;
    toState: MemoryState;
    reason: string;
    triggeringMemoryId: number | null;
    confidence: number | null;
    actor: string;
  }>;
}

// ---------------------------------------------------------------------------
// Per-scenario captured data
// ---------------------------------------------------------------------------

/**
 * A single expectation the harness checked against the
 * captured final state. One row per expectation field
 * that was set on the scenario.
 */
export interface LongHorizonAssertionRow {
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
   *   - `"lifecycle-state"` — final state of a tracked memory.
   *     Counted against `lifecycleStateGate`.
   *   - `"current-truth"` — the active-memory id set at the
   *     final state matches the expected current truth.
   *     Counted against `currentTruthGate`.
   *   - `"stale-exclusion"` — superseded / invalidated
   *     memories are excluded from the final active-memory
   *     id set. Counted against `staleExclusionGate`.
   *   - `"conflict-preservation"` — conflicting memories
   *     remain `active` after a conflict pointer is added.
   *     Counted against `conflictPreservationGate`.
   *   - `"audit"` — audit-row count matches expectation.
   *     Counted against `auditGate`.
   */
  group:
    | "lifecycle-state"
    | "current-truth"
    | "stale-exclusion"
    | "conflict-preservation"
    | "audit";
}

/**
 * The captured data the harness records for a single
 * scenario. The report surfaces this verbatim so a
 * reviewer can audit what the storage layer actually
 * saw and what it actually returned after the scripted
 * multi-step evolution.
 *
 * The `pass` boolean is the conjunction of EVERY
 * assertion's pass. A scenario that fails any single
 * assertion fails the entire scenario.
 */
export interface LongHorizonScenarioRunResult {
  /** Which scenario produced this run. */
  scenarioId: string;
  /** Human-readable label. */
  label: string;
  /** Short description of the scenario. */
  description: string;
  /** The per-scenario category. */
  category: LongHorizonCategory;
  /** Number of steps the scenario executed. */
  stepCount: number;

  /**
   * Per-tracked-memory captured final state. The harness
   * captures one entry per memory the scenario tracked
   * (every label the scenario referenced in an
   * `insert` / `supersede` step). The order is the
   * declaration order of the tracked labels.
   */
  capturedFinalStates: ReadonlyArray<LongHorizonCapturedFinalState>;
  /**
   * Per-recall-step captured snapshot. The harness
   * captures one entry per `recall` step the scenario
   * executed. The order is the declaration order of the
   * scenario's `recall` steps.
   */
  capturedSnapshots: ReadonlyArray<LongHorizonCapturedSnapshot>;
  /** Total audit-row count at the end of the scenario. */
  finalTransitions: number;

  /**
   * Per-expectation assertion rows the harness checked.
   * One row per expectation field the scenario set
   * (finalStates, expectedTransitions,
   * finalExpectedCurrentIds, finalExpectedStaleExcluded,
   * conflictPreservedActive).
   */
  assertions: ReadonlyArray<LongHorizonAssertionRow>;

  /** True iff every assertion passed. */
  pass: boolean;
  /** True iff every `group === "lifecycle-state"` assertion passed. */
  lifecycleStatePass: boolean;
  /** True iff every `group === "current-truth"` assertion passed. */
  currentTruthPass: boolean;
  /** True iff every `group === "stale-exclusion"` assertion passed. */
  staleExclusionPass: boolean;
  /** True iff every `group === "conflict-preservation"` assertion passed. */
  conflictPreservationPass: boolean;
  /** True iff every `group === "audit"` assertion passed. */
  auditPass: boolean;

  /** Whether this scenario contributes to the `currentTruthGate` block. */
  currentTruthCritical: boolean;
  /** Whether this scenario contributes to the `staleExclusionGate` block. */
  staleExclusionCritical: boolean;
  /** Whether this scenario contributes to the `conflictPreservationGate` block. */
  conflictCritical: boolean;
}

// ---------------------------------------------------------------------------
// Aggregate metric blocks
// ---------------------------------------------------------------------------

/**
 * Per-category summary row. The report carries one row
 * per category in `LONG_HORIZON_SCENARIO_CATEGORIES`.
 */
export interface LongHorizonCategorySummary {
  category: LongHorizonCategory;
  totalScenarios: number;
  passed: number;
  failed: number;
  currentTruthCriticalTotal: number;
  currentTruthCriticalPassed: number;
  conflictCriticalTotal: number;
  conflictCriticalPassed: number;
}

/**
 * Per-aggregate-metric summary. Each row is the unit
 * the headline metrics table surfaces.
 */
export interface LongHorizonAggregateMetric {
  /** Metric name (e.g. "lifecycleStateAccuracy"). */
  name: string;
  /** Number of scenarios (or per-memory checks) the metric covers. */
  total: number;
  /** Number that passed the metric. */
  passed: number;
  /**
   * `passed / total`. `null` when `total === 0` (no
   * scenarios exercise the metric; the metric is
   * reported for forward-compatibility).
   */
  accuracy: number | null;
}

// ---------------------------------------------------------------------------
// Gate blocks
// ---------------------------------------------------------------------------

/**
 * Lifecycle-state gate block. The gate passes iff
 * every tracked memory's final state matches the
 * expectation. The gate is the headline signal the
 * brief asks for: the storage lifecycle layer must
 * preserve the correct final state after multi-step
 * evolution.
 */
export interface LongHorizonLifecycleStateGate {
  totalMemoryChecks: number;
  passedMemoryChecks: number;
  failedMemoryChecks: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Current-truth recall gate block. The gate passes
 * iff every `currentTruthCritical` scenario's final
 * active-memory id set matches the expected current
 * truth. The gate is the second headline signal: a
 * recall that asks "what is the current truth?"
 * must return the current truth, never a stale
 * record.
 */
export interface LongHorizonCurrentTruthGate {
  currentTruthCriticalCount: number;
  currentTruthCriticalPassed: number;
  currentTruthCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Stale-memory exclusion gate block. The gate passes
 * iff every `staleExclusionCritical` scenario's final
 * active-memory id set excludes every expected stale
 * id. The gate is the third headline signal: a
 * superseded / invalidated memory must NOT appear in
 * active recall.
 */
export interface LongHorizonStaleExclusionGate {
  staleExclusionCriticalCount: number;
  staleExclusionCriticalPassed: number;
  staleExclusionCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Conflict-preservation gate block. The gate passes
 * iff every `conflictCritical` scenario's two
 * conflicting labels are still `active` at the end
 * of the scenario. The gate is the fourth headline
 * signal: a conflict pointer is a soft relationship,
 * NOT an auto-invalidation.
 */
export interface LongHorizonConflictPreservationGate {
  conflictCriticalCount: number;
  conflictCriticalPassed: number;
  conflictCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Audit gate block. The gate passes iff every
 * scenario's audit-row count matches the expected
 * count. The gate is the fifth headline signal: the
 * audit history must accurately reflect the multi-
 * step lifecycle evolution.
 */
export interface LongHorizonAuditGate {
  auditCriticalCount: number;
  auditCriticalPassed: number;
  auditCriticalFailed: number;
  passed: boolean;
  failedScenarioIds: ReadonlyArray<string>;
}

/**
 * Overall-gates block. Surfaces the headline pass /
 * fail verdicts the brief asks for, plus the failed-
 * scenario ids.
 *
 * `overallPassed` is the conjunction of every gate
 * passed: lifecycle-state AND current-truth AND
 * stale-exclusion AND conflict-preservation AND
 * audit. A scenario that fails any single gate fails
 * the overall verdict.
 */
export interface LongHorizonGates {
  lifecycleStatePassed: boolean;
  currentTruthPassed: boolean;
  staleExclusionPassed: boolean;
  conflictPreservationPassed: boolean;
  auditPassed: boolean;
  allScenariosPassed: boolean;
  overallPassed: boolean;
  lifecycleStateFailedScenarioIds: ReadonlyArray<string>;
  currentTruthFailedScenarioIds: ReadonlyArray<string>;
  staleExclusionFailedScenarioIds: ReadonlyArray<string>;
  conflictPreservationFailedScenarioIds: ReadonlyArray<string>;
  auditFailedScenarioIds: ReadonlyArray<string>;
  allFailedScenarioIds: ReadonlyArray<string>;
  summary: string;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level evaluation report (v1). The JSON
 * artifact is one of these. Same convention as the
 * decision-policy / recall-policy evaluations: the
 * artifact is machine-readable; the human formatter
 * in `formatLongHorizonMemoryEvaluationReport`
 * produces the human text.
 */
export interface LongHorizonMemoryEvaluationReport {
  /** ISO timestamp the report was generated at. */
  generatedAt: string;
  /**
   * Scenario-set version stamp ("v1"). The harness
   * surfaces this verbatim on every artifact so a
   * reviewer can read "this artifact was produced
   * under v1" without re-deriving the count.
   */
  scenarioSetVersion: string;
  /** Evaluation mode label (always `"scripted"` for v1). */
  evaluationMode: "scripted";
  /** Metadata block. */
  meta: {
    /** Number of scenarios run. */
    scenarioCount: number;
    /** Number of scenarios that passed all assertions. */
    passedCount: number;
    /** Number of scenarios that failed at least one assertion. */
    failedCount: number;
    /** Number of per-tracked-memory final-state checks run. */
    lifecycleStateCheckCount: number;
    /** Number of per-tracked-memory final-state checks passed. */
    lifecycleStateCheckPassed: number;
    /** Number of scenarios with `currentTruthCritical: true`. */
    currentTruthCriticalCount: number;
    /** Number of current-truth-critical scenarios that passed. */
    currentTruthCriticalPassed: number;
    /** Number of scenarios with `staleExclusionCritical: true`. */
    staleExclusionCriticalCount: number;
    /** Number of stale-exclusion-critical scenarios that passed. */
    staleExclusionCriticalPassed: number;
    /** Number of scenarios with `conflictCritical: true`. */
    conflictCriticalCount: number;
    /** Number of conflict-critical scenarios that passed. */
    conflictCriticalPassed: number;
    /** Number of scenarios with an `expectedTransitions` expectation. */
    auditCriticalCount: number;
    /** Number of audit-critical scenarios that passed. */
    auditCriticalPassed: number;
    /** Total `memory_transitions` rows written across all scenarios. */
    totalAuditRows: number;
  };
  /** Per-category summary, one row per `LONG_HORIZON_SCENARIO_CATEGORIES` slot. */
  categories: ReadonlyArray<LongHorizonCategorySummary>;
  /** Per-aggregate-metric summary, headline block. */
  aggregateMetrics: ReadonlyArray<LongHorizonAggregateMetric>;
  /** Lifecycle-state gate block. */
  lifecycleStateGate: LongHorizonLifecycleStateGate;
  /** Current-truth recall gate block. */
  currentTruthGate: LongHorizonCurrentTruthGate;
  /** Stale-memory exclusion gate block. */
  staleExclusionGate: LongHorizonStaleExclusionGate;
  /** Conflict-preservation gate block. */
  conflictPreservationGate: LongHorizonConflictPreservationGate;
  /** Audit gate block. */
  auditGate: LongHorizonAuditGate;
  /** Overall-gates block. */
  gates: LongHorizonGates;
  /** Per-scenario captured data, in scenario declaration order. */
  runs: ReadonlyArray<LongHorizonScenarioRunResult>;
  /** Limitations block (research-only disclosure). */
  limitations: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the symmetric set difference between two id
 * arrays: the union of items present in one set but not
 * the other. The helper is the unit the "got X, expected
 * Y" notes use to surface exact mismatch ids.
 */
export function idSetDiff(
  expected: ReadonlyArray<number>,
  actual: ReadonlyArray<number>
): { missingFromActual: number[]; unexpectedInActual: number[] } {
  const expSet = new Set(expected);
  const actSet = new Set(actual);
  const missingFromActual: number[] = [];
  for (const e of expSet) {
    if (!actSet.has(e)) missingFromActual.push(e);
  }
  const unexpectedInActual: number[] = [];
  for (const a of actSet) {
    if (!expSet.has(a)) unexpectedInActual.push(a);
  }
  missingFromActual.sort((x, y) => x - y);
  unexpectedInActual.sort((x, y) => x - y);
  return { missingFromActual, unexpectedInActual };
}

/**
 * Compute the set-equality of two id arrays. Returns
 * `true` iff both sets contain exactly the same ids
 * (order-independent).
 */
export function idSetsEqual(
  expected: ReadonlyArray<number>,
  actual: ReadonlyArray<number>
): boolean {
  if (expected.length !== actual.length) return false;
  const a = [...expected].sort((x, y) => x - y);
  const b = [...actual].sort((x, y) => x - y);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compute the Jaccard index (= IoU) between two id sets.
 * Returns 0 when both inputs are empty (an under-defined
 * case; the harness treats this as "no expectation set").
 */
export function jaccardBetweenIdSets(
  expected: ReadonlyArray<number>,
  actual: ReadonlyArray<number>
): number {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size === 0 && actualSet.size === 0) return 1;
  if (expectedSet.size === 0 || actualSet.size === 0) return 0;
  let intersection = 0;
  for (const e of expectedSet) {
    if (actualSet.has(e)) intersection += 1;
  }
  const union = expectedSet.size + actualSet.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ---------------------------------------------------------------------------
// Metrics builder
// ---------------------------------------------------------------------------

/**
 * Build the v1 metrics block from a list of per-scenario
 * run results. Pure: same input → same output. The
 * per-category summary covers every category slot, with
 * zero counts when the slot was not exercised.
 */
export function buildLongHorizonMemoryEvaluationMetrics(
  runs: ReadonlyArray<LongHorizonScenarioRunResult>
): Omit<LongHorizonMemoryEvaluationReport, "generatedAt" | "evaluationMode" | "limitations"> {
  let passedCount = 0;
  let failedCount = 0;
  let lifecycleStateCheckCount = 0;
  let lifecycleStateCheckPassed = 0;
  let currentTruthCriticalCount = 0;
  let currentTruthCriticalPassed = 0;
  let staleExclusionCriticalCount = 0;
  let staleExclusionCriticalPassed = 0;
  let conflictCriticalCount = 0;
  let conflictCriticalPassed = 0;
  let auditCriticalCount = 0;
  let auditCriticalPassed = 0;
  let totalAuditRows = 0;

  const lifecycleStateFailedScenarioIds = new Set<string>();
  const currentTruthFailedScenarioIds = new Set<string>();
  const staleExclusionFailedScenarioIds = new Set<string>();
  const conflictPreservationFailedScenarioIds = new Set<string>();
  const auditFailedScenarioIds = new Set<string>();

  for (const run of runs) {
    if (run.pass) passedCount += 1;
    else failedCount += 1;

    // Lifecycle-state checks (per-tracked-memory).
    const lifecycleStateAssertions = run.assertions.filter((a) => a.group === "lifecycle-state");
    lifecycleStateCheckCount += lifecycleStateAssertions.length;
    const lifecycleStatePassedHere = lifecycleStateAssertions.filter((a) => a.pass).length;
    lifecycleStateCheckPassed += lifecycleStatePassedHere;
    if (
      lifecycleStateAssertions.length > 0 &&
      lifecycleStatePassedHere !== lifecycleStateAssertions.length
    ) {
      lifecycleStateFailedScenarioIds.add(run.scenarioId);
    }

    // Current-truth.
    const currentTruthAssertions = run.assertions.filter((a) => a.group === "current-truth");
    if (currentTruthAssertions.length > 0) {
      currentTruthCriticalCount += 1;
      if (run.currentTruthPass) currentTruthCriticalPassed += 1;
      else currentTruthFailedScenarioIds.add(run.scenarioId);
    }

    // Stale-exclusion.
    const staleExclusionAssertions = run.assertions.filter((a) => a.group === "stale-exclusion");
    if (staleExclusionAssertions.length > 0) {
      staleExclusionCriticalCount += 1;
      if (run.staleExclusionPass) staleExclusionCriticalPassed += 1;
      else staleExclusionFailedScenarioIds.add(run.scenarioId);
    }

    // Conflict-preservation.
    const conflictAssertions = run.assertions.filter((a) => a.group === "conflict-preservation");
    if (conflictAssertions.length > 0) {
      conflictCriticalCount += 1;
      if (run.conflictPreservationPass) conflictCriticalPassed += 1;
      else conflictPreservationFailedScenarioIds.add(run.scenarioId);
    }

    // Audit-row count.
    const auditAssertions = run.assertions.filter((a) => a.group === "audit");
    if (auditAssertions.length > 0) {
      auditCriticalCount += 1;
      if (run.auditPass) auditCriticalPassed += 1;
      else auditFailedScenarioIds.add(run.scenarioId);
    }

    totalAuditRows += run.finalTransitions;
  }

  // Per-category summary.
  const categories: LongHorizonCategorySummary[] = LONG_HORIZON_SCENARIO_CATEGORIES.map((cat) => {
    const catRuns = runs.filter((r) => r.category === cat);
    const total = catRuns.length;
    const passed = catRuns.filter((r) => r.pass).length;
    const failed = total - passed;
    const ctCrit = catRuns.filter((r) => r.currentTruthCritical);
    const conflictCrit = catRuns.filter((r) => r.conflictCritical);
    return {
      category: cat,
      totalScenarios: total,
      passed,
      failed,
      currentTruthCriticalTotal: ctCrit.length,
      currentTruthCriticalPassed: ctCrit.filter((r) => r.pass).length,
      conflictCriticalTotal: conflictCrit.length,
      conflictCriticalPassed: conflictCrit.filter((r) => r.pass).length,
    };
  });

  const aggregateMetrics: LongHorizonAggregateMetric[] = [
    {
      name: "lifecycleStateAccuracy",
      total: lifecycleStateCheckCount,
      passed: lifecycleStateCheckPassed,
      accuracy:
        lifecycleStateCheckCount > 0 ? lifecycleStateCheckPassed / lifecycleStateCheckCount : null,
    },
    {
      name: "currentTruthAccuracy",
      total: currentTruthCriticalCount,
      passed: currentTruthCriticalPassed,
      accuracy:
        currentTruthCriticalCount > 0
          ? currentTruthCriticalPassed / currentTruthCriticalCount
          : null,
    },
    {
      name: "staleExclusionAccuracy",
      total: staleExclusionCriticalCount,
      passed: staleExclusionCriticalPassed,
      accuracy:
        staleExclusionCriticalCount > 0
          ? staleExclusionCriticalPassed / staleExclusionCriticalCount
          : null,
    },
    {
      name: "conflictPreservationAccuracy",
      total: conflictCriticalCount,
      passed: conflictCriticalPassed,
      accuracy: conflictCriticalCount > 0 ? conflictCriticalPassed / conflictCriticalCount : null,
    },
    {
      name: "auditAccuracy",
      total: auditCriticalCount,
      passed: auditCriticalPassed,
      accuracy: auditCriticalCount > 0 ? auditCriticalPassed / auditCriticalCount : null,
    },
  ];

  const lifecycleStateGate: LongHorizonLifecycleStateGate = {
    totalMemoryChecks: lifecycleStateCheckCount,
    passedMemoryChecks: lifecycleStateCheckPassed,
    failedMemoryChecks: lifecycleStateCheckCount - lifecycleStateCheckPassed,
    passed: lifecycleStateCheckCount - lifecycleStateCheckPassed === 0,
    failedScenarioIds: [...lifecycleStateFailedScenarioIds],
  };

  const currentTruthGate: LongHorizonCurrentTruthGate = {
    currentTruthCriticalCount,
    currentTruthCriticalPassed,
    currentTruthCriticalFailed: currentTruthCriticalCount - currentTruthCriticalPassed,
    passed: currentTruthCriticalCount - currentTruthCriticalPassed === 0,
    failedScenarioIds: [...currentTruthFailedScenarioIds],
  };

  const staleExclusionGate: LongHorizonStaleExclusionGate = {
    staleExclusionCriticalCount,
    staleExclusionCriticalPassed,
    staleExclusionCriticalFailed: staleExclusionCriticalCount - staleExclusionCriticalPassed,
    passed: staleExclusionCriticalCount - staleExclusionCriticalPassed === 0,
    failedScenarioIds: [...staleExclusionFailedScenarioIds],
  };

  const conflictPreservationGate: LongHorizonConflictPreservationGate = {
    conflictCriticalCount,
    conflictCriticalPassed,
    conflictCriticalFailed: conflictCriticalCount - conflictCriticalPassed,
    passed: conflictCriticalCount - conflictCriticalPassed === 0,
    failedScenarioIds: [...conflictPreservationFailedScenarioIds],
  };

  const auditGate: LongHorizonAuditGate = {
    auditCriticalCount,
    auditCriticalPassed,
    auditCriticalFailed: auditCriticalCount - auditCriticalPassed,
    passed: auditCriticalCount - auditCriticalPassed === 0,
    failedScenarioIds: [...auditFailedScenarioIds],
  };

  const allFailedIds = runs.filter((r) => !r.pass).map((r) => r.scenarioId);
  const allScenariosPassed = allFailedIds.length === 0;
  const overallPassed =
    lifecycleStateGate.passed &&
    currentTruthGate.passed &&
    staleExclusionGate.passed &&
    conflictPreservationGate.passed &&
    auditGate.passed;
  const gates: LongHorizonGates = {
    lifecycleStatePassed: lifecycleStateGate.passed,
    currentTruthPassed: currentTruthGate.passed,
    staleExclusionPassed: staleExclusionGate.passed,
    conflictPreservationPassed: conflictPreservationGate.passed,
    auditPassed: auditGate.passed,
    allScenariosPassed,
    overallPassed,
    lifecycleStateFailedScenarioIds: [...lifecycleStateFailedScenarioIds],
    currentTruthFailedScenarioIds: [...currentTruthFailedScenarioIds],
    staleExclusionFailedScenarioIds: [...staleExclusionFailedScenarioIds],
    conflictPreservationFailedScenarioIds: [...conflictPreservationFailedScenarioIds],
    auditFailedScenarioIds: [...auditFailedScenarioIds],
    allFailedScenarioIds: allFailedIds,
    summary: [
      `lifecycle-state gate:        ${lifecycleStateGate.passed ? "PASS" : "FAIL"} (${lifecycleStateCheckPassed}/${lifecycleStateCheckCount} per-memory state checks passed)`,
      `current-truth gate:          ${currentTruthGate.passed ? "PASS" : "FAIL"} (${currentTruthCriticalPassed}/${currentTruthCriticalCount} current-truth-critical scenarios passed)`,
      `stale-exclusion gate:        ${staleExclusionGate.passed ? "PASS" : "FAIL"} (${staleExclusionCriticalPassed}/${staleExclusionCriticalCount} stale-exclusion-critical scenarios passed)`,
      `conflict-preservation gate:  ${conflictPreservationGate.passed ? "PASS" : "FAIL"} (${conflictCriticalPassed}/${conflictCriticalCount} conflict-critical scenarios passed)`,
      `audit gate:                  ${auditGate.passed ? "PASS" : "FAIL"} (${auditCriticalPassed}/${auditCriticalCount} audit-critical scenarios passed)`,
      `all-scenarios gate:          ${allScenariosPassed ? "PASS" : "FAIL"} (${runs.length - allFailedIds.length}/${runs.length} scenarios passed)`,
      `overall:                     ${overallPassed ? "PASS" : "FAIL"} (lifecycle-state AND current-truth AND stale-exclusion AND conflict-preservation AND audit)`,
    ].join("; "),
  };

  return {
    scenarioSetVersion: "v1",
    meta: {
      scenarioCount: runs.length,
      passedCount,
      failedCount,
      lifecycleStateCheckCount,
      lifecycleStateCheckPassed,
      currentTruthCriticalCount,
      currentTruthCriticalPassed,
      staleExclusionCriticalCount,
      staleExclusionCriticalPassed,
      conflictCriticalCount,
      conflictCriticalPassed,
      auditCriticalCount,
      auditCriticalPassed,
      totalAuditRows,
    },
    categories,
    aggregateMetrics,
    lifecycleStateGate,
    currentTruthGate,
    staleExclusionGate,
    conflictPreservationGate,
    auditGate,
    gates,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Human report formatter
// ---------------------------------------------------------------------------

/**
 * Format the evaluation report as a human-readable string.
 * Pure: same report → same string. Mirrors the layout of
 * the recall-policy / decision-policy human reports
 * (`meta` → `gates` → per-category summary → per-aggregate
 * metric → per-scenario details → limitations) and adapts
 * the labels to the long-horizon vocabulary.
 */
export function formatLongHorizonMemoryEvaluationReport(
  report: LongHorizonMemoryEvaluationReport
): string {
  const lines: string[] = [];
  lines.push("=== curion long-horizon memory evaluation ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push(`scenario set version: ${report.scenarioSetVersion}`);
  lines.push(`evaluation mode:   scripted (no-network, temp storage)`);
  lines.push("");
  lines.push("--- meta ---");
  lines.push(`  scenarios:                            ${report.meta.scenarioCount}`);
  lines.push(`  passed (all assertions):              ${report.meta.passedCount}`);
  lines.push(`  failed (>=1 assertion):               ${report.meta.failedCount}`);
  lines.push(`  lifecycle-state checks (total):       ${report.meta.lifecycleStateCheckCount}`);
  lines.push(`  lifecycle-state checks (passed):      ${report.meta.lifecycleStateCheckPassed}`);
  lines.push(`  current-truth-critical scenarios:     ${report.meta.currentTruthCriticalCount}`);
  lines.push(`  current-truth-critical passed:        ${report.meta.currentTruthCriticalPassed}`);
  lines.push(`  stale-exclusion-critical scenarios:   ${report.meta.staleExclusionCriticalCount}`);
  lines.push(`  stale-exclusion-critical passed:      ${report.meta.staleExclusionCriticalPassed}`);
  lines.push(`  conflict-critical scenarios:          ${report.meta.conflictCriticalCount}`);
  lines.push(`  conflict-critical passed:             ${report.meta.conflictCriticalPassed}`);
  lines.push(`  audit-critical scenarios:             ${report.meta.auditCriticalCount}`);
  lines.push(`  audit-critical passed:                ${report.meta.auditCriticalPassed}`);
  lines.push(`  total audit rows written:             ${report.meta.totalAuditRows}`);
  lines.push("");
  lines.push("--- gates ---");
  lines.push(`  lifecycle-state:        ${report.gates.lifecycleStatePassed ? "PASS" : "FAIL"}`);
  lines.push(`  current-truth:          ${report.gates.currentTruthPassed ? "PASS" : "FAIL"}`);
  lines.push(`  stale-exclusion:        ${report.gates.staleExclusionPassed ? "PASS" : "FAIL"}`);
  lines.push(
    `  conflict-preservation:  ${report.gates.conflictPreservationPassed ? "PASS" : "FAIL"}`
  );
  lines.push(`  audit:                  ${report.gates.auditPassed ? "PASS" : "FAIL"}`);
  lines.push(`  all-scenarios:          ${report.gates.allScenariosPassed ? "PASS" : "FAIL"}`);
  lines.push(`  overall:                ${report.gates.overallPassed ? "PASS" : "FAIL"}`);
  if (report.gates.allFailedScenarioIds.length > 0) {
    lines.push(`  failed scenarios: ${report.gates.allFailedScenarioIds.join(", ")}`);
  }
  lines.push(`  summary: ${report.gates.summary}`);
  lines.push("");
  lines.push("--- categories ---");
  lines.push(
    "  category                       total  passed  failed  current-truth(p/total)  conflict(p/total)"
  );
  for (const c of report.categories) {
    lines.push(
      `  ${pad(c.category, 32)} ${pad(String(c.totalScenarios), 5)} ${pad(
        String(c.passed),
        6
      )} ${pad(String(c.failed), 6)} ${pad(
        `${c.currentTruthCriticalPassed}/${c.currentTruthCriticalTotal}`,
        22
      )} ${pad(`${c.conflictCriticalPassed}/${c.conflictCriticalTotal}`, 18)}`
    );
  }
  lines.push("");
  lines.push("--- aggregate metrics ---");
  lines.push("  metric                       total  passed  accuracy");
  for (const m of report.aggregateMetrics) {
    lines.push(
      `  ${pad(m.name, 30)} ${pad(String(m.total), 5)} ${pad(String(m.passed), 6)} ${
        m.accuracy === null ? "-" : m.accuracy.toFixed(2)
      }`
    );
  }
  lines.push("");
  lines.push("--- lifecycle-state gate ---");
  lines.push(`  total memory checks:    ${report.lifecycleStateGate.totalMemoryChecks}`);
  lines.push(`  passed memory checks:   ${report.lifecycleStateGate.passedMemoryChecks}`);
  lines.push(`  gate passed:            ${report.lifecycleStateGate.passed ? "yes" : "no"}`);
  if (report.lifecycleStateGate.failedScenarioIds.length > 0) {
    lines.push(
      `  failed scenarios:       ${report.lifecycleStateGate.failedScenarioIds.join(", ")}`
    );
  }
  lines.push("");
  lines.push("--- current-truth gate ---");
  lines.push(
    `  current-truth-critical count:   ${report.currentTruthGate.currentTruthCriticalCount}`
  );
  lines.push(
    `  current-truth-critical passed:  ${report.currentTruthGate.currentTruthCriticalPassed}`
  );
  lines.push(`  gate passed:                    ${report.currentTruthGate.passed ? "yes" : "no"}`);
  if (report.currentTruthGate.failedScenarioIds.length > 0) {
    lines.push(
      `  failed scenarios:               ${report.currentTruthGate.failedScenarioIds.join(", ")}`
    );
  }
  lines.push("");
  lines.push("--- stale-exclusion gate ---");
  lines.push(
    `  stale-exclusion-critical count:  ${report.staleExclusionGate.staleExclusionCriticalCount}`
  );
  lines.push(
    `  stale-exclusion-critical passed: ${report.staleExclusionGate.staleExclusionCriticalPassed}`
  );
  lines.push(
    `  gate passed:                     ${report.staleExclusionGate.passed ? "yes" : "no"}`
  );
  if (report.staleExclusionGate.failedScenarioIds.length > 0) {
    lines.push(
      `  failed scenarios:                ${report.staleExclusionGate.failedScenarioIds.join(", ")}`
    );
  }
  lines.push("");
  lines.push("--- conflict-preservation gate ---");
  lines.push(
    `  conflict-critical count:  ${report.conflictPreservationGate.conflictCriticalCount}`
  );
  lines.push(
    `  conflict-critical passed: ${report.conflictPreservationGate.conflictCriticalPassed}`
  );
  lines.push(
    `  gate passed:              ${report.conflictPreservationGate.passed ? "yes" : "no"}`
  );
  if (report.conflictPreservationGate.failedScenarioIds.length > 0) {
    lines.push(
      `  failed scenarios:         ${report.conflictPreservationGate.failedScenarioIds.join(", ")}`
    );
  }
  lines.push("");
  lines.push("--- audit gate ---");
  lines.push(`  audit-critical count:   ${report.auditGate.auditCriticalCount}`);
  lines.push(`  audit-critical passed:  ${report.auditGate.auditCriticalPassed}`);
  lines.push(`  gate passed:            ${report.auditGate.passed ? "yes" : "no"}`);
  if (report.auditGate.failedScenarioIds.length > 0) {
    lines.push(`  failed scenarios:       ${report.auditGate.failedScenarioIds.join(", ")}`);
  }
  lines.push("");
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY scripted probe of the");
  lines.push("  storage lifecycle layer. It runs a curated multi-step scenario");
  lines.push("  set against a fresh temp storage handle (no production DB");
  lines.push("  touched, no network made) and evaluates the captured state");
  lines.push("  against typed expectations. A pass on a scenario means 'the");
  lines.push("  storage lifecycle seams preserve the correct final state and");
  lines.push("  the correct current truth after the scripted multi-step");
  lines.push("  evolution under the v1 scenario set', not 'the lifecycle");
  lines.push("  layer generalises to production traffic'.");
  lines.push("");
  lines.push("--- per-scenario summary ---");
  lines.push(
    "  scenario                       category                  steps  audit  lifSt  curTr  stale  confl  pass"
  );
  for (const r of report.runs) {
    const label = r.scenarioId.length > 30 ? r.scenarioId.slice(0, 27) + "..." : r.scenarioId;
    const cat = r.category.length > 24 ? r.category.slice(0, 21) + "..." : r.category;
    lines.push(
      `  ${pad(label, 32)} ${pad(cat, 26)} ${pad(String(r.stepCount), 5)} ${pad(
        String(r.finalTransitions),
        5
      )} ${pad(r.lifecycleStatePass ? "yes" : "no", 5)} ${pad(
        r.currentTruthPass ? "yes" : "no",
        5
      )} ${pad(r.staleExclusionPass ? "yes" : "no", 5)} ${pad(
        r.conflictPreservationPass ? "yes" : "no",
        5
      )} ${r.pass ? "PASS" : "FAIL"}`
    );
  }
  lines.push("");
  for (const r of report.runs) {
    lines.push(`--- scenario: ${r.scenarioId} (${r.label}) ---`);
    lines.push(`  description:    ${r.description}`);
    lines.push(`  category:       ${r.category}`);
    lines.push(`  stepCount:      ${r.stepCount}`);
    lines.push(`  finalTransitions: ${r.finalTransitions}`);
    lines.push(`  pass:           ${r.pass ? "PASS" : "FAIL"}`);
    lines.push(`  per-gate pass:`);
    lines.push(`    lifecycle-state:       ${r.lifecycleStatePass ? "PASS" : "FAIL"}`);
    lines.push(`    current-truth:         ${r.currentTruthPass ? "PASS" : "FAIL"}`);
    lines.push(`    stale-exclusion:       ${r.staleExclusionPass ? "PASS" : "FAIL"}`);
    lines.push(`    conflict-preservation: ${r.conflictPreservationPass ? "PASS" : "FAIL"}`);
    lines.push(`    audit:                 ${r.auditPass ? "PASS" : "FAIL"}`);
    lines.push(`  captured final states:`);
    for (const fs of r.capturedFinalStates) {
      lines.push(
        `    - label='${fs.label}' id=${fs.id} state=${fs.state} content="${short(fs.memoryContent)}"`
      );
      lines.push(
        `      relationship: supersedes=[${fs.relationship.supersedes.join(",")}] supersededBy=[${fs.relationship.supersededBy.join(",")}] olderVariantsOf=[${fs.relationship.olderVariantsOf.join(",")}] conflictsWith=[${fs.relationship.conflictsWith.join(",")}]`
      );
      if (fs.auditHistory.length > 0) {
        lines.push(`      audit history (${fs.auditHistory.length} rows):`);
        for (const a of fs.auditHistory) {
          lines.push(
            `        - audit#${a.id} ${a.fromState} -> ${a.toState} reason='${a.reason}' triggeringMemoryId=${a.triggeringMemoryId} confidence=${a.confidence} actor='${a.actor}'`
          );
        }
      }
    }
    if (r.capturedSnapshots.length > 0) {
      lines.push(`  captured recall snapshots:`);
      for (const snap of r.capturedSnapshots) {
        lines.push(
          `    - snapshot='${snap.snapshotLabel}' activeIds=[${snap.activeMemoryIds.join(",")}] transitionsSoFar=${snap.transitionsSoFar}`
        );
      }
    }
    lines.push(`  assertions: ${r.pass ? "PASS" : "FAIL"}`);
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

function short(s: string, max = 60): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Re-export the scenario-set version + categories so a
 * downstream test can `import { LONG_HORIZON_SCENARIO_SET_VERSION,
 * LONG_HORIZON_SCENARIO_CATEGORIES }` from this module
 * without a second import. The constants are the
 * canonical stable identifier + canonical category set
 * the harness iterates against.
 */
export {
  LONG_HORIZON_SCENARIO_SET_VERSION,
  LONG_HORIZON_SCENARIO_CATEGORIES,
} from "./scenarios.js";
export type { LongHorizonScenario, LongHorizonStep, LongHorizonExpectations } from "./scenarios.js";

// Re-export the LongHorizonExpectations type alias as the
// narrow per-expectation contract the report surfaces
// (used by the metrics builder's per-run assertions). The
// alias is a documentation aid; the underlying shape lives
// in `./scenarios.js`.
export type LongHorizonExpectationsBlock = LongHorizonExpectations;
