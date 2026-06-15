/**
 * Benchmark-only no-answer abstention / calibration
 * experiment runner.
 *
 * The runner consumes a benchmark `QueryEval[]`
 * plus the audit's per-query `AbstentionSignals`
 * block plus the candidate-set sufficiency
 * label, and emits a `NoAnswerPolicyReport`.
 * The runner is a thin orchestrator: it does NOT
 * call any ranker, does NOT touch the production
 * `recall(text)` controller, does NOT change the
 * public MCP API, and does NOT change the existing
 * audit / calibration / diagnostic / policy
 * report shapes.
 *
 * What the runner does:
 *   1. Build the per-query input the policy
 *      evaluator needs (`buildNoAnswerPolicyPerQuery`).
 *   2. For every policy in the union of custom
 *      policies and `BUILTIN_NO_ANSWER_POLICIES`,
 *      evaluate the policy and compute the
 *      metric block
 *      (`evaluateNoAnswerPolicy` + `computeNoAnswerPolicyMetrics`).
 *   3. Render the human report and write the JSON
 *      artifact.
 *
 * Determinism:
 *   The runner is deterministic for a given
 *   (corpus, query set, per-query signals, candidate-set
 *   labels, fixture labels). The per-policy
 *   evaluation is pure; the human report's column
 *   order is fixed; the JSON artifact's `policies`
 *   array is in the same order as the union of
 *   `customPolicies` and `BUILTIN_NO_ANSWER_POLICIES`,
 *   filtered by `onlyPolicyIds` if present. The
 *   on-disk artifact is byte-stable for a fixed
 *   experiment config.
 *
 * Scope (benchmark-only):
 *   This module is read-only and never modifies
 *   the production `recall(text)` behavior, the
 *   public MCP API, or the existing audit /
 *   calibration / diagnostic / policy report
 *   shapes. The flag-only "abstain on the
 *   no-answer family" line is a research
 *   artifact, not a deployment policy.
 */

import fs from "node:fs";
import path from "node:path";

import type { QueryEval, AbstentionSignals } from "./metrics.js";
import type { SufficiencyLabel } from "./sufficiency-diagnostic.js";
import {
  buildNoAnswerPolicyPerQuery,
  runNoAnswerPolicyExperiment,
  type NoAnswerPolicyConfig,
  type NoAnswerPolicyReport,
} from "./no-answer-abstention.js";

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * The top-level runner. Consumes the inputs the
 * experiment needs and emits the
 * `NoAnswerPolicyReport`. The function is pure: no
 * I/O, no provider calls, no network. The CLI entry
 * point writes the artifact to disk; the function
 * itself is a pure orchestrator.
 */
export function runNoAnswerAbstentionExperiment(args: {
  evals: ReadonlyArray<QueryEval>;
  signalsByQueryId: ReadonlyMap<string, AbstentionSignals>;
  sufficiencyLabelByQueryId: ReadonlyMap<string, SufficiencyLabel>;
  recordCount: number;
  config?: NoAnswerPolicyConfig;
  /**
   * Optional, additive: an explicit
   * `queryId -> labels[]` map. The fields flow
   * through to the per-decision `queryLabels` so
   * a reviewer can audit which labeled subset a
   * per-query decision is associated with. The
   * map is empty by default (the
   * backward-compatible default).
   */
  labelsByQueryId?: ReadonlyMap<string, string[]>;
}): NoAnswerPolicyReport {
  const perQuery = buildNoAnswerPolicyPerQuery({
    evals: args.evals,
    signalsByQueryId: args.signalsByQueryId,
    sufficiencyLabelByQueryId: args.sufficiencyLabelByQueryId,
    labelsByQueryId: args.labelsByQueryId ?? new Map(),
  });
  return runNoAnswerPolicyExperiment({
    recordCount: args.recordCount,
    perQuery,
    ...(args.config !== undefined ? { config: args.config } : {}),
  });
}

// Re-export the human formatter at the runner
// surface so the CLI does not have to import both
// modules separately. The formatter is the
// canonical human-readable view; the JSON artifact
// is the canonical machine-readable view.
export { formatNoAnswerPolicyReport } from "./no-answer-abstention.js";

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-no-answer-abstention";

/**
 * Write a no-answer abstention experiment report to
 * disk. The file prefix is
 * `retrieval-no-answer-abstention-*.json`
 * (distinct from the existing audit / policy /
 * diagnostic / benchmark / calibration prefixes)
 * so a reviewer can find the experiment
 * artifacts next to the regular reports without
 * confusing them. The timestamp is the current
 * ISO timestamp with `:` / `.` replaced by `-` so
 * the filename is safe across shells.
 */
export function writeNoAnswerAbstentionReport(
  report: NoAnswerPolicyReport,
  dir: string,
): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ARTIFACT_FILE_PREFIX}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}
