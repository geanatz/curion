/**
 * Curated scenario set for the long-horizon memory
 * evaluation benchmark (v1).
 *
 * Each scenario is a small, deterministic, **multi-step**
 * lifecycle story. The harness drives the script end-to-end
 * against a fresh temp `initStorage` handle (NO production
 * DB is touched, NO network is made), captures the
 * per-step state, and evaluates a typed `expectations`
 * block against the captured state.
 *
 * Why this is a separate scenario set from the existing
 * recall-policy / decision-policy / supersession-edge /
 * multi-anchor sets:
 *
 *   Those benchmarks test a SINGLE decision / retrieval
 *   outcome under controlled inputs. The long-horizon
 *   benchmark is different: it drives a multi-step
 *   lifecycle evolution (insert → supersede → supersede →
 *   … → recall) and evaluates whether the storage layer
 *   and the audit history preserve the correct FINAL
 *   STATE and the correct CURRENT TRUTH recall after a
 *   sequence of lifecycle operations.
 *
 *   The benchmark does NOT exercise the production
 *   `recall(text)` controller (the controller is out of
 *   scope for lifecycle correctness — the controller's
 *   recall behavior is unchanged by Phase 3 lifecycle
 *   wiring, and the recall controller test surface
 *   covers that contract). The benchmark uses the
 *   production `insertMemoryRecord`,
 *   `transitionMemoryState`, `addSupersededByToMemory`,
 *   `updateMemoryMetadata`, `listActiveMemorySummaries`,
 *   and `listMemoryTransitions` storage seams against a
 *   fresh temp DB. A scenario is a scripted multi-step
 *   driver of these seams; the captured data is the
 *   per-step storage state.
 *
 * Scenario family distribution (v1, 8 scenarios):
 *
 *   A. Supersession chain (2):
 *      1.  supersession-chain             : A → B → C
 *                                           (3-step chain), recall C
 *                                           at the end.
 *      2.  recall-current-after-updates   : same shape as 1 but
 *                                           with the explicit
 *                                           "recall returns the
 *                                           current truth" check
 *                                           phrased as a multi-
 *                                           update lifecycle.
 *
 *   B. Invalidation / retraction (2):
 *      3.  invalidation-retraction        : insert A active →
 *                                           invalidate A → recall
 *                                           is empty.
 *      4.  invalidate-after-supersede     : A → supersede to B →
 *                                           invalidate B → recall
 *                                           is empty (covers the
 *                                           "both paths can hide a
 *                                           memory" contract).
 *
 *   C. Conflict preservation (1):
 *      5.  conflict-preserved-active      : insert A and B both
 *                                           active → link-conflict
 *                                           both ways → recall
 *                                           includes BOTH (conflict
 *                                           is preserved active,
 *                                           NOT auto-invalidated).
 *
 *   D. Redundancy / demotion (1):
 *      6.  redundancy-linked-not-invalidated : insert A and A'
 *                                           (paraphrase) both
 *                                           active → link A as
 *                                           older variant of A' →
 *                                           recall still includes
 *                                           both (the redundancy
 *                                           pointer is a soft
 *                                           relationship, NOT a
 *                                           state transition).
 *
 *   E. False premise (1):
 *      7.  false-premise-about-stale      : insert A → supersede
 *                                           to B → recall about A
 *                                           returns B (the current
 *                                           truth), NOT A.
 *
 *   F. Multi-topic / project-like separation (1):
 *      8.  multi-topic-current-truth      : two parallel update
 *                                           chains in different
 *                                           domains; recall returns
 *                                           both current truths,
 *                                           neither stale record.
 *
 * Why these scenarios are scripted and not derived from a
 * real conversation:
 *
 *   The long-horizon benchmark is a CORRECTNESS probe of
 *   the storage lifecycle seams under a controlled
 *   sequence of operations. A real conversation would
 *   introduce uncontrolled inputs (provider variance,
 *   classification noise, recall ranking variability);
 *   the benchmark needs to assert "the storage layer
 *   behaves correctly under sequence X" deterministically.
 *   A future v2 that adds provider-driven scenario
 *   generation is a deliberate, visible change.
 *
 * Frozen-set contract:
 *
 *   The v1 scenario set is the canonical reference set;
 *   a future v2 that adds new categories, axes, or
 *   replaces existing scenarios is a deliberate, visible
 *   change. The harness never re-tunes the scenario
 *   expectations on the evaluation results. A scenario
 *   that fails under scripted execution indicates a real
 *   lifecycle defect, not a scenario bug; the harness
 *   surfaces the failure on the report's
 *   `gates.lifecycleStateGate` block.
 *
 * Scope (benchmark-only):
 *
 *   The benchmark is read-mostly: it writes to a TEMP
 *   storage handle (`os.tmpdir()`), runs the scripted
 *   operations, captures the result, and emits a JSON
 *   artifact under `.curion/benchmark/` (configurable
 *   per-runner via `--artifacts`). The temp DB is
 *   closed and removed by the harness; production
 *   `.curion/curion.sqlite` is NEVER touched.
 */

import type { MemoryKind } from "../../storage/storage.js";

// ---------------------------------------------------------------------------
// Scenario set version
// ---------------------------------------------------------------------------

/**
 * Stable version stamp for the curated scenario set. Bumped
 * by hand when the set grows or contracts. The harness
 * surfaces this on every report so a reviewer can read
 * "this artifact was produced under v1" without
 * re-deriving the count.
 */
export const LONG_HORIZON_SCENARIO_SET_VERSION = "v1" as const;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Top-level category the v1 set assigns to every scenario.
 * The harness aggregates per-category pass / fail counts
 * and drives the lifecycle-state / current-truth / stale-
 * exclusion / conflict-preservation gates off the
 * `current-truth-critical` / `conflict-critical` /
 * `lifecycle-critical` slices (a reviewer's reading: the
 * storage lifecycle layer must preserve the current truth
 * after multi-step evolution, must hide stale memories
 * from active recall, and must preserve conflicting
 * memories as ACTIVE — never auto-invalidating them).
 *
 * The eight categories mirror the brief's required
 * lifecycle axes:
 *   - `supersession-chain`         — chained `active →
 *                                    superseded → superseded`
 *                                    evolution with recall of
 *                                    the chain winner.
 *   - `invalidation-retraction`    — single-step
 *                                    `active → invalidated`
 *                                    evolution with recall
 *                                    excluding the row.
 *   - `conflict-preserved`         — both memories remain
 *                                    ACTIVE after a conflict
 *                                    pointer is added (the
 *                                    pointer is a soft
 *                                    relationship, not a
 *                                    state transition).
 *   - `redundancy-linked`          — `olderVariantsOf`
 *                                    pointer is added; both
 *                                    memories remain ACTIVE.
 *   - `current-truth-recall`       — multi-update evolution
 *                                    followed by a recall
 *                                    that must return the
 *                                    current truth (and only
 *                                    the current truth).
 *   - `false-premise-stale`        — recall about a
 *                                    superseded memory
 *                                    returns the CURRENT
 *                                    truth, not the stale
 *                                    record.
 *   - `multi-topic-separation`     — two parallel lifecycle
 *                                    chains in different
 *                                    domains; recall returns
 *                                    both current truths.
 *   - `invalidate-after-supersede` — supersede then
 *                                    invalidate the new
 *                                    row; recall is empty.
 */
export type LongHorizonCategory =
  | "supersession-chain"
  | "invalidation-retraction"
  | "conflict-preserved"
  | "redundancy-linked"
  | "current-truth-recall"
  | "false-premise-stale"
  | "multi-topic-separation"
  | "invalidate-after-supersede";

/**
 * Per-category constants. Exported so callers (formatter,
 * tests, downstream tooling) can iterate over the canonical
 * category set without re-listing the labels.
 */
export const LONG_HORIZON_SCENARIO_CATEGORIES = [
  "supersession-chain",
  "invalidation-retraction",
  "conflict-preserved",
  "redundancy-linked",
  "current-truth-recall",
  "false-premise-stale",
  "multi-topic-separation",
  "invalidate-after-supersede",
] as const satisfies ReadonlyArray<LongHorizonCategory>;

// ---------------------------------------------------------------------------
// Step types (the multi-step lifecycle driver)
// ---------------------------------------------------------------------------

/**
 * One tracked-memory insert. The harness inserts a new
 * memory row with the given kind and content, captures the
 * assigned `id`, and stores it under the step's `label`
 * (e.g. "A", "B", "current-postgres") so subsequent steps
 * can refer to it by label rather than by id.
 *
 * The optional `relationship` block seeds the inserted row's
 * `metadata.relationship` pointer block with the given
 * entries. The harness wraps the block in the production
 * safe-empty shape (empty defaults for missing keys) so the
 * `listActiveMemoryRelationshipBlocks` reader projects the
 * row consistently.
 */
export interface LongHorizonInsertStep {
  kind: "insert";
  /** Stable label for the inserted memory (e.g. "A", "B"). */
  label: string;
  /** Internal kind enum. Defaults to `"fact"`. */
  memoryKind?: MemoryKind;
  /** Controller-normalized memory content (safe text only). */
  memoryContent: string;
  /** Optional initial `relationship` pointer block seed. */
  relationship?: {
    supersedes?: number[];
    supersededBy?: number[];
    olderVariantsOf?: number[];
    conflictsWith?: number[];
    detectionConfidence?: number;
    resolvedAt?: number;
  };
}

/**
 * One supersession step: insert a NEW memory and supersede
 * an OLD memory. The harness:
 *   1. Inserts the new memory (captures the assigned id).
 *   2. Writes the new memory's `metadata.relationship`
 *      with `supersedes: [oldId]` and a fresh
 *      `derivedSchemaVersion` + `derivedAt`.
 *   3. Back-patches the OLD memory's
 *      `metadata.relationship.supersededBy` via
 *      `addSupersededByToMemory` (the production storage
 *      seam; preserves the existing pointer block).
 *   4. Calls `transitionMemoryState({ active → superseded,
 *      reason, triggeringMemoryId: newId, confidence,
 *      actor: "long-horizon-evaluation" })` on the OLD row
 *      (the audit-backed transition seam). The transition
 *      writes exactly one row to `memory_transitions`.
 *
 * The new memory stays `active` after the supersession
 * step (it is the new current truth). The OLD memory
 * transitions to `superseded` (hidden from active recall).
 */
export interface LongHorizonSupersedeStep {
  kind: "supersede";
  /** Label of the new memory (the new current truth). */
  newLabel: string;
  /** Label of the old memory (will transition to superseded). */
  oldLabel: string;
  /** New memory content. */
  newMemoryContent: string;
  /** Reason tag for the audit row (e.g. "supersession"). */
  reason: string;
  /** Optional confidence for the audit row (0..1). */
  confidence?: number;
  /** New memory kind. Defaults to `"fact"`. */
  newMemoryKind?: MemoryKind;
}

/**
 * One invalidation step: transition an existing memory
 * from `active` to `invalidated`. The harness calls
 * `transitionMemoryState` with the given reason; the row
 * is hidden from active recall (the read-side
 * `state = 'active'` filter excludes invalidated rows)
 * but stays on disk for audit.
 */
export interface LongHorizonInvalidateStep {
  kind: "invalidate";
  /** Label of the memory to invalidate. */
  label: string;
  /** Reason tag for the audit row. */
  reason: string;
  /** Optional confidence for the audit row (0..1). */
  confidence?: number;
}

/**
 * One reactivation step: transition an existing memory
 * from `superseded` back to `active`. The harness calls
 * `transitionMemoryState` with the given reason. This is
 * the "we changed our mind" / "rollback" path. The harness
 * uses this in v1 only for the optional rollback scenario
 * (currently NOT exercised; reserved for v2 expansion).
 *
 * The step is declared here for completeness so a future
 * v2 scenario can use it without a module change. The
 * `reactivate` step is NOT exercised by the v1 scenario
 * set (v1 has no rollback scenario).
 */
export interface LongHorizonReactivateStep {
  kind: "reactivate";
  /** Label of the memory to reactivate. */
  label: string;
  /** Reason tag for the audit row. */
  reason: string;
}

/**
 * One link-redundant step: add an `olderVariantsOf`
 * pointer to a memory's `metadata.relationship` block.
 * The harness updates the row's metadata via
 * `updateMemoryMetadata`, preserving any existing
 * relationship block fields. The memory stays ACTIVE
 * (redundancy is a soft pointer, not a state transition);
 * the harness verifies the relationship block on the
 * captured state.
 */
export interface LongHorizonLinkRedundantStep {
  kind: "link-redundant";
  /** Label of the memory that is the older variant. */
  olderLabel: string;
  /** Label of the canonical / newer memory. */
  canonicalLabel: string;
}

/**
 * One link-conflict step: add a `conflictsWith` pointer
 * between two memories' `metadata.relationship` blocks.
 * By default the harness writes the pointer BOTH ways
 * (A.conflictsWith.push(B) AND B.conflictsWith.push(A))
 * to mirror the production detector's bidirectional write.
 * Pass `bidirectional: false` to write one direction only.
 *
 * The memories stay ACTIVE (conflict is a soft pointer,
 * not a state transition); the harness verifies BOTH
 * memories remain active and that the relationship block
 * carries the expected pointer.
 */
export interface LongHorizonLinkConflictStep {
  kind: "link-conflict";
  /** Label of the first memory. */
  labelA: string;
  /** Label of the second memory. */
  labelB: string;
  /** When true (default) the harness writes both directions. */
  bidirectional?: boolean;
}

/**
 * One recall snapshot step. The harness calls
 * `listActiveMemorySummaries` and `listMemoryTransitions`
 * at this point and captures the active-memory id set
 * (the "current truth" at this step) and the audit-row
 * count up to this point.
 *
 * The `expectedCurrentIds` field is OPTIONAL. When set,
 * the harness asserts the captured active-memory id set
 * matches the expected set EXACTLY (set match; order does
 * not matter). When omitted, the snapshot is recorded for
 * the human report only and no assertion fires.
 */
export interface LongHorizonRecallStep {
  kind: "recall";
  /** Snapshot label (e.g. "after-supersession", "final"). */
  snapshotLabel: string;
  /** Optional expected active-memory id set (set match). */
  expectedCurrentIds?: ReadonlyArray<number>;
  /** Optional stale-memory exclusion check. */
  expectedNotInActiveRecall?: ReadonlyArray<number>;
}

/**
 * Discriminated union of every step kind the harness
 * supports. The harness iterates over a scenario's
 * `steps` array in order and dispatches on `step.kind`.
 */
export type LongHorizonStep =
  | LongHorizonInsertStep
  | LongHorizonSupersedeStep
  | LongHorizonInvalidateStep
  | LongHorizonReactivateStep
  | LongHorizonLinkRedundantStep
  | LongHorizonLinkConflictStep
  | LongHorizonRecallStep;

// ---------------------------------------------------------------------------
// Expectation types
// ---------------------------------------------------------------------------

/**
 * A single expected final state for one tracked memory.
 * The harness captures each tracked memory's final
 * `state` after running the full scenario step list and
 * asserts it matches the expectation.
 *
 * The `label` references the label set on a prior
 * `insert` step (or on a `supersede` step's `newLabel`).
 * The harness fails the scenario if a `label` references
 * a memory the scenario never inserted.
 */
export interface LongHorizonExpectedFinalState {
  /** Label of the memory (matches an insert / supersede label). */
  label: string;
  /** Expected final state (active | superseded | invalidated). */
  expectedState: "active" | "superseded" | "invalidated";
}

/**
 * Per-scenario expectations. Each field is independent;
 * the harness only checks the fields that are present.
 * A scenario that sets NO expectations runs purely for the
 * human-report diagnostics (rare; the v1 set always sets
 * at least one expectation).
 */
export interface LongHorizonExpectations {
  /**
   * Expected final state per tracked memory. The harness
   * asserts the captured state for each entry matches.
   * Drives the `lifecycleStateGate` block.
   */
  finalStates?: ReadonlyArray<LongHorizonExpectedFinalState>;
  /**
   * Expected total audit-row count for the scenario. The
   * harness counts `memory_transitions` rows after the
   * scenario finishes and asserts the count matches.
   * Drives the `auditGate` block.
   */
  expectedTransitions?: number;
  /**
   * Expected active-memory LABEL set at the FINAL state.
   * The harness resolves each label through the
   * scenario's `labelToId` map and asserts the resolved
   * id set equals the captured FINAL active-memory id
   * set EXACTLY (set match; order does not matter). The
   * field is LABEL-based (not raw-id based) so a
   * scenario can express "the current truth is C"
   * without knowing the assigned id at scenario-write
   * time.
   *
   * The harness compares this set against the FINAL
   * captured active-memory id set. A reviewer who wants to
   * audit "what is the current truth at the end?" reads
   * this field.
   */
  finalExpectedCurrentLabels?: ReadonlyArray<string>;
  /**
   * Expected stale-memory exclusion check at the FINAL
   * state. The harness resolves each label through the
   * scenario's `labelToId` map and asserts NONE of the
   * resolved ids appear in the FINAL active-memory id
   * set. The field is LABEL-based (not raw-id based) so
   * a scenario can express "A is stale" without knowing
   * the assigned id.
   */
  finalExpectedStaleExcludedLabels?: ReadonlyArray<string>;
  /**
   * Conflict-preservation check. For the
   * `conflict-preserved` category, the harness asserts
   * BOTH `labelA` and `labelB` are still `active` at the
   * end of the scenario (the conflict pointer does NOT
   * trigger an auto-invalidation).
   */
  conflictPreservedActive?: { labelA: string; labelB: string };
  /**
   * Whether this scenario contributes to the
   * `currentTruthGate` block. Defaults to `true` when
   * the scenario sets a `finalExpectedCurrentLabels`
   * expectation; scenarios that do NOT set the
   * expectation opt out (rare).
   */
  currentTruthCritical?: boolean;
  /**
   * Whether this scenario contributes to the
   * `staleExclusionGate` block. Defaults to `true` when
   * the scenario sets a `finalExpectedStaleExcludedLabels`
   * expectation.
   */
  staleExclusionCritical?: boolean;
  /**
   * Whether this scenario contributes to the
   * `conflictPreservationGate` block. Defaults to `true`
   * when the scenario sets a `conflictPreservedActive`
   * expectation.
   */
  conflictCritical?: boolean;
}

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

/**
 * A single long-horizon scenario. The harness runs the
 * scenario end-to-end against a fresh temp storage
 * handle, captures the per-step state, and evaluates the
 * `expectations` block against the captured data.
 *
 * The `steps` array is the SCENARIO BODY: every step
 * runs in declaration order against the temp storage
 * handle. The `expectations` block is the SCENARIO
 * TRUTH: a typed contract the harness evaluates against
 * the final captured state.
 */
export interface LongHorizonScenario {
  /** Stable id; used as the `scenarioId` in the report. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Short description of what this scenario exercises. */
  description: string;
  /**
   * Top-level category. Drives the per-category summary
   * table and the gate attribution.
   */
  category: LongHorizonCategory;
  /**
   * The multi-step lifecycle story. The harness runs
   * each step in order against a fresh temp storage
   * handle.
   */
  steps: ReadonlyArray<LongHorizonStep>;
  /**
   * Expectations the harness checks against the
   * captured final state. Each field is independent;
   * the harness only checks the fields that are present.
   */
  expectations: LongHorizonExpectations;
}

// ---------------------------------------------------------------------------
// Built-in scenario set (v1)
// ---------------------------------------------------------------------------

/**
 * The default v1 scenario set (8 scenarios). Covers the
 * brief's required multi-step lifecycle axes:
 *
 *   - 2 supersession chain (A → B → C, recall current)
 *   - 2 invalidation / retraction
 *   - 1 conflict preserved (both stay active)
 *   - 1 redundancy linked (soft pointer, both stay active)
 *   - 1 current-truth recall (multi-update, recall returns
 *     the current)
 *   - 1 false-premise about a stale memory
 *   - 1 multi-topic separation (two parallel chains)
 *
 * The set is the canonical reference set used by
 * `runLongHorizonMemoryEvaluation()`. A future v2 that
 * adds new scenarios is a deliberate, visible change; the
 * harness never re-tunes scenario expectations on
 * evaluation results.
 */
export const BUILT_IN_LONG_HORIZON_SCENARIOS: ReadonlyArray<LongHorizonScenario> = [
  // =======================================================================
  // A. Supersession chain (2 scenarios)
  // =======================================================================

  // -----------------------------------------------------------------------
  // A1. supersession-chain: A → B → C
  // -----------------------------------------------------------------------
  {
    id: "supersession-chain-3",
    label: "Three-step supersession chain: A → B → C, recall returns C",
    description:
      "Insert A (Postgres 14 primary store), supersede A with B " +
      "(Postgres 15), then supersede B with C (Postgres 16). The " +
      "harness asserts A and B are `superseded` with one audit " +
      "row each, C is `active`, and the final active recall " +
      "returns exactly C (and neither A nor B).",
    category: "supersession-chain",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "Postgres 14 is the current primary store for every deployment.",
      },
      {
        kind: "supersede",
        newLabel: "B",
        oldLabel: "A",
        newMemoryContent: "Postgres 15 is the current primary store for every deployment.",
        reason: "supersession",
        confidence: 0.92,
        newMemoryKind: "fact",
      },
      {
        kind: "supersede",
        newLabel: "C",
        oldLabel: "B",
        newMemoryContent: "Postgres 16 is the current primary store for every deployment.",
        reason: "supersession",
        confidence: 0.95,
        newMemoryKind: "fact",
      },
      {
        kind: "recall",
        snapshotLabel: "final",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A", expectedState: "superseded" },
        { label: "B", expectedState: "superseded" },
        { label: "C", expectedState: "active" },
      ],
      // 2 transitions: A → superseded, B → superseded.
      expectedTransitions: 2,
      finalExpectedCurrentLabels: ["C"],
      finalExpectedStaleExcludedLabels: ["A", "B"],
    },
  },

  // -----------------------------------------------------------------------
  // A2. recall-current-after-multiple-updates (same shape, different topic)
  // -----------------------------------------------------------------------
  {
    id: "recall-current-after-multiple-updates",
    label: "Multi-update lifecycle: scheduler A → B → C, recall returns C",
    description:
      "Insert A (legacy cron scheduler), supersede A with B " +
      "(BullMQ single-instance), then supersede B with C (BullMQ " +
      "distributed). The harness asserts the final recall " +
      "returns exactly C and that A and B are hidden from " +
      "active recall but preserved on disk for audit.",
    category: "current-truth-recall",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "The project uses a legacy cron-based scheduler for background jobs.",
      },
      {
        kind: "supersede",
        newLabel: "B",
        oldLabel: "A",
        newMemoryContent: "The project uses BullMQ single-instance for background job scheduling.",
        reason: "supersession",
        confidence: 0.88,
        newMemoryKind: "fact",
      },
      {
        kind: "supersede",
        newLabel: "C",
        oldLabel: "B",
        newMemoryContent:
          "The project uses BullMQ distributed deployment for background job scheduling.",
        reason: "supersession",
        confidence: 0.9,
        newMemoryKind: "fact",
      },
      {
        kind: "recall",
        snapshotLabel: "final",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A", expectedState: "superseded" },
        { label: "B", expectedState: "superseded" },
        { label: "C", expectedState: "active" },
      ],
      expectedTransitions: 2,
      finalExpectedCurrentLabels: ["C"],
      finalExpectedStaleExcludedLabels: ["A", "B"],
    },
  },

  // =======================================================================
  // B. Invalidation / retraction (2 scenarios)
  // =======================================================================

  // -----------------------------------------------------------------------
  // B1. invalidation-retraction: A active → invalidated
  // -----------------------------------------------------------------------
  {
    id: "invalidation-retraction",
    label: "Active → invalidated: A is retracted, recall excludes A",
    description:
      "Insert A (active), invalidate A with reason " +
      '"explicit_retraction". The harness asserts A is ' +
      "`invalidated` after the scenario, the active recall " +
      "is empty, and exactly one audit row exists.",
    category: "invalidation-retraction",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "The team uses the SM-1 algorithm for deduplication.",
      },
      {
        kind: "invalidate",
        label: "A",
        reason: "explicit_retraction",
        confidence: 0.81,
      },
      {
        kind: "recall",
        snapshotLabel: "after-invalidation",
      },
    ],
    expectations: {
      finalStates: [{ label: "A", expectedState: "invalidated" }],
      expectedTransitions: 1,
      finalExpectedCurrentLabels: [],
      finalExpectedStaleExcludedLabels: ["A"],
    },
  },

  // -----------------------------------------------------------------------
  // B2. invalidate-after-supersede: A → supersede to B → invalidate B
  // -----------------------------------------------------------------------
  {
    id: "invalidate-after-supersede",
    label: "Supersede then invalidate: A→B→invalidate(B), recall empty",
    description:
      "Insert A (active), supersede A with B, then invalidate " +
      "B. The harness asserts A is `superseded`, B is " +
      "`invalidated`, the active recall is empty, and two " +
      "audit rows exist.",
    category: "invalidate-after-supersede",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "The project uses library X for HTTP retries.",
      },
      {
        kind: "supersede",
        newLabel: "B",
        oldLabel: "A",
        newMemoryContent: "The project uses library Y for HTTP retries.",
        reason: "supersession",
        confidence: 0.9,
        newMemoryKind: "fact",
      },
      {
        kind: "invalidate",
        label: "B",
        reason: "explicit_retraction",
        confidence: 0.85,
      },
      {
        kind: "recall",
        snapshotLabel: "after-double-hide",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A", expectedState: "superseded" },
        { label: "B", expectedState: "invalidated" },
      ],
      expectedTransitions: 2,
      finalExpectedCurrentLabels: [],
      finalExpectedStaleExcludedLabels: ["A", "B"],
    },
  },

  // =======================================================================
  // C. Conflict preservation (1 scenario)
  // =======================================================================

  // -----------------------------------------------------------------------
  // C1. conflict-preserved: A and B both stay active after link-conflict
  // -----------------------------------------------------------------------
  {
    id: "conflict-preserved-active",
    label: "Conflict pointer: A and B both remain ACTIVE",
    description:
      "Insert A and B both active, then link-conflict both ways. " +
      "The harness asserts BOTH remain ACTIVE (the conflict " +
      "pointer is a soft relationship, NOT an auto-invalidation), " +
      "BOTH are in the active recall, and there are zero audit " +
      "rows (no state transitions happened).",
    category: "conflict-preserved",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "The team uses Python for ML training.",
      },
      {
        kind: "insert",
        label: "B",
        memoryKind: "fact",
        memoryContent: "The team uses Rust for ML training.",
      },
      {
        kind: "link-conflict",
        labelA: "A",
        labelB: "B",
        bidirectional: true,
      },
      {
        kind: "recall",
        snapshotLabel: "after-link-conflict",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A", expectedState: "active" },
        { label: "B", expectedState: "active" },
      ],
      // No transitions: a conflict pointer is not a state change.
      expectedTransitions: 0,
      finalExpectedCurrentLabels: ["A", "B"],
      finalExpectedStaleExcludedLabels: [],
      conflictPreservedActive: { labelA: "A", labelB: "B" },
      // Explicitly opt in so the gate attribution is obvious
      // even if a future reviewer reads the scenario before
      // the expectation defaults.
      currentTruthCritical: true,
      staleExclusionCritical: false,
      conflictCritical: true,
    },
  },

  // =======================================================================
  // D. Redundancy linked (1 scenario)
  // =======================================================================

  // -----------------------------------------------------------------------
  // D1. redundancy-linked: olderVariantsOf pointer; both stay active
  // -----------------------------------------------------------------------
  {
    id: "redundancy-linked-not-invalidated",
    label: "Redundancy pointer: olderVariantsOf linked, both stay ACTIVE",
    description:
      "Insert A and A' (paraphrase) both active, then link " +
      "A as an older variant of A' (A.olderVariantsOf = [A']). " +
      "The harness asserts BOTH remain ACTIVE (the redundancy " +
      "pointer is a soft relationship, NOT a state transition), " +
      "BOTH are in the active recall, and there are zero audit " +
      "rows.",
    category: "redundancy-linked",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "The Postgres connection pool is configured at 16 connections.",
      },
      {
        kind: "insert",
        label: "A-prime",
        memoryKind: "fact",
        memoryContent: "Postgres uses a 16-connection pool per worker.",
      },
      {
        kind: "link-redundant",
        olderLabel: "A",
        canonicalLabel: "A-prime",
      },
      {
        kind: "recall",
        snapshotLabel: "after-link-redundant",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A", expectedState: "active" },
        { label: "A-prime", expectedState: "active" },
      ],
      // No transitions: a redundancy pointer is not a state change.
      expectedTransitions: 0,
      finalExpectedCurrentLabels: ["A", "A-prime"],
      finalExpectedStaleExcludedLabels: [],
    },
  },

  // =======================================================================
  // E. False premise (1 scenario)
  // =======================================================================

  // -----------------------------------------------------------------------
  // E1. false-premise-about-stale: A → supersede to B → recall about A returns B
  // -----------------------------------------------------------------------
  {
    id: "false-premise-about-stale",
    label: "False premise: recall about a stale memory returns the current truth",
    description:
      "Insert A (Postgres 14), supersede A with B (Postgres 16). " +
      "A query that implicitly assumes A is current must NOT " +
      "return A; the active-memory recall must return B " +
      "(the current truth). The harness asserts A is " +
      "`superseded`, B is `active`, the final active recall " +
      "returns exactly B, and A is excluded.",
    category: "false-premise-stale",
    steps: [
      {
        kind: "insert",
        label: "A",
        memoryKind: "fact",
        memoryContent: "The project uses Postgres 14 as the primary store.",
      },
      {
        kind: "supersede",
        newLabel: "B",
        oldLabel: "A",
        newMemoryContent: "The project uses Postgres 16 as the primary store.",
        reason: "supersession",
        confidence: 0.94,
        newMemoryKind: "fact",
      },
      {
        kind: "recall",
        snapshotLabel: "recall-about-A-returns-B",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A", expectedState: "superseded" },
        { label: "B", expectedState: "active" },
      ],
      expectedTransitions: 1,
      // The current truth is B (NOT A). A query that
      // matches A's content surface returns B in active
      // recall — A is hidden by the state filter.
      finalExpectedCurrentLabels: ["B"],
      finalExpectedStaleExcludedLabels: ["A"],
    },
  },

  // =======================================================================
  // F. Multi-topic / project-like separation (1 scenario)
  // =======================================================================

  // -----------------------------------------------------------------------
  // F1. multi-topic-current-truth: two parallel chains in different domains
  // -----------------------------------------------------------------------
  {
    id: "multi-topic-current-truth",
    label: "Two parallel update chains: B1 AND B2 both surface",
    description:
      "Two parallel lifecycle chains: (A1: Postgres 14) " +
      "superseded by (B1: Postgres 16); (A2: React dashboard) " +
      "superseded by (B2: Vue dashboard). The harness asserts " +
      "B1 and B2 are both `active`, A1 and A2 are both " +
      "`superseded`, the active recall returns exactly " +
      "{B1, B2}, and A1 / A2 are excluded.",
    category: "multi-topic-separation",
    steps: [
      // Topic 1: Postgres primary store
      {
        kind: "insert",
        label: "A1",
        memoryKind: "fact",
        memoryContent: "The project uses Postgres 14 as the primary store.",
      },
      {
        kind: "supersede",
        newLabel: "B1",
        oldLabel: "A1",
        newMemoryContent: "The project uses Postgres 16 as the primary store.",
        reason: "supersession",
        confidence: 0.93,
        newMemoryKind: "fact",
      },
      // Topic 2: dashboard framework
      {
        kind: "insert",
        label: "A2",
        memoryKind: "fact",
        memoryContent: "The dashboard uses React as the primary UI framework.",
      },
      {
        kind: "supersede",
        newLabel: "B2",
        oldLabel: "A2",
        newMemoryContent: "The dashboard uses Vue as the primary UI framework.",
        reason: "supersession",
        confidence: 0.87,
        newMemoryKind: "fact",
      },
      {
        kind: "recall",
        snapshotLabel: "both-topics-current",
      },
    ],
    expectations: {
      finalStates: [
        { label: "A1", expectedState: "superseded" },
        { label: "B1", expectedState: "active" },
        { label: "A2", expectedState: "superseded" },
        { label: "B2", expectedState: "active" },
      ],
      expectedTransitions: 2,
      finalExpectedCurrentLabels: ["B1", "B2"],
      finalExpectedStaleExcludedLabels: ["A1", "A2"],
    },
  },
];
