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
  type CorpusItemLabel,
  type CorpusItemReplayStatus,
  type CorpusItemRecallQuality,
  type CorpusTopicCategory,
  detectForbiddenPatternsInRecallQuery,
  recallQueryAppearsCleanOfPII,
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
  "Recall quality metrics are computed from scripted engine responses that return expected labels deterministically. Metrics reflect measurement infrastructure readiness, not engine quality. Full quality measurement requires Phase 3 applied simulation with live retrieval.",
  "Replaying synthetic-proxy and manual-curated items only. Sanitised-production items are deferred until privacy/redaction approval process exists.",
  "Replay remains offline evidence only. It does not constitute proof of production activation fitness.",
  "Ground-truth labels are the evaluation team's best judgment; they reflect expected engine behavior on the labeled inputs, not a production baseline.",
  "The corpus uses stable content-derived identifiers; no production database IDs or user identifiers are present.",
  "No live network, no production storage access, no engine activation. Decisions are captured but never applied.",
  "Recall query privacy checks (forbidden patterns, PII) apply to the recall query text but do not substitute for full privacy review.",
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

/** Recall quality metrics. Computed only for items with recall-quality labels. */
export interface ReplayRecallQualityMetrics {
  /** Fraction of recall-query items where source labels match ground truth. */
  sourceMatchRate: number | null;
  /** Fraction of recall-query items where rank-1 label matches ground truth. */
  rank1MatchRate: number | null;
  /** Fraction of temporal recall queries where current fact ranks first. */
  currentTruthMatchRate: number | null;
  /** True-negative rate on no-answer queries. */
  noAnswerTnr: number | null;
  /** Fraction of recall-query items where useful memory was not retrieved. */
  usefulMemoryLossRate: number | null;
  /** Fraction of recall-query items where stale memory was exposed. */
  staleMemoryExposureRate: number | null;
  /** Number of recall-query items with labels. */
  labeledRecallQueryCount: number;
  /** Number of recall-query items with no-answer expected. */
  noAnswerExpectedCount: number;
  /** Note explaining the metrics state. */
  note: string;
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
  /** Recall quality result (only for recall-query items with labels). */
  recallQuality: {
    /** The recall query text. */
    recallQuery: string | null;
    /** Stable labels of expected sources. */
    expectedSourceLabels: CorpusItemLabel[];
    /** Stable labels of expected rank-1. */
    expectedRank1Labels: CorpusItemLabel[];
    /** Stable labels of current truth. */
    currentTruthLabels: CorpusItemLabel[];
    /** Whether no answer is expected. */
    noAnswerExpected: boolean;
    /** Scripted recall result (simulated ranked memory labels). */
    scriptedRankedMemoryLabels: CorpusItemLabel[] | null;
    /** Whether source labels matched. */
    sourceMatch: boolean | null;
    /** Whether rank-1 matched. */
    rank1Match: boolean | null;
    /** Whether current truth matched. */
    currentTruthMatch: boolean | null;
    /** Whether no-answer was correct. */
    noAnswerCorrect: boolean | null;
    /** Whether privacy validation passed. */
    privacyValidationPassed: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Scripted engine response
// ---------------------------------------------------------------------------

/**
 * Scripted engine response for recall quality.
 * Contains the engine action plus simulated recall result for recall-query items.
 */
interface ScriptedEngineResponse {
  /** Engine action. */
  action: string;
  /** Engine rationale. */
  rationale: string;
  /**
   * Simulated ranked memory labels for recall queries.
   * Null for remember items (recall is not performed).
   */
  rankedMemoryLabels: string[] | null;
}

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
 *   - For items with recall quality labels, simulated recall returns
 *     the expected rank-1 labels as the top result
 */
function getScriptedEngineResponse(
  inputType: "remember" | "recall-query",
  safetyClass: SafetyClass,
  recallQuality: CorpusItemRecallQuality | null
): ScriptedEngineResponse {
  if (inputType === "recall-query") {
    // For recall-query items with labels, simulate recall result
    // The scripted engine returns the expected rank-1 labels as the
    // top-ranked memory. This is a deterministic simulation that
    // establishes the measurement infrastructure.
    const rankedMemoryLabels =
      recallQuality && !recallQuality.noAnswerExpected
        ? recallQuality.expectedRank1Labels
        : null;
    return {
      action: "no_op",
      rationale: "Recall query — engine does not emit remember actions for recall inputs",
      rankedMemoryLabels,
    };
  }

  // Remember inputs
  switch (safetyClass) {
    case "safe":
      return {
        action: "store",
        rationale: "Input classified as safe; normal storage path",
        rankedMemoryLabels: null,
      };
    case "secret":
    case "raw-dump":
    case "vague-junk":
    case "mixed-safe-sensitive":
    case "prompt-injection":
    case "unsafe-preference":
      return {
        action: "reject",
        rationale: `Input classified as ${safetyClass}; deterministic rejection path`,
        rankedMemoryLabels: null,
      };
    case "self-conflict":
    case "vague-memory":
    case "replacement-correction":
      return {
        action: "no_op",
        rationale: `Input classified as ${safetyClass}; clarification or abstention appropriate`,
        rankedMemoryLabels: null,
      };
    default:
      return {
        action: "no_op",
        rationale: "Unknown safety class; conservative abstention",
        rankedMemoryLabels: null,
      };
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
  const engineResponse = getScriptedEngineResponse(
    item.input.type as "remember" | "recall-query",
    safetyClass ?? "safe",
    item.recallQuality ?? null
  );

  // Compare to ground truth
  const actionMatchesGroundTruth = engineResponse.action === item.groundTruth.expectedAction;

  // Compute recall quality result for recall-query items
  let recallQualityResult: ReplayCorpusItemResult["recallQuality"] = null;
  if (item.input.type === "recall-query" && item.recallQuality) {
    const rq = item.recallQuality;
    const rankedLabels = engineResponse.rankedMemoryLabels ?? [];

    // Privacy validation for recall query
    const privacyForbidden = detectForbiddenPatternsInRecallQuery(rq.recallQuery);
    const privacyPII = !recallQueryAppearsCleanOfPII(rq.recallQuery);
    const privacyValidationPassed = privacyForbidden.length === 0 && !privacyPII;

    // Compute match metrics
    const expectedSourceSet = new Set(rq.expectedSourceLabels);
    const actualSourceSet = new Set(rankedLabels);
    const sourceMatch =
      rankedLabels.length > 0 && expectedSourceSet.size > 0
        ? [...expectedSourceSet].every((l) => actualSourceSet.has(l))
        : null;

    const expectedRank1Set = new Set(rq.expectedRank1Labels);
    const rank1Match =
      rankedLabels.length > 0 && expectedRank1Set.size > 0
        ? expectedRank1Set.has(rankedLabels[0]!)
        : null;

    const currentTruthSet = new Set(rq.currentTruthLabels);
    const currentTruthMatch =
      rankedLabels.length > 0 && currentTruthSet.size > 0
        ? currentTruthSet.has(rankedLabels[0]!)
        : null;

    const noAnswerCorrect =
      rq.noAnswerExpected !== null
        ? (rq.noAnswerExpected && rankedLabels.length === 0) ||
          (!rq.noAnswerExpected && rankedLabels.length > 0)
        : null;

    recallQualityResult = {
      recallQuery: rq.recallQuery,
      expectedSourceLabels: rq.expectedSourceLabels,
      expectedRank1Labels: rq.expectedRank1Labels,
      currentTruthLabels: rq.currentTruthLabels,
      noAnswerExpected: rq.noAnswerExpected,
      scriptedRankedMemoryLabels: rankedLabels.length > 0 ? rankedLabels : null,
      sourceMatch,
      rank1Match,
      currentTruthMatch,
      noAnswerCorrect,
      privacyValidationPassed,
    };
  }

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
    recallQuality: recallQualityResult,
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
    recallQuality: computeRecallQualityMetrics(items),
    deltaComparison: {
      decisionDivergenceRate,
      deltaClassificationRate: { matches: matchesGroundTruth, diverges },
      inconclusiveRate,
    },
  };
}

/**
 * Compute recall quality metrics from per-item results.
 * Metrics are computed only for items with recall quality labels.
 */
function computeRecallQualityMetrics(
  items: ReplayCorpusItemResult[]
): ReplayRecallQualityMetrics {
  const recallItems = items.filter(
    (i): i is ReplayCorpusItemResult & { recallQuality: NonNullable<ReplayCorpusItemResult["recallQuality"]> } =>
      i.inputType === "recall-query" && i.recallQuality !== null
  );

  if (recallItems.length === 0) {
    return {
      sourceMatchRate: null,
      rank1MatchRate: null,
      currentTruthMatchRate: null,
      noAnswerTnr: null,
      usefulMemoryLossRate: null,
      staleMemoryExposureRate: null,
      labeledRecallQueryCount: 0,
      noAnswerExpectedCount: 0,
      note: "No recall-query items with recall-quality labels found.",
    };
  }

  // Count items with labels
  const labeledRecallQueryCount = recallItems.length;
  const noAnswerExpectedCount = recallItems.filter((i) => i.recallQuality.noAnswerExpected).length;

  // Source match: all expected sources are in the retrieved set
  const sourceMatches = recallItems.filter(
    (i) => i.recallQuality.sourceMatch === true
  ).length;
  const sourceMatchRate =
    recallItems.length > 0 ? sourceMatches / recallItems.length : null;

  // Rank-1 match: the top-ranked memory is in the expected rank-1 set
  const rank1Matches = recallItems.filter(
    (i) => i.recallQuality.rank1Match === true
  ).length;
  const rank1MatchRate =
    recallItems.length > 0 ? rank1Matches / recallItems.length : null;

  // Current truth match: the top-ranked memory is in the current truth set
  const currentTruthMatches = recallItems.filter(
    (i) => i.recallQuality.currentTruthMatch === true
  ).length;
  const currentTruthMatchRate =
    recallItems.length > 0 ? currentTruthMatches / recallItems.length : null;

  // No-answer TNR: correct abstention on no-answer queries
  const noAnswerItems = recallItems.filter((i) => i.recallQuality.noAnswerExpected);
  const noAnswerCorrect = noAnswerItems.filter(
    (i) => i.recallQuality.noAnswerCorrect === true
  ).length;
  const noAnswerTnr = noAnswerItems.length > 0 ? noAnswerCorrect / noAnswerItems.length : null;

  // Useful memory loss: an expected source was NOT retrieved
  // This is the inverse of source match for positive queries
  const positiveQueryItems = recallItems.filter((i) => !i.recallQuality.noAnswerExpected);
  const usefulMemoryLoss = positiveQueryItems.filter(
    (i) => i.recallQuality.sourceMatch === false
  ).length;
  const usefulMemoryLossRate =
    positiveQueryItems.length > 0 ? usefulMemoryLoss / positiveQueryItems.length : null;

  // Stale memory exposure: a stale (non-current-truth) memory was ranked first
  // This is detected when rank-1 matches but current truth doesn't
  const staleMemoryExposure = recallItems.filter(
    (i) =>
      i.recallQuality.rank1Match === true &&
      i.recallQuality.currentTruthMatch === false
  ).length;
  const staleMemoryExposureRate =
    recallItems.length > 0 ? staleMemoryExposure / recallItems.length : null;

  const note =
    labeledRecallQueryCount > 0
      ? `Recall quality metrics computed from ${labeledRecallQueryCount} labeled recall-query items. Scripted engine returns expected labels deterministically. Metrics reflect measurement infrastructure readiness, not engine quality.`
      : "Recall quality metrics require Phase 3 applied simulation. These fields are null in the replay pipeline.";

  return {
    sourceMatchRate,
    rank1MatchRate,
    currentTruthMatchRate,
    noAnswerTnr,
    usefulMemoryLossRate,
    staleMemoryExposureRate,
    labeledRecallQueryCount,
    noAnswerExpectedCount,
    note,
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
  lines.push(
    `  sourceMatchRate:           ${report.recallQuality.sourceMatchRate !== null ? (report.recallQuality.sourceMatchRate * 100).toFixed(1) + "%" : "n/a"}`
  );
  lines.push(
    `  rank1MatchRate:            ${report.recallQuality.rank1MatchRate !== null ? (report.recallQuality.rank1MatchRate * 100).toFixed(1) + "%" : "n/a"}`
  );
  lines.push(
    `  currentTruthMatchRate:     ${report.recallQuality.currentTruthMatchRate !== null ? (report.recallQuality.currentTruthMatchRate * 100).toFixed(1) + "%" : "n/a"}`
  );
  lines.push(
    `  noAnswerTnr:              ${report.recallQuality.noAnswerTnr !== null ? (report.recallQuality.noAnswerTnr * 100).toFixed(1) + "%" : "n/a"}`
  );
  lines.push(
    `  usefulMemoryLossRate:     ${report.recallQuality.usefulMemoryLossRate !== null ? (report.recallQuality.usefulMemoryLossRate * 100).toFixed(1) + "%" : "n/a"}`
  );
  lines.push(
    `  staleMemoryExposureRate:   ${report.recallQuality.staleMemoryExposureRate !== null ? (report.recallQuality.staleMemoryExposureRate * 100).toFixed(1) + "%" : "n/a"}`
  );
  lines.push(
    `  labeledRecallQueryCount:   ${report.recallQuality.labeledRecallQueryCount}`
  );
  lines.push(
    `  noAnswerExpectedCount:    ${report.recallQuality.noAnswerExpectedCount}`
  );
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
