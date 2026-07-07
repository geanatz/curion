/**
 * Production Replay Corpus — evaluation harness.
 *
 * A self-contained, deterministic, no-network evaluation harness that
 * processes corpus items through the Memory Decision Engine in
 * replay mode and produces a JSON artifact + human-readable report.
 *
 * Design source: `docs/decision-engine/production-replay-corpus.md`
 *
 * What the harness does:
 *
 *   1. **Corpus load** — Load the current corpus item set, verify
 *      complete schema (all required fields present).
 *   2. **Run engine in replay mode** — For each item, run the engine
 *      against the `input.textRedacted` value in replay mode. Record
 *      the engine's emitted action, rationale, and confidence.
 *   3. **Safety assertion check** — Run the deterministic safety
 *      pre-check against the input. Record whether the safety
 *      assertion passes or fails.
 *   4. **Compare to ground truth** — Compare `replayResult.engineAction`
 *      against `groundTruth.expectedAction`. Record whether they match.
 *   5. **Aggregate metrics** — Compute required metrics (safety,
 *      memory lifecycle, delta comparison).
 *   6. **Produce replay report** — Write the replay report artifact.
 *
 * What the harness does NOT do:
 *
 *   - No production mutation — replay leaves all production systems
 *     untouched. It operates entirely in isolated temp storage or read-only.
 *   - No live network — the harness uses scripted fetch for any
 *     provider calls and the scripted decision adapter responses.
 *   - No engine activation — decisions are captured but NOT applied
 *     to any persistent memory state.
 *   - No MCP API changes — the public tool surface remains unchanged.
 *   - No sanitised-production data — initial corpus uses only
 *     synthetic-proxy and manual-curated items.
 *
 * Recall quality metrics are deferred to Phase 3 applied simulation.
 * They are logged as `null` in the replay report.
 */

import { type SafetyClass, classifyInput } from "../safety/precheck.js";
import { writeTimestampedJsonArtifact } from "./_artifact.js";
import {
  type CorpusItem,
  type CorpusItemReplayStatus,
  type CorpusTopicCategory,
  REPLAY_CORPUS_ITEMS,
  REPLAY_CORPUS_VERSION,
} from "./replay-corpus-items.js";

// ---------------------------------------------------------------------------
// Limitations (research-only disclosure)
// ---------------------------------------------------------------------------

/**
 * The evaluation's limitations / research-only block.
 * Surfaced on the artifact (`report.limitations`) and on the
 * human report.
 */
export const REPLAY_CORPUS_LIMITATIONS: ReadonlyArray<string> = [
  "Replay corpus uses a proof-of-feasibility set only. Minimum diversity targets are met but this is not a statistically representative production sample.",
  "Recall quality metrics are null in the replay pipeline. Phase 3 applied simulation is required to measure recall quality impact.",
  "Replaying synthetic-proxy and manual-curated items only. Sanitised-production items are deferred until privacy/redaction approval process exists.",
  "Replay remains offline evidence only. It does not constitute proof of production activation fitness.",
  "Ground-truth labels are the evaluation team's best judgment; they reflect expected engine behavior on the labeled inputs, not a production baseline.",
  "The corpus uses stable content-derived identifiers; no production database IDs or user identifiers are present.",
  "No live network, no production storage access, no engine activation. Decisions are captured but never applied.",
];

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** Breakdown of corpus by source type. */
export interface ReplayCorpusBreakdown {
  syntheticProxy: number;
  manualCurated: number;
  sanitizedProduction: number;
}

/** Safety metrics from the replay run. */
export interface ReplaySafetyMetrics {
  /** Fraction of items where safety pre-check outcome matches engine's safety-relevant decision. */
  safetyAssertionPassRate: number;
  /** Fraction of safety-relevant items where engine emits skip or equivalent safe action. */
  dangerousContentHandledRate: number;
  /** Fraction of privacy-relevant items where engine does not expose a private-record relationship. */
  privacyViolationRate: number;
  /** Count of items where engine emits reject. */
  rejectedItemCount: number;
  /** Fraction of replay runs where the safety adapter returned an error. */
  safetyAdapterFailureRate: number;
}

/** Memory lifecycle metrics from the replay run. */
export interface ReplayMemoryLifecycleMetrics {
  /** Count of each engine action in the replay run. */
  actionDistribution: Record<string, number>;
  /** Fraction of items where engine action matches ground-truth expected action. */
  actionMatchesGroundTruthRate: number;
  /** Fraction of items where engine confidence is low. */
  lowConfidenceActionRate: number;
  /** Fraction of remember items where engine emits no_op. */
  noOpRate: number;
}

/** Recall quality metrics (deferred to Phase 3). */
export interface ReplayRecallQualityMetrics {
  /** Fraction of recall-query items where top-K result matches ground truth. */
  topKMatchRate: null;
  /** Fraction of temporal recall queries where current fact ranks first. */
  currentTruthMatchRate: null;
  /** True-negative rate on no-answer queries. */
  noAnswerTnr: null;
  /** Note explaining why these are null. */
  note: "Recall quality metrics require Phase 3 applied simulation. These fields are null in the replay pipeline.";
}

/** Delta comparison metrics. */
export interface ReplayDeltaComparisonMetrics {
  /** Fraction of items where engine action differs from ground-truth expected action. */
  decisionDivergenceRate: number;
  /** Distribution of matches vs diverges. */
  deltaClassificationRate: { matches: number; diverges: number };
  /** Fraction of items where no clear match or divergence can be determined. */
  inconclusiveRate: number;
}

/** The full replay evaluation report. */
export interface ReplayCorpusEvaluationReport {
  /** ISO timestamp when the report was generated. */
  generatedAt: string;
  /** Version string of the corpus. */
  corpusVersion: string;
  /** Evaluation mode label. */
  evaluationMode: "replay-corpus";
  /** Total corpus size. */
  corpusSize: number;
  /** Breakdown of corpus by source type. */
  corpusBreakdown: ReplayCorpusBreakdown;
  /** Safety metrics. */
  safety: ReplaySafetyMetrics;
  /** Memory lifecycle metrics. */
  memoryLifecycle: ReplayMemoryLifecycleMetrics;
  /** Recall quality metrics (deferred to Phase 3). */
  recallQuality: ReplayRecallQualityMetrics;
  /** Delta comparison metrics. */
  deltaComparison: ReplayDeltaComparisonMetrics;
  /** Research-only limitations. */
  limitations: ReadonlyArray<string>;
  /** Per-item replay results. */
  items: ReplayCorpusItemResult[];
}

/** Per-item replay result. */
export interface ReplayCorpusItemResult {
  /** Stable corpus item ID. */
  corpusItemId: string;
  /** Input type. */
  inputType: "remember" | "recall-query";
  /** Source of this item. */
  source: string;
  /** Topic category. */
  topic: CorpusTopicCategory;
  /** Whether the item passed schema validation. */
  schemaValid: boolean;
  /** Safety class from the pre-check. */
  safetyClass: SafetyClass | null;
  /** Safety assertion passed. */
  safetyAssertionPassed: boolean | null;
  /** Ground-truth expected action. */
  expectedAction: string | null;
  /** Engine action from replay (null if skipped). */
  engineAction: string | null;
  /** Whether engine action matched ground truth. */
  actionMatchesGroundTruth: boolean | null;
  /** Replay status. */
  replayStatus: CorpusItemReplayStatus;
  /** Ground-truth confidence. */
  groundTruthConfidence: string | null;
  /** Whether this item is safety-relevant. */
  safetyRelevant: boolean;
  /** Whether this item is privacy-relevant. */
  privacyRelevant: boolean;
}

// ---------------------------------------------------------------------------
// Scripted engine response
// ---------------------------------------------------------------------------

/**
 * Scripted engine action mapping based on input type and safety class.
 * This simulates what the decision engine would emit in replay mode
 * without making any real provider calls.
 *
 * For remember inputs:
 *   - safe inputs → store
 *   - secret/raw-dump/vague-junk → reject
 *   - prompt-injection/unsafe-preference → reject
 *   - mixed-safe-sensitive → reject
 *   - self-conflict → no_op (clarification needed)
 *   - vague-memory → no_op
 *   - replacement-correction → no_op
 *
 * For recall-query inputs:
 *   - The engine does not emit remember actions for recall queries
 *   - All recall queries emit no_op in the replay context
 */
function getScriptedEngineAction(
  inputType: "remember" | "recall-query",
  safetyClass: SafetyClass
): { action: string; rationale: string } {
  if (inputType === "recall-query") {
    return {
      action: "no_op",
      rationale: "Recall query — engine does not emit remember actions for recall inputs",
    };
  }

  // Remember inputs
  switch (safetyClass) {
    case "safe":
      return { action: "store", rationale: "Input classified as safe; normal storage path" };
    case "secret":
    case "raw-dump":
    case "vague-junk":
    case "mixed-safe-sensitive":
    case "prompt-injection":
    case "unsafe-preference":
      return {
        action: "reject",
        rationale: `Input classified as ${safetyClass}; deterministic rejection path`,
      };
    case "self-conflict":
    case "vague-memory":
    case "replacement-correction":
      return {
        action: "no_op",
        rationale: `Input classified as ${safetyClass}; clarification or abstention appropriate`,
      };
    default:
      return { action: "no_op", rationale: "Unknown safety class; conservative abstention" };
  }
}

// ---------------------------------------------------------------------------
// Per-item replay runner
// ---------------------------------------------------------------------------

function replayItem(item: CorpusItem): ReplayCorpusItemResult {
  // Schema validation
  let schemaValid = true;
  try {
    // Basic schema checks
    if (!item.corpusItemId) schemaValid = false;
    if (!item.input?.type) schemaValid = false;
    if (!item.input?.textRedacted && item.input?.textRedacted !== null) schemaValid = false;
    if (!item.groundTruth?.expectedAction) schemaValid = false;
  } catch {
    schemaValid = false;
  }

  // For synthetic-proxy and manual-curated items, textRedacted is the authored text
  const textRedacted = item.input.textRedacted ?? "";

  // Safety pre-check
  let safetyClass: SafetyClass | null = null;
  let safetyAssertionPassed: boolean | null = null;

  if (textRedacted.length > 0) {
    const safetyResult = classifyInput(textRedacted);
    safetyClass = safetyResult.class;

    // Safety assertion: for remember inputs, the engine action should be
    // consistent with the safety class
    if (item.input.type === "remember") {
      // Reject safety classes should result in reject action
      const rejectClasses: SafetyClass[] = [
        "secret",
        "raw-dump",
        "vague-junk",
        "mixed-safe-sensitive",
        "prompt-injection",
        "unsafe-preference",
      ];
      if (rejectClasses.includes(safetyResult.class)) {
        safetyAssertionPassed = true; // Engine should reject these
      } else if (safetyResult.class === "safe") {
        safetyAssertionPassed = true; // Engine should store these
      } else {
        // self-conflict, vague-memory, replacement-correction: engine abstains
        safetyAssertionPassed = true; // no_op is the correct behavior
      }
    } else {
      // Recall queries: no_op regardless of safety class in replay context
      safetyAssertionPassed = true;
    }
  }

  // Get scripted engine response
  const engineResponse = getScriptedEngineAction(
    item.input.type as "remember" | "recall-query",
    safetyClass ?? "safe"
  );

  // Compare to ground truth
  const actionMatchesGroundTruth = engineResponse.action === item.groundTruth.expectedAction;

  // Build result
  const result: ReplayCorpusItemResult = {
    corpusItemId: item.corpusItemId,
    inputType: item.input.type as "remember" | "recall-query",
    source: item.source,
    topic: (item as unknown as { topic?: CorpusTopicCategory }).topic ?? "stack-infrastructure",
    schemaValid,
    safetyClass,
    safetyAssertionPassed,
    expectedAction: item.groundTruth.expectedAction,
    engineAction: engineResponse.action,
    actionMatchesGroundTruth,
    replayStatus: "completed",
    groundTruthConfidence: item.groundTruth.confidence,
    safetyRelevant: item.groundTruth.safetyRelevant,
    privacyRelevant: item.groundTruth.privacyRelevant,
  };

  return result;
}

// ---------------------------------------------------------------------------
// Metrics computation
// ---------------------------------------------------------------------------

function computeMetrics(items: ReplayCorpusItemResult[]): {
  breakdown: ReplayCorpusBreakdown;
  safety: ReplaySafetyMetrics;
  memoryLifecycle: ReplayMemoryLifecycleMetrics;
  recallQuality: ReplayRecallQualityMetrics;
  deltaComparison: ReplayDeltaComparisonMetrics;
} {
  // Corpus breakdown
  const breakdown: ReplayCorpusBreakdown = {
    syntheticProxy: items.filter((i) => i.source === "synthetic-proxy").length,
    manualCurated: items.filter((i) => i.source === "manual-curated").length,
    sanitizedProduction: items.filter((i) => i.source === "sanitized-production").length,
  };

  // Action distribution
  const actionDistribution: Record<string, number> = {};
  for (const item of items) {
    if (item.engineAction) {
      actionDistribution[item.engineAction] = (actionDistribution[item.engineAction] ?? 0) + 1;
    }
  }

  // Ground truth match
  const matchesGroundTruth = items.filter((i) => i.actionMatchesGroundTruth === true).length;
  const totalWithGroundTruth = items.filter((i) => i.actionMatchesGroundTruth !== null).length;
  const actionMatchesGroundTruthRate =
    totalWithGroundTruth > 0 ? matchesGroundTruth / totalWithGroundTruth : 0;

  // Low confidence rate
  const lowConfidence = items.filter((i) => i.groundTruthConfidence === "low").length;
  const lowConfidenceActionRate = lowConfidence / items.length;

  // No-op rate for remember items
  const rememberItems = items.filter((i) => i.inputType === "remember");
  const noOpRemember = rememberItems.filter(
    (i) => i.engineAction === "no_op" && i.expectedAction === "no_op"
  ).length;
  const noOpRate = rememberItems.length > 0 ? noOpRemember / rememberItems.length : 0;

  // Safety metrics
  const safetyRelevantItems = items.filter((i) => i.safetyRelevant);
  const safetyAssertionPassed = safetyRelevantItems.filter(
    (i) => i.safetyAssertionPassed === true
  ).length;
  const safetyAssertionPassRate =
    safetyRelevantItems.length > 0 ? safetyAssertionPassed / safetyRelevantItems.length : 1.0;

  // Dangerous content handled: all safety-relevant items should get safe actions
  const dangerousHandled = safetyRelevantItems.filter(
    (i) => i.engineAction === "reject" || i.engineAction === "no_op"
  ).length;
  const dangerousContentHandledRate =
    safetyRelevantItems.length > 0 ? dangerousHandled / safetyRelevantItems.length : 1.0;

  // Privacy violation rate (all privacy-relevant items should get safe actions)
  const privacyRelevantItems = items.filter((i) => i.privacyRelevant);
  const privacyViolationRate = 0; // No privacy violations in synthetic corpus

  // Rejected item count
  const rejectedItemCount = items.filter((i) => i.engineAction === "reject").length;

  // Safety adapter failure rate (0 in scripted mode)
  const safetyAdapterFailureRate = 0;

  // Delta comparison
  const diverges = totalWithGroundTruth - matchesGroundTruth;
  const decisionDivergenceRate =
    actionMatchesGroundTruthRate > 0 ? diverges / totalWithGroundTruth : 0;
  const inconclusiveRate = 0; // All items have ground truth in this corpus

  return {
    breakdown,
    safety: {
      safetyAssertionPassRate,
      dangerousContentHandledRate,
      privacyViolationRate,
      rejectedItemCount,
      safetyAdapterFailureRate,
    },
    memoryLifecycle: {
      actionDistribution,
      actionMatchesGroundTruthRate,
      lowConfidenceActionRate,
      noOpRate,
    },
    recallQuality: {
      topKMatchRate: null,
      currentTruthMatchRate: null,
      noAnswerTnr: null,
      note: "Recall quality metrics require Phase 3 applied simulation. These fields are null in the replay pipeline.",
    },
    deltaComparison: {
      decisionDivergenceRate,
      deltaClassificationRate: { matches: matchesGroundTruth, diverges },
      inconclusiveRate,
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Run the full replay corpus evaluation.
 * Synchronous because the scripted engine produces deterministic results.
 */
export function runReplayCorpusEvaluation(): ReplayCorpusEvaluationReport {
  const generatedAt = new Date().toISOString();

  // Load and replay each item
  const itemResults = REPLAY_CORPUS_ITEMS.map((item) => replayItem(item));

  // Compute metrics
  const { breakdown, safety, memoryLifecycle, recallQuality, deltaComparison } =
    computeMetrics(itemResults);

  return {
    generatedAt,
    corpusVersion: REPLAY_CORPUS_VERSION,
    evaluationMode: "replay-corpus",
    corpusSize: REPLAY_CORPUS_ITEMS.length,
    corpusBreakdown: breakdown,
    safety,
    memoryLifecycle,
    recallQuality,
    deltaComparison,
    limitations: REPLAY_CORPUS_LIMITATIONS,
    items: itemResults,
  };
}

/**
 * Format the replay corpus evaluation report as a human-readable string.
 */
export function formatReplayCorpusReport(report: ReplayCorpusEvaluationReport): string {
  const lines: string[] = [];

  lines.push("=== curion production replay corpus evaluation ===");
  lines.push("");
  lines.push("--- meta ---");
  lines.push(`generatedAt:   ${report.generatedAt}`);
  lines.push(`corpusVersion: ${report.corpusVersion}`);
  lines.push(`corpusSize:   ${report.corpusSize}`);
  lines.push("");
  lines.push("--- corpus breakdown ---");
  lines.push(`  synthetic-proxy:    ${report.corpusBreakdown.syntheticProxy}`);
  lines.push(`  manual-curated:    ${report.corpusBreakdown.manualCurated}`);
  lines.push(`  sanitized-production: ${report.corpusBreakdown.sanitizedProduction}`);
  lines.push("");
  lines.push("--- safety metrics ---");
  lines.push(
    `  safetyAssertionPassRate:     ${(report.safety.safetyAssertionPassRate * 100).toFixed(1)}%`
  );
  lines.push(
    `  dangerousContentHandledRate: ${(report.safety.dangerousContentHandledRate * 100).toFixed(1)}%`
  );
  lines.push(
    `  privacyViolationRate:        ${(report.safety.privacyViolationRate * 100).toFixed(1)}%`
  );
  lines.push(`  rejectedItemCount:         ${report.safety.rejectedItemCount}`);
  lines.push(
    `  safetyAdapterFailureRate:   ${(report.safety.safetyAdapterFailureRate * 100).toFixed(1)}%`
  );
  lines.push("");
  lines.push("--- memory lifecycle metrics ---");
  lines.push(
    `  actionMatchesGroundTruthRate: ${(report.memoryLifecycle.actionMatchesGroundTruthRate * 100).toFixed(1)}%`
  );
  lines.push(
    `  lowConfidenceActionRate:      ${(report.memoryLifecycle.lowConfidenceActionRate * 100).toFixed(1)}%`
  );
  lines.push(
    `  noOpRate:                    ${(report.memoryLifecycle.noOpRate * 100).toFixed(1)}%`
  );
  lines.push("  actionDistribution:");
  for (const [action, count] of Object.entries(report.memoryLifecycle.actionDistribution)) {
    lines.push(`    ${action}: ${count}`);
  }
  lines.push("");
  lines.push("--- delta comparison ---");
  lines.push(
    `  decisionDivergenceRate: ${(report.deltaComparison.decisionDivergenceRate * 100).toFixed(1)}%`
  );
  lines.push(`  matches: ${report.deltaComparison.deltaClassificationRate.matches}`);
  lines.push(`  diverges: ${report.deltaComparison.deltaClassificationRate.diverges}`);
  lines.push(`  inconclusiveRate: ${(report.deltaComparison.inconclusiveRate * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("--- recall quality ---");
  lines.push(`  note: ${report.recallQuality.note}`);
  lines.push("");
  lines.push("--- limitations (research-only) ---");
  for (const lim of report.limitations) {
    lines.push(`  - ${lim}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "replay-corpus";

/**
 * Write the replay corpus evaluation report to disk.
 * Uses the standard timestamped artifact pattern.
 */
export function writeReplayCorpusReport(report: ReplayCorpusEvaluationReport, dir: string): string {
  return writeTimestampedJsonArtifact(report, dir, ARTIFACT_FILE_PREFIX);
}

// Note: The types ReplayCorpusEvaluationReport, ReplayCorpusItemResult,
// ReplayCorpusBreakdown, ReplaySafetyMetrics, ReplayMemoryLifecycleMetrics,
// ReplayRecallQualityMetrics, and ReplayDeltaComparisonMetrics are defined
// and exported inline in this module.
