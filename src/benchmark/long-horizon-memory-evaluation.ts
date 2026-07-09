/**
 * Benchmark-only long-horizon memory evaluation harness (v1).
 *
 * Background
 * ----------
 * Phase 3 ships the supersession lifecycle wiring (the
 * remember controller drives an `active → superseded`
 * transition for each old memory whose supersession
 * detector fires). Phase 1+2 shipped the audit-backed
 * `transitionMemoryState` seam. The recall controller
 * continues to filter on `state = 'active'`, so a
 * superseded / invalidated memory is hidden from active
 * recall but preserved on disk.
 *
 * Purpose
 * -------
 * This module is a small, deterministic, no-network
 * benchmark harness that drives the production storage
 * lifecycle seams (`insertMemoryRecord`,
 * `transitionMemoryState`, `addSupersededByToMemory`,
 * `updateMemoryMetadata`, `listActiveMemorySummaries`,
 * `listMemoryTransitions`) against a fresh temp storage
 * handle for each scenario, captures the per-step state,
 * and evaluates the scenario's `expectations` block
 * against the captured state.
 *
 * v1 contract
 * -----------
 * The v1 scenario set (8 scenarios) covers the brief's
 * required multi-step lifecycle axes:
 *
 *   - supersession chain (3-step)
 *   - invalidation / retraction
 *   - conflict preserved active (not auto-invalidated)
 *   - redundancy linked (soft pointer, not invalidated)
 *   - recall current truth after multiple updates
 *   - false premise about a stale memory
 *   - multi-topic / project-like separation
 *   - invalidate-after-supersede
 *
 * The harness is benchmark-only / research-only. It:
 *
 *   - Does NOT touch production storage (every scenario
 *     runs against a fresh temp `initStorage` handle in
 *     `os.tmpdir()`; the harness closes the DB and removes
 *     the temp dir at the end).
 *   - Does NOT call any provider, any network endpoint,
 *     or any external service.
 *   - Does NOT mutate the public MCP `remember` or
 *     `recall` tool behavior.
 *   - Does NOT touch the production `recall(text)`
 *     controller, the production controller behavior, or
 *     the recall ranking layer.
 *   - Does NOT mutate the public `structuredContent`
 *     shape, the public tool input schema, or any
 *     wire-format field.
 *
 * What the harness does
 * ---------------------
 *   - Runs the full scenario set in-process.
 *   - Captures per-step storage state (id assignments,
 *     relationship pointers, audit history).
 *   - Evaluates each scenario's `expectations` block
 *     against the captured state.
 *   - Builds the v1 metrics + gates report.
 *   - Writes a JSON artifact under
 *     `.curion/benchmark/long-horizon-memory-evaluation-*.json`
 *     (configurable per-runner via `--artifacts`).
 *
 * What the harness does NOT do
 * ----------------------------
 *   - It does NOT make any network call. The harness
 *     runs the storage lifecycle seams against a temp DB;
 *     no fetch, no provider, no LLM call.
 *   - It does NOT touch production storage.
 *   - It does NOT modify the public MCP API, the public
 *     MCP tool schema, or the public `structuredContent`
 *     shape.
 *   - It does NOT activate any production decision
 *     engine, recall controller, or supersession
 *     controller beyond the audit-backed storage seams
 *     the scenarios explicitly drive.
 *
 * Scope (benchmark-only / research-only):
 *   The harness is read-mostly. It writes to a TEMP
 *   storage handle, runs the scripted operations,
 *   captures the result, and emits a JSON artifact
 *   under `.curion/benchmark/`. It does NOT modify
 *   the production `recall(text)` behavior, the public
 *   MCP API, or the existing dev-set / audit /
 *   calibration / policy / held-out / adaptive-depth /
 *   decision-policy-evaluation / recall-policy-
 *   evaluation report shapes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type MemoryState,
  type StorageHandle,
  addSupersededByToMemory,
  closeStorage,
  initStorage,
  insertMemoryRecord,
  listActiveMemorySummaries,
  listMemoryTransitions,
  transitionMemoryState,
  updateMemoryMetadata,
} from "../storage/storage.js";
import { writeTimestampedJsonArtifact } from "./_artifact.js";
import {
  type LongHorizonAssertionRow,
  type LongHorizonCapturedFinalState,
  type LongHorizonCapturedSnapshot,
  type LongHorizonMemoryEvaluationReport,
  type LongHorizonScenarioRunResult,
  buildLongHorizonMemoryEvaluationMetrics,
  idSetDiff,
  idSetsEqual,
} from "./long-horizon/metrics.js";
import {
  BUILT_IN_LONG_HORIZON_SCENARIOS,
  LONG_HORIZON_SCENARIO_SET_VERSION,
  type LongHorizonInsertStep,
  type LongHorizonLinkConflictStep,
  type LongHorizonLinkRedundantStep,
  type LongHorizonRecallStep,
  type LongHorizonScenario,
  type LongHorizonStep,
  type LongHorizonSupersedeStep,
} from "./long-horizon/scenarios.js";

// ---------------------------------------------------------------------------
// Limitations
// ---------------------------------------------------------------------------

/**
 * The evaluation's limitations / research-only block.
 * The block is surfaced on the artifact
 * (`report.limitations`) and on the human report.
 */
export const LONG_HORIZON_EVALUATION_LIMITATIONS: ReadonlyArray<string> = [
  `Synthetic-scenario evaluation (v1 scenario set, ${BUILT_IN_LONG_HORIZON_SCENARIOS.length} scenarios). The scenarios are hand-curated and exercise the production storage lifecycle seams (insertMemoryRecord, transitionMemoryState, addSupersededByToMemory, updateMemoryMetadata, listActiveMemorySummaries, listMemoryTransitions) under scripted multi-step evolution. A reviewer who reads a scenario-pass rate as 'the storage lifecycle layer generalises to production traffic' is over-reading the result. The right reading is 'the storage lifecycle seams preserve the correct final state and the correct current truth after the scripted multi-step evolution under the v1 scenario set'.`,
  "No-network. The harness never makes a real provider call. The storage lifecycle seams run against a fresh temp storage handle; no fetch, no provider, no LLM call.",
  "Temp-storage isolated. Each scenario creates a fresh storage handle in `os.tmpdir()` via `mkdtempSync` + `initStorage`. The harness closes the DB and removes the temp dir at the end of every scenario. Production `.curion/curion.sqlite` is NEVER touched.",
  "Production-API unchanged. The harness exercises the internal storage seams directly, NOT through the public `remember(text)` or `recall(text)` controller. The public MCP API, the public tool input schemas, and the public `structuredContent` shapes are unchanged. Exactly two tools (`remember`, `recall`) remain on the wire.",
  "Controller-driven lifecycle is out of scope. The harness drives the storage lifecycle seams DIRECTLY. The production `remember(text)` controller's supersession-driven state transitions are NOT exercised; the recall controller's behavior is unchanged and is covered by the recall-mvp controller test surface. The benchmark is a storage-lifecycle probe, not a controller probe.",
  "Scenario expectations are expectations on the storage layer's captured state, NOT on user-visible behavior. A scenario pass means 'the storage lifecycle seams preserved the correct final state and the correct current truth under the scripted multi-step evolution'. The harness does not assert user-visible messages, structured content shapes, or controller output.",
  `Frozen scenario set (version ${LONG_HORIZON_SCENARIO_SET_VERSION}). The v1 scenario set is the canonical reference set; a future v2 that adds new categories, axes, or replaces existing scenarios is a deliberate, visible change. The harness never re-tunes the scenario expectations on the evaluation results.`,
  "Memory-content payloads are safe. Every scenario's `memoryContent` is a short, safe English sentence (no secrets, no raw input fields, no PII). The harness never reads raw input — it only writes the controller-normalized `memoryContent` field the controller seam accepts.",
  "Audit history is the source of truth for state transitions. The harness asserts both the captured `state` column AND the audit history for every tracked memory. A scenario that fails the state check OR the audit-row count fails the lifecycle-state gate OR the audit gate, respectively.",
  "Conflict pointer is a soft relationship, not an auto-invalidation. The harness surfaces a separate `conflictPreservationGate` block that asserts every conflict-pointer scenario's two labels remain ACTIVE after the pointer is added. A scenario that fails this check indicates the conflict pointer accidentally triggered an auto-invalidation; the storage contract is that a `conflictsWith` pointer NEVER triggers a state transition.",
  "Redundancy pointer is a soft relationship, not a state transition. The `redundancy-linked-not-invalidated` scenario asserts that an `olderVariantsOf` pointer is preserved on the captured relationship block while both memories remain ACTIVE.",
  "Scenario inputs are evaluated against the captured state, not the expected state. A scenario that fails a `finalStates` expectation surfaces the captured state and the expected state on the report's per-scenario `assertions` block so a reviewer can audit 'what did the storage layer actually produce?'",
];

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

/**
 * Run a single scenario end-to-end against a fresh temp
 * storage handle. The function:
 *   1. Creates a temp dir + storage handle.
 *   2. Iterates the scenario's `steps` array in order.
 *   3. Captures per-step state (id assignments, snapshots,
 *      final-state readings).
 *   4. Evaluates the scenario's `expectations` block
 *      against the captured state.
 *   5. Closes the DB and removes the temp dir.
 *
 * The function never throws on expected failure paths:
 *   - An unknown label reference fails the expectation
 *     and surfaces as a failed assertion row.
 *   - A disallowed state transition throws inside the
 *     storage seam; the harness catches it and surfaces
 *     it as a failed assertion row (so the harness
 *     continues to run the remaining scenarios).
 *
 * The function does NOT throw on storage failures that
 * are expected to fail (e.g. a disallowed transition);
 * those are surfaced as failed assertions. The function
 * DOES throw on unexpected harness bugs (e.g. an unknown
 * step kind, which is a programming error).
 */
async function runSingleScenario(
  scenario: LongHorizonScenario
): Promise<LongHorizonScenarioRunResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-long-horizon-eval-"));
  const handle = initStorage({ projectRoot: tmp });
  try {
    return await runScenarioOnHandle(scenario, handle, tmp);
  } finally {
    try {
      closeStorage(handle);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Internal helper: run the scenario on a pre-constructed
 * storage handle. The function is the pure lifecycle
 * driver; the wrapping `runSingleScenario` handles temp
 * dir + close + cleanup.
 */
async function runScenarioOnHandle(
  scenario: LongHorizonScenario,
  handle: StorageHandle,
  tmp: string
): Promise<LongHorizonScenarioRunResult> {
  const labelToId = new Map<string, number>();
  const capturedFinalStates: LongHorizonCapturedFinalState[] = [];
  const capturedSnapshots: LongHorizonCapturedSnapshot[] = [];
  const stepCount = scenario.steps.length;
  let lastStepError: string | null = null;

  // Run each step in order. Track which labels we've
  // observed via insert / supersede so the final-state
  // capture knows which memories to read at the end.
  const trackedLabels: string[] = [];
  for (const step of scenario.steps) {
    try {
      executeStep(step, scenario, labelToId, trackedLabels, handle, capturedSnapshots);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastStepError = `step '${stepLabel(step)}' threw: ${msg}`;
      // Capture what we have so far; the harness will
      // surface the error in the run's assertions.
      break;
    }
  }

  // Capture the final state for every tracked memory.
  for (const label of trackedLabels) {
    const id = labelToId.get(label);
    if (id === undefined) continue;
    capturedFinalStates.push(captureFinalState(handle, id, label));
  }

  // Build assertions. The harness always evaluates every
  // expectation field the scenario set; a step-level
  // error surfaces as a failed assertion row so the
  // per-scenario pass/fail reflects the failure clearly.
  const assertions = evaluateExpectations({
    scenario,
    handle,
    labelToId,
    capturedFinalStates,
    capturedSnapshots,
    lastStepError,
  });

  const lifecycleStatePass = assertions
    .filter((a) => a.group === "lifecycle-state")
    .every((a) => a.pass);
  const currentTruthPass = assertions
    .filter((a) => a.group === "current-truth")
    .every((a) => a.pass);
  const staleExclusionPass = assertions
    .filter((a) => a.group === "stale-exclusion")
    .every((a) => a.pass);
  const conflictPreservationPass = assertions
    .filter((a) => a.group === "conflict-preservation")
    .every((a) => a.pass);
  const auditPass = assertions.filter((a) => a.group === "audit").every((a) => a.pass);
  const pass = assertions.every((a) => a.pass);

  const expectations = scenario.expectations;
  const currentTruthCritical =
    expectations.currentTruthCritical ?? expectations.finalExpectedCurrentLabels !== undefined;
  const staleExclusionCritical =
    expectations.staleExclusionCritical ??
    expectations.finalExpectedStaleExcludedLabels !== undefined;
  const conflictCritical =
    expectations.conflictCritical ?? expectations.conflictPreservedActive !== undefined;

  return {
    scenarioId: scenario.id,
    label: scenario.label,
    description: scenario.description,
    category: scenario.category,
    stepCount,
    capturedFinalStates,
    capturedSnapshots,
    finalTransitions: countAllTransitions(handle),
    assertions,
    pass,
    lifecycleStatePass,
    currentTruthPass,
    staleExclusionPass,
    conflictPreservationPass,
    auditPass,
    currentTruthCritical,
    staleExclusionCritical,
    conflictCritical,
  };
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/**
 * Execute a single scenario step against the storage
 * handle. The function mutates the `labelToId` map and
 * appends to `capturedSnapshots` as a side effect.
 *
 * The function never throws on expected-storage
 * failures (e.g. unknown label, disallowed transition);
 * those throw into the runner and are surfaced as failed
 * assertions. The function throws on harness bugs (e.g.
 * an unknown step kind).
 */
function executeStep(
  step: LongHorizonStep,
  scenario: LongHorizonScenario,
  labelToId: Map<string, number>,
  trackedLabels: string[],
  handle: StorageHandle,
  capturedSnapshots: LongHorizonCapturedSnapshot[]
): void {
  switch (step.kind) {
    case "insert":
      executeInsert(step, {
        labelToId,
        trackedLabels,
        handle,
      });
      return;
    case "supersede":
      executeSupersede(step, {
        labelToId,
        trackedLabels,
        handle,
      });
      return;
    case "invalidate":
      executeInvalidate(step.label, step.reason, step.confidence, {
        labelToId,
        handle,
      });
      return;
    case "reactivate":
      executeReactivate(step.label, step.reason, {
        labelToId,
        handle,
      });
      return;
    case "link-redundant":
      executeLinkRedundant(step, { labelToId, handle });
      return;
    case "link-conflict":
      executeLinkConflict(step, { labelToId, handle });
      return;
    case "recall":
      executeRecall(step, handle, capturedSnapshots);
      return;
    default: {
      // Discriminated-union exhaustiveness guard.
      const _exhaustive: never = step;
      throw new Error(
        `executeStep: unknown step kind ${JSON.stringify(_exhaustive)} in scenario ${scenario.id}`
      );
    }
  }
}

/**
 * Insert a new memory row and capture the assigned id
 * under the given label. Seeds the row's `metadata`
 * with the (optional) initial relationship block the
 * scenario specified.
 */
function executeInsert(
  step: LongHorizonInsertStep,
  ctx: { labelToId: Map<string, number>; trackedLabels: string[]; handle: StorageHandle }
): void {
  const metadata: Record<string, unknown> = {};
  const relationship = step.relationship;
  if (relationship !== undefined) {
    const block: Record<string, unknown> = {
      derivedSchemaVersion: "ccm-draft-2",
      derivedAt: Date.now(),
      conflictsWith: relationship.conflictsWith ?? [],
      olderVariantsOf: relationship.olderVariantsOf ?? [],
      detectionConfidence: relationship.detectionConfidence ?? 0,
    };
    if (relationship.supersedes !== undefined && relationship.supersedes.length > 0) {
      block.supersedes = [...relationship.supersedes];
    }
    if (relationship.supersededBy !== undefined && relationship.supersededBy.length > 0) {
      block.supersededBy = [...relationship.supersededBy];
    }
    if (relationship.resolvedAt !== undefined) {
      block.resolvedAt = relationship.resolvedAt;
    }
    metadata.relationship = block;
  }
  const rec = insertMemoryRecord(ctx.handle, {
    kind: step.memoryKind ?? "fact",
    state: "active",
    memoryContent: step.memoryContent,
    providerId: null,
    modelId: null,
    confidence: null,
    metadata,
  });
  ctx.labelToId.set(step.label, rec.id);
  ctx.trackedLabels.push(step.label);
}

/**
 * Insert a NEW memory, then transition the OLD memory to
 * `superseded` (audit-backed) and write the
 * `supersedes` / `supersededBy` relationship pointers on
 * both rows. This mirrors the production controller's
 * supersession wiring step-for-step:
 *
 *   1. Insert the new memory (state=active).
 *   2. Update the new memory's `metadata.relationship`
 *      with `supersedes: [oldId]` (and the safe-empty
 *      defaults for the other fields).
 *   3. Back-patch the OLD memory's
 *      `metadata.relationship.supersededBy` via
 *      `addSupersededByToMemory` (the production storage
 *      seam; preserves any existing relationship block
 *      fields).
 *   4. Call `transitionMemoryState({ active → superseded,
 *      reason, triggeringMemoryId: newId, confidence,
 *      actor: "long-horizon-evaluation" })` on the OLD
 *      row.
 */
function executeSupersede(
  step: LongHorizonSupersedeStep,
  ctx: { labelToId: Map<string, number>; trackedLabels: string[]; handle: StorageHandle }
): void {
  const oldId = ctx.labelToId.get(step.oldLabel);
  if (oldId === undefined) {
    throw new Error(
      `executeSupersede: unknown oldLabel '${step.oldLabel}' (referenced in supersede step for newLabel='${step.newLabel}')`
    );
  }
  // 1. Insert the new memory.
  const newRec = insertMemoryRecord(ctx.handle, {
    kind: step.newMemoryKind ?? "fact",
    state: "active",
    memoryContent: step.newMemoryContent,
    providerId: null,
    modelId: null,
    confidence: null,
    metadata: {},
  });
  ctx.labelToId.set(step.newLabel, newRec.id);
  ctx.trackedLabels.push(step.newLabel);

  // 2. Update the new memory's `metadata.relationship`
  //    with `supersedes: [oldId]`.
  const newMetadata = mergeMetadataForUpdate(ctx.handle, newRec.id, {
    relationship: {
      derivedSchemaVersion: "ccm-draft-2",
      derivedAt: Date.now(),
      conflictsWith: [],
      olderVariantsOf: [],
      detectionConfidence: 0,
      supersedes: [oldId],
    },
  });
  updateMemoryMetadata(ctx.handle, newRec.id, newMetadata);

  // 3. Back-patch the OLD memory's
  //    `metadata.relationship.supersededBy` via the
  //    production storage seam.
  addSupersededByToMemory(ctx.handle, oldId, newRec.id);

  // 4. Transition the OLD row to `superseded` (audit-backed).
  transitionMemoryState(ctx.handle, {
    memoryId: oldId,
    toState: "superseded",
    reason: step.reason,
    triggeringMemoryId: newRec.id,
    confidence: step.confidence ?? null,
    actor: "long-horizon-evaluation",
    metadata: { source: "long-horizon-evaluation", supersededIds: [oldId] },
  });
}

/**
 * Transition an existing active memory to `invalidated`
 * via the audit-backed `transitionMemoryState` seam.
 */
function executeInvalidate(
  label: string,
  reason: string,
  confidence: number | undefined,
  ctx: { labelToId: Map<string, number>; handle: StorageHandle }
): void {
  const id = ctx.labelToId.get(label);
  if (id === undefined) {
    throw new Error(`executeInvalidate: unknown label '${label}'`);
  }
  transitionMemoryState(ctx.handle, {
    memoryId: id,
    toState: "invalidated",
    reason,
    triggeringMemoryId: null,
    confidence: confidence ?? null,
    actor: "long-horizon-evaluation",
    metadata: { source: "long-horizon-evaluation" },
  });
}

/**
 * Transition an existing superseded memory back to
 * `active` via the audit-backed `transitionMemoryState`
 * seam. The v1 scenario set does NOT exercise this step
 * (it is reserved for a future v2 rollback scenario);
 * it is declared here for completeness.
 */
function executeReactivate(
  label: string,
  reason: string,
  ctx: { labelToId: Map<string, number>; handle: StorageHandle }
): void {
  const id = ctx.labelToId.get(label);
  if (id === undefined) {
    throw new Error(`executeReactivate: unknown label '${label}'`);
  }
  transitionMemoryState(ctx.handle, {
    memoryId: id,
    toState: "active",
    reason,
    triggeringMemoryId: null,
    confidence: null,
    actor: "long-horizon-evaluation",
    metadata: { source: "long-horizon-evaluation" },
  });
}

/**
 * Add an `olderVariantsOf` pointer to the OLDER label's
 * `metadata.relationship` block, pointing at the
 * CANONICAL label's id. The harness uses
 * `mergeMetadataForUpdate` to preserve any existing
 * relationship block fields.
 */
function executeLinkRedundant(
  step: LongHorizonLinkRedundantStep,
  ctx: { labelToId: Map<string, number>; handle: StorageHandle }
): void {
  const olderId = ctx.labelToId.get(step.olderLabel);
  const canonicalId = ctx.labelToId.get(step.canonicalLabel);
  if (olderId === undefined) {
    throw new Error(`executeLinkRedundant: unknown olderLabel '${step.olderLabel}'`);
  }
  if (canonicalId === undefined) {
    throw new Error(`executeLinkRedundant: unknown canonicalLabel '${step.canonicalLabel}'`);
  }
  // The older label's `olderVariantsOf` now points at the
  // canonical label. We MERGE with the existing block to
  // preserve any prior relationship pointers (a row that
  // is both an older variant AND a superseded record, for
  // example, should keep its `supersededBy` pointer).
  const merged = mergeMetadataForUpdate(ctx.handle, olderId, {
    relationshipPatch: { olderVariantsOf: [canonicalId] },
  });
  updateMemoryMetadata(ctx.handle, olderId, merged);
}

/**
 * Add a `conflictsWith` pointer between two labels'
 * `metadata.relationship` blocks. When `bidirectional`
 * is true (default), the harness writes the pointer on
 * BOTH rows; when false, only `labelA`'s block is
 * updated. The harness uses `mergeMetadataForUpdate` to
 * preserve any existing relationship block fields on
 * each side.
 */
function executeLinkConflict(
  step: LongHorizonLinkConflictStep,
  ctx: { labelToId: Map<string, number>; handle: StorageHandle }
): void {
  const idA = ctx.labelToId.get(step.labelA);
  const idB = ctx.labelToId.get(step.labelB);
  if (idA === undefined) {
    throw new Error(`executeLinkConflict: unknown labelA '${step.labelA}'`);
  }
  if (idB === undefined) {
    throw new Error(`executeLinkConflict: unknown labelB '${step.labelB}'`);
  }
  const bidirectional = step.bidirectional ?? true;
  // A.conflictsWith += [B].
  const mergedA = mergeMetadataForUpdate(ctx.handle, idA, {
    relationshipPatch: { conflictsWith: [idB] },
  });
  updateMemoryMetadata(ctx.handle, idA, mergedA);
  if (bidirectional) {
    // B.conflictsWith += [A].
    const mergedB = mergeMetadataForUpdate(ctx.handle, idB, {
      relationshipPatch: { conflictsWith: [idA] },
    });
    updateMemoryMetadata(ctx.handle, idB, mergedB);
  }
}

/**
 * Capture the current state: call
 * `listActiveMemorySummaries` for the active-memory id
 * set and `listMemoryTransitions` (counting the rows
 * across all memories) for the audit-row count so far.
 */
function executeRecall(
  step: LongHorizonRecallStep,
  handle: StorageHandle,
  capturedSnapshots: LongHorizonCapturedSnapshot[]
): void {
  const activeSummaries = listActiveMemorySummaries(handle, { limit: 200 });
  const activeMemoryIds = activeSummaries.map((s) => s.id);
  const transitionsSoFar = countAllTransitions(handle);
  capturedSnapshots.push({
    snapshotLabel: step.snapshotLabel,
    activeMemoryIds,
    transitionsSoFar,
  });
  // The `expectedCurrentIds` / `expectedNotInActiveRecall`
  // checks fire in the assertion evaluator, not here.
  // We surface the captured snapshot verbatim on the
  // report so a reviewer can audit the harness's read.
  void step.expectedCurrentIds;
  void step.expectedNotInActiveRecall;
}

// ---------------------------------------------------------------------------
// Metadata merge helper
// ---------------------------------------------------------------------------

/**
 * Read the current metadata block for `id`, merge the
 * caller-supplied `relationship` patch into the existing
 * `metadata.relationship` block (preserving any other
 * keys the row carries), and return the new metadata
 * blob. The harness uses this for `supersede` /
 * `link-redundant` / `link-conflict` steps so it can call
 * `updateMemoryMetadata` (which overwrites the entire
 * `metadata` column) without losing prior fields.
 *
 * The merge semantics mirror the production
 * `buildPersistedMetadata` helper but operate on a
 * shallow merge of the top-level metadata (the harness
 * is benchmark-only and does not need the full
 * production merge contract).
 */
function mergeMetadataForUpdate(
  handle: StorageHandle,
  id: number,
  patch: { relationship: Record<string, unknown> } | { relationshipPatch: Record<string, unknown> }
): Record<string, unknown> {
  const row = handle.db.prepare("SELECT metadata FROM memories WHERE id = ?").get(id) as
    | { metadata: string | null }
    | undefined;
  let base: Record<string, unknown> = {};
  if (row && typeof row.metadata === "string" && row.metadata.length > 0) {
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Malformed metadata: treat as empty.
    }
  }
  if ("relationship" in patch) {
    // Replace the relationship block entirely (the
    // caller supplied the full block).
    base.relationship = { ...patch.relationship };
  } else {
    // Patch specific keys into the existing relationship
    // block (or create one if absent).
    const existingRel =
      base.relationship !== undefined &&
      typeof base.relationship === "object" &&
      !Array.isArray(base.relationship)
        ? { ...(base.relationship as Record<string, unknown>) }
        : {};
    for (const [k, v] of Object.entries(patch.relationshipPatch)) {
      // De-duplicate union for id lists; existing keys
      // win on `detectionConfidence` / `resolvedAt` /
      // `derivedSchemaVersion` / `derivedAt`.
      if (Array.isArray(v)) {
        const existingArr = Array.isArray(existingRel[k])
          ? (existingRel[k] as unknown[]).filter((x): x is number => typeof x === "number")
          : [];
        const seen = new Set<number>();
        const merged: number[] = [];
        for (const x of [...existingArr, ...v]) {
          if (!seen.has(x)) {
            seen.add(x);
            merged.push(x);
          }
        }
        existingRel[k] = merged;
      } else {
        existingRel[k] = v;
      }
    }
    base.relationship = existingRel;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Per-memory final-state capture
// ---------------------------------------------------------------------------

/**
 * Read the final state of a tracked memory by id. The
 * function reads the `state` column directly (since
 * `listActiveMemoryRelationshipBlocks` only returns
 * ACTIVE rows; superseded / invalidated rows must be
 * read via the `memories` table directly to read their
 * state and relationship block).
 */
function captureFinalState(
  handle: StorageHandle,
  id: number,
  label: string
): LongHorizonCapturedFinalState {
  const row = handle.db
    .prepare(
      `SELECT id, kind, state, summary, provider_id, model_id,
              confidence, metadata, created_at, updated_at
         FROM memories
        WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        kind: string;
        state: string;
        summary: string | null;
        metadata: string | null;
      }
    | undefined;
  if (!row) {
    throw new Error(`captureFinalState: no row found for id ${id} (label='${label}')`);
  }
  const state = MEMORY_STATES_FROM_COLUMN(row.state);
  const memoryContent = row.summary ?? "";
  let relationship: LongHorizonCapturedFinalState["relationship"] = {
    supersedes: [],
    supersededBy: [],
    olderVariantsOf: [],
    conflictsWith: [],
    detectionConfidence: 0,
    resolvedAt: 0,
  };
  if (typeof row.metadata === "string" && row.metadata.length > 0) {
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rel = (parsed as Record<string, unknown>).relationship;
        if (rel !== null && typeof rel === "object" && !Array.isArray(rel)) {
          const r = rel as Record<string, unknown>;
          relationship = {
            supersedes: normalizeIdArray(r.supersedes),
            supersededBy: normalizeIdArray(r.supersededBy),
            olderVariantsOf: normalizeIdArray(r.olderVariantsOf),
            conflictsWith: normalizeIdArray(r.conflictsWith),
            detectionConfidence:
              typeof r.detectionConfidence === "number" && Number.isFinite(r.detectionConfidence)
                ? r.detectionConfidence
                : 0,
            resolvedAt:
              typeof r.resolvedAt === "number" && Number.isFinite(r.resolvedAt) ? r.resolvedAt : 0,
          };
        }
      }
    } catch {
      // Malformed metadata: keep the safe-empty defaults.
    }
  }
  const auditRows = listMemoryTransitions(handle, id, { limit: 200 });
  const auditHistory = auditRows.map((a) => ({
    id: a.id,
    fromState: a.fromState,
    toState: a.toState,
    reason: a.reason,
    triggeringMemoryId: a.triggeringMemoryId,
    confidence: a.confidence,
    actor: a.actor,
  }));
  return {
    label,
    id,
    memoryContent,
    state,
    relationship,
    auditHistory,
  };
}

/**
 * Project the production `MEMORY_STATES` validator's
 * output onto a known-safe value (the harness treats
 * unknown states as `"active"` to match the production
 * reader's defensive default).
 */
function MEMORY_STATES_FROM_COLUMN(s: string): MemoryState {
  if (s === "active" || s === "superseded" || s === "invalidated") return s;
  return "active";
}

function normalizeIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x) || !Number.isInteger(x) || x <= 0) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * Count the total number of audit rows across all
 * memories. The harness uses this for the
 * `expectedTransitions` audit-count assertion.
 */
function countAllTransitions(handle: StorageHandle): number {
  const row = handle.db.prepare("SELECT COUNT(*) AS c FROM memory_transitions").get() as {
    c: number;
  };
  return row.c;
}

// ---------------------------------------------------------------------------
// Expectation evaluator
// ---------------------------------------------------------------------------

interface ExpectationCtx {
  scenario: LongHorizonScenario;
  handle: StorageHandle;
  labelToId: Map<string, number>;
  capturedFinalStates: LongHorizonCapturedFinalState[];
  capturedSnapshots: LongHorizonCapturedSnapshot[];
  lastStepError: string | null;
}

/**
 * Evaluate the scenario's `expectations` block against
 * the captured state. Returns the assertion rows the
 * metrics builder consumes. Each expectation field
 * produces 1+ assertion rows.
 *
 * If `lastStepError` is non-null (a step threw), the
 * harness surfaces a failed assertion row for every
 * expectation field that depends on the captured state.
 * The `pass` boolean on the run reflects the failed
 * assertions; a scenario with a thrown step fails the
 * lifecycle-state gate (the step error is the headline
 * signal a reviewer should look at).
 */
function evaluateExpectations(ctx: ExpectationCtx): LongHorizonAssertionRow[] {
  const rows: LongHorizonAssertionRow[] = [];
  const { scenario, labelToId, capturedFinalStates, capturedSnapshots, lastStepError } = ctx;
  const expectations = scenario.expectations;

  // If a step errored, surface it as the headline
  // assertion row so the per-scenario `pass` is `false`
  // and the human report surfaces the error.
  if (lastStepError !== null) {
    rows.push({
      name: "step-execution",
      description: "Every step in the scenario must execute without throwing",
      pass: false,
      note: lastStepError,
      group: "lifecycle-state",
    });
  }

  // 1. finalStates: per-tracked-memory final state.
  if (expectations.finalStates) {
    for (const expected of expectations.finalStates) {
      const captured = capturedFinalStates.find((c) => c.label === expected.label);
      if (captured === undefined) {
        rows.push({
          name: `final-state:${expected.label}`,
          description: `memory '${expected.label}' final state must be '${expected.expectedState}'`,
          pass: false,
          note: `memory '${expected.label}' was never tracked by the scenario (label-to-id map is empty for this label)`,
          group: "lifecycle-state",
        });
        continue;
      }
      const pass = captured.state === expected.expectedState;
      rows.push({
        name: `final-state:${expected.label}`,
        description: `memory '${expected.label}' final state must be '${expected.expectedState}'`,
        pass,
        note: pass
          ? `state='${captured.state}' matches expected`
          : `state='${captured.state}' but expected '${expected.expectedState}'`,
        group: "lifecycle-state",
      });
    }
  }

  // 2. expectedTransitions: total audit-row count.
  if (expectations.expectedTransitions !== undefined) {
    const actual = countAllTransitions(ctx.handle);
    const pass = actual === expectations.expectedTransitions;
    rows.push({
      name: "audit-row-count",
      description: `total memory_transitions rows must equal ${expectations.expectedTransitions}`,
      pass,
      note: pass
        ? `audit row count=${actual} matches expected`
        : `audit row count=${actual} but expected ${expectations.expectedTransitions}`,
      group: "audit",
    });
  }

  // 3. finalExpectedCurrentLabels: current-truth recall at the end.
  //    The expectation block stores LABELS (not raw ids); the
  //    harness resolves each label through `labelToId` to
  //    compare against the captured active-memory id set.
  if (expectations.finalExpectedCurrentLabels !== undefined) {
    const activeSummaries = listActiveMemorySummaries(ctx.handle, { limit: 200 });
    const actualIds = activeSummaries.map((s) => s.id);
    const expectedIds: number[] = [];
    const missingLabels: string[] = [];
    for (const label of expectations.finalExpectedCurrentLabels) {
      const id = labelToId.get(label);
      if (id === undefined) {
        missingLabels.push(label);
        continue;
      }
      expectedIds.push(id);
    }
    if (missingLabels.length > 0) {
      rows.push({
        name: "final-current-truth",
        description: `final active-memory id set (resolved from labels [${expectations.finalExpectedCurrentLabels.join(",")}]) must equal the captured set`,
        pass: false,
        note: `unknown label(s) in expectation: [${missingLabels.join(",")}] (these labels were never inserted by the scenario)`,
        group: "current-truth",
      });
    } else {
      const pass = idSetsEqual(expectedIds, actualIds);
      const diff = idSetDiff(expectedIds, actualIds);
      const note = pass
        ? `active-memory id set [${actualIds.join(",")}] (resolved from labels [${expectations.finalExpectedCurrentLabels.join(",")}]) matches expected`
        : `expected labels [${expectations.finalExpectedCurrentLabels.join(",")}] (resolved to ids [${expectedIds.join(",")}]), got [${actualIds.join(",")}]; missingFromActual=[${diff.missingFromActual.join(",")}], unexpectedInActual=[${diff.unexpectedInActual.join(",")}]`;
      rows.push({
        name: "final-current-truth",
        description: `final active-memory id set (resolved from labels [${expectations.finalExpectedCurrentLabels.join(",")}]) must equal the captured set`,
        pass,
        note,
        group: "current-truth",
      });
    }
  }

  // 4. finalExpectedStaleExcludedLabels: no superseded/invalidated memory in active recall.
  if (expectations.finalExpectedStaleExcludedLabels !== undefined) {
    const activeSummaries = listActiveMemorySummaries(ctx.handle, { limit: 200 });
    const actualIds = new Set(activeSummaries.map((s) => s.id));
    const leakedLabels: string[] = [];
    const missingLabels: string[] = [];
    for (const expectedLabel of expectations.finalExpectedStaleExcludedLabels) {
      const id = labelToId.get(expectedLabel);
      if (id === undefined) {
        missingLabels.push(expectedLabel);
        continue;
      }
      if (actualIds.has(id)) leakedLabels.push(expectedLabel);
    }
    const pass = leakedLabels.length === 0 && missingLabels.length === 0;
    rows.push({
      name: "final-stale-exclusion",
      description: `final active-memory id set must NOT include any label from [${expectations.finalExpectedStaleExcludedLabels.join(",")}]`,
      pass,
      note: pass
        ? `active-memory id set [${[...actualIds].sort((a, b) => a - b).join(",")}] excludes every stale label`
        : missingLabels.length > 0
          ? `unknown label(s) in expectation: [${missingLabels.join(",")}]`
          : `active-memory id set [${[...actualIds].sort((a, b) => a - b).join(",")}] leaked stale labels [${leakedLabels.join(",")}]`,
      group: "stale-exclusion",
    });
  }

  // 5. conflictPreservedActive: both conflicting labels remain ACTIVE.
  if (expectations.conflictPreservedActive) {
    const { labelA, labelB } = expectations.conflictPreservedActive;
    const stateA = capturedFinalStates.find((c) => c.label === labelA)?.state;
    const stateB = capturedFinalStates.find((c) => c.label === labelB)?.state;
    const pass = stateA === "active" && stateB === "active";
    rows.push({
      name: "conflict-preserved-active",
      description: `conflicting memories '${labelA}' and '${labelB}' must BOTH remain ACTIVE after a conflictsWith pointer is added`,
      pass,
      note: pass
        ? `state('${labelA}')='${stateA}', state('${labelB}')='${stateB}' — both ACTIVE`
        : `state('${labelA}')='${stateA ?? "<missing>"}', state('${labelB}')='${stateB ?? "<missing>"}'`,
      group: "conflict-preservation",
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Public entry point: run the full long-horizon memory
 * evaluation.
 *
 * The function is the canonical entry point for both
 * the CLI runner and the test suite. It is deterministic
 * for a fixed `scenarios` argument and never makes a
 * live network call. The function creates and tears
 * down a fresh temp storage handle for every scenario.
 *
 * The function runs scenarios in declaration order so
 * the report's `runs` array is byte-stable for a fixed
 * input.
 */
export async function runLongHorizonMemoryEvaluation(
  args: {
    scenarios?: ReadonlyArray<LongHorizonScenario>;
  } = {}
): Promise<LongHorizonMemoryEvaluationReport> {
  const scenarios = args.scenarios ?? BUILT_IN_LONG_HORIZON_SCENARIOS;
  const runs: LongHorizonScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    runs.push(await runSingleScenario(scenario));
  }
  const metrics = buildLongHorizonMemoryEvaluationMetrics(runs);
  return {
    generatedAt: new Date().toISOString(),
    scenarioSetVersion: metrics.scenarioSetVersion,
    evaluationMode: "scripted",
    meta: metrics.meta,
    categories: metrics.categories,
    aggregateMetrics: metrics.aggregateMetrics,
    lifecycleStateGate: metrics.lifecycleStateGate,
    currentTruthGate: metrics.currentTruthGate,
    staleExclusionGate: metrics.staleExclusionGate,
    conflictPreservationGate: metrics.conflictPreservationGate,
    auditGate: metrics.auditGate,
    gates: metrics.gates,
    runs: metrics.runs,
    limitations: LONG_HORIZON_EVALUATION_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "long-horizon-memory-evaluation";

/**
 * Write the evaluation report to disk. The file prefix
 * is `long-horizon-memory-evaluation-*.json` (distinct
 * from the existing audit / calibration / policy /
 * held-out / adaptive-depth / decision-policy-evaluation
 * / recall-policy-evaluation prefixes).
 */
export function writeLongHorizonMemoryEvaluationReport(
  report: LongHorizonMemoryEvaluationReport,
  dir: string
): string {
  return writeTimestampedJsonArtifact(report, dir, ARTIFACT_FILE_PREFIX);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  formatLongHorizonMemoryEvaluationReport,
  buildLongHorizonMemoryEvaluationMetrics,
  jaccardBetweenIdSets,
  idSetDiff,
  idSetsEqual,
} from "./long-horizon/metrics.js";
export type {
  LongHorizonMemoryEvaluationReport,
  LongHorizonScenarioRunResult,
  LongHorizonAssertionRow,
  LongHorizonCapturedSnapshot,
  LongHorizonCapturedFinalState,
  LongHorizonLifecycleStateGate,
  LongHorizonCurrentTruthGate,
  LongHorizonStaleExclusionGate,
  LongHorizonConflictPreservationGate,
  LongHorizonAuditGate,
  LongHorizonGates,
  LongHorizonCategorySummary,
  LongHorizonAggregateMetric,
} from "./long-horizon/metrics.js";
export {
  BUILT_IN_LONG_HORIZON_SCENARIOS,
  LONG_HORIZON_SCENARIO_CATEGORIES,
  LONG_HORIZON_SCENARIO_SET_VERSION,
} from "./long-horizon/scenarios.js";
export type {
  LongHorizonScenario,
  LongHorizonStep,
  LongHorizonExpectations,
  LongHorizonInsertStep,
  LongHorizonSupersedeStep,
  LongHorizonInvalidateStep,
  LongHorizonReactivateStep,
  LongHorizonLinkRedundantStep,
  LongHorizonLinkConflictStep,
  LongHorizonRecallStep,
  LongHorizonCategory,
} from "./long-horizon/scenarios.js";

// Helper used by the runner: render a short label for a
// step so a step-level error can identify which step
// threw. Exported for tests.
export function stepLabel(step: LongHorizonStep): string {
  switch (step.kind) {
    case "insert":
      return `insert('${step.label}')`;
    case "supersede":
      return `supersede(new='${step.newLabel}', old='${step.oldLabel}')`;
    case "invalidate":
      return `invalidate('${step.label}')`;
    case "reactivate":
      return `reactivate('${step.label}')`;
    case "link-redundant":
      return `link-redundant(older='${step.olderLabel}', canonical='${step.canonicalLabel}')`;
    case "link-conflict":
      return `link-conflict(A='${step.labelA}', B='${step.labelB}')`;
    case "recall":
      return `recall('${step.snapshotLabel}')`;
    default: {
      const _exhaustive: never = step;
      return `unknown(${JSON.stringify(_exhaustive)})`;
    }
  }
}
