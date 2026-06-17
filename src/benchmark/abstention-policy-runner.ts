/**
 * Benchmark-only multi-signal abstention policy runner.
 *
 * The runner consumes a benchmark `QueryEval[]`
 * (with the per-query `AbstentionSignals` block the
 * audit runner produces) and emits a
 * `AbstentionPolicyReport`. The runner is a thin
 * orchestrator: it does NOT call any ranker, does NOT
 * touch the production `recall(text)` controller,
 * does NOT change the public MCP API, and does NOT
 * change the existing audit / calibration / benchmark
 * report shapes.
 *
 * What the runner does:
 *   1. Build the per-query input the policy evaluator
 *      needs (`buildPolicyPerQuery`).
 *   2. For every policy in `BUILTIN_POLICIES`,
 *      evaluate the policy and compute the metric
 *      block (`evaluatePolicy` + `computePolicyMetrics`).
 *   3. Render the human report and write the JSON
 *      artifact.
 *
 * The runner is reachable through the benchmark
 * runner CLI via `--abstention-policy`. The CLI
 * flag is independent of `--abstention-audit`: the
 * policy evaluator consumes the per-query signal
 * block the audit runner attaches, so a run that
 * wants the policy report should also pass
 * `--abstention-audit` (the policy runner re-uses
 * the audit's per-query signal block from the
 * already-attached `abstentionSignals` field). The
 * flag is independent so a caller who already has
 * a `HybridBenchmarkReport` (with the audit's
 * signals) can run only the policy evaluator.
 *
 * Determinism: the runner is deterministic for a
 * given (corpus, query set, embedder, variant,
 * hybridK). The per-policy evaluation is pure; the
 * human report's column order is fixed; the JSON
 * artifact's `policies` array is in the same order
 * as `BUILTIN_POLICIES` so byte-equal comparisons
 * are stable.
 *
 * Scope (benchmark-only):
 *   This module is read-only and never modifies the
 *   production `recall(text)` behavior, the public
 *   MCP API, or the existing audit / calibration
 *   report shapes. The flag-only "abstain on a
 *   hard-negative" line is a research artifact, not
 *   a deployment policy. The recommended moderate
 *   policy's gains rely partly on the fixture-
 *   correlated `isFalsePremiseLike` flag, so the
 *   policy evaluator reports the per-family damage
 *   honestly and the README labels the recommended
 *   policy as research-only / fixture-dependent.
 */

import fs from "node:fs";
import path from "node:path";

import type { AbstentionSignals, QueryEval } from "./metrics.js";
import {
  BUILTIN_POLICIES,
  buildPolicyPerQuery,
  computePolicyMetrics,
  evaluatePolicy,
  type AbstentionPolicy,
  type PolicyDecision,
  type PolicyMetrics,
} from "./abstention-policy.js";

// ---------------------------------------------------------------------------
// Top-level config + result shapes
// ---------------------------------------------------------------------------

/**
 * Top-level policy-evaluator config. The defaults
 * cover the standard set of built-in policies. A
 * reviewer who wants a custom policy set can pass
 * a list of policy descriptors; the runner
 * iterates over the union of `policies` and
 * `BUILTIN_POLICIES` (custom policies first, so
 * they appear at the top of the report).
 */
export interface AbstentionPolicyConfig {
  /** Custom policy list, evaluated in addition to
   *  (and before) the built-in policies. The custom
   *  policies are evaluated first in the order
   *  given; the built-in policies follow. The
   *  `policyId` is the policy's `id` field, used
   *  as the artifact key. */
  customPolicies?: ReadonlyArray<AbstentionPolicy>;
  /**
   * Restrict the report to a subset of policies by
   * `id`. The default is to include all built-in
   * policies + any custom policies. The filter
   * applies to BOTH the built-in and custom
   * policies (so a reviewer can run only the four
   * primary policies, for example).
   */
  onlyPolicyIds?: ReadonlyArray<string>;
}

/**
 * One entry in the per-query FP / FN lists on the
 * artifact. The shape mirrors the
 * `PolicyMetrics.falsePositives` /
 * `PolicyMetrics.falseNegatives` shape, kept here
 * as a named type for the artifact schema.
 */
export interface PolicyFailingQuery {
  queryId: string;
  family: string;
  reason: string;
}

/**
 * One row on the report's policy frontier table.
 * The shape is the same as `PolicyMetrics` plus a
 * short human-readable label. The runner emits one
 * row per policy evaluated.
 */
export interface PolicyRow extends PolicyMetrics {
  description: string;
  category: "primary" | "ablation";
}

/**
 * The top-level policy-evaluator report. The on-disk
 * artifact is one of these. The shape is intentionally
 * distinct from the audit / calibration / benchmark
 * report shapes: the policy evaluator is a study of
 * how a *rule*, not a *signal*, behaves under a
 * fixture corpus. The two artifacts are different
 * tools for different questions.
 */
export interface AbstentionPolicyReport {
  generatedAt: string;
  config: {
    recordCount: number;
    queryCount: number;
    total: number;
    noAnswerCount: number;
    positiveCount: number;
    variant: string;
    policyCount: number;
    builtinPolicyCount: number;
    customPolicyCount: number;
  };
  /**
   * One row per evaluated policy. The order is
   * (custom policies first, in `customPolicies`
   * order) followed by (built-in policies, in
   * `BUILTIN_POLICIES` order), filtered by
   * `onlyPolicyIds` if present.
   */
  policies: PolicyRow[];
  /**
   * The per-query input the policy evaluator
   * consumed. The block is on the artifact so a
   * reviewer can re-derive any policy by hand.
   * The signals block is included verbatim so a
   * reviewer who wants to add a custom policy can
   * do so without re-running the audit.
   */
  perQuery: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
    rank1: boolean;
    currentTruthAt1: boolean;
    hitAt5: boolean;
    /**
     * Optional, additive: the query's explicit
     * adversarial labels. The field flows through
     * to the per-decision `queryLabels` so a
     * reviewer can audit which labeled subset a
     * per-query decision is associated with. The
     * field is `undefined` for queries that have
     * no explicit labels (the backward-compatible
     * default).
     */
    queryLabels?: string[];
  }>;
  /**
   * The full per-policy per-query decisions. The
   * block is on the artifact so a reviewer can
   * audit which gate fired on which query without
   * re-evaluating. The block is large (~15k
   * entries for a 96-query x 16-policy run); the
   * runner still includes it because the on-disk
   * artifact is for offline review, not for hot
   * consumption.
   */
  decisions: ReadonlyArray<{
    policyId: string;
    decisions: ReadonlyArray<PolicyDecision>;
  }>;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * The top-level policy-evaluator runner. Consumes a
 * `QueryEval[]` (with the audit's per-query signals
 * attached) and emits the `AbstentionPolicyReport`.
 * The function is pure: no I/O, no provider calls,
 * no network. The CLI entry point writes the
 * artifact to disk; the function itself is a pure
 * orchestrator.
 */
export function runAbstentionPolicy(args: {
  variant: string;
  evals: ReadonlyArray<QueryEval>;
  signalsByQueryId: ReadonlyMap<string, AbstentionSignals>;
  config?: AbstentionPolicyConfig;
  /**
   * Optional, additive: an explicit
   * `queryId -> labels[]` map. The fields flow
   * through to the per-decision `queryLabels`
   * so a reviewer can audit which labeled
   * subset a per-query decision is associated
   * with. The map is empty by default (the
   * backward-compatible default). The
   * adversarial-expansion corpus uses this to
   * surface the labeled adversarial property
   * subsets on the policy artifact.
   */
  labelsByQueryId?: ReadonlyMap<string, string[]>;
}): AbstentionPolicyReport {
  const { evals, signalsByQueryId, config = {}, labelsByQueryId } = args;
  const variant = args.variant;
  const perQuery = buildPolicyPerQuery(
    evals,
    signalsByQueryId,
    labelsByQueryId ?? new Map(),
  );
  // Build the policy list. The custom policies come
  // first (in the order given); the built-in policies
  // follow. The `onlyPolicyIds` filter, when set,
  // restricts the report to the named policies.
  const customPolicies = config.customPolicies ?? [];
  const builtinPolicies = BUILTIN_POLICIES;
  const filterIds = config.onlyPolicyIds
    ? new Set(config.onlyPolicyIds)
    : null;
  const policies: AbstentionPolicy[] = [];
  for (const p of customPolicies) {
    if (filterIds === null || filterIds.has(p.id)) {
      policies.push(p);
    }
  }
  for (const p of builtinPolicies) {
    if (filterIds === null || filterIds.has(p.id)) {
      policies.push(p);
    }
  }
  // Evaluate every policy and build the rows.
  const rows: PolicyRow[] = [];
  const decisionBlocks: Array<{
    policyId: string;
    decisions: PolicyDecision[];
  }> = [];
  for (const policy of policies) {
    const decisions = evaluatePolicy(policy, perQuery);
    const metrics = computePolicyMetrics(policy, decisions);
    rows.push({
      ...metrics,
      description: policy.description,
      category: policy.category,
    });
    decisionBlocks.push({ policyId: policy.id, decisions });
  }
  // Aggregate counts for the config block.
  let total = 0;
  let noAnswerCount = 0;
  let positiveCount = 0;
  for (const p of perQuery) {
    total += 1;
    if (p.isPositive) positiveCount += 1;
    else noAnswerCount += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    config: {
      recordCount: 0, // populated by the CLI from the report
      queryCount: evals.length,
      total,
      noAnswerCount,
      positiveCount,
      variant,
      policyCount: policies.length,
      builtinPolicyCount: builtinPolicies.filter(
        (p) => filterIds === null || filterIds.has(p.id),
      ).length,
      customPolicyCount: customPolicies.filter(
        (p) => filterIds === null || filterIds.has(p.id),
      ).length,
    },
    policies: rows,
    perQuery,
    decisions: decisionBlocks,
  };
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-abstention-policy";

/**
 * Write a policy-evaluator report to disk. The file
 * prefix is `retrieval-abstention-policy-*.json`
 * (distinct from the existing audit / benchmark /
 * calibration prefixes) so a reviewer can find the
 * policy artifacts next to the regular reports
 * without confusing them. The timestamp is the
 * current ISO timestamp with `:` / `.` replaced by
 * `-` so the filename is safe across shells.
 */
export function writeAbstentionPolicyReport(
  report: AbstentionPolicyReport,
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

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Format the policy-evaluator report as a
 * human-readable string. The report is intentionally
 * narrow: the headline policy frontier table, the
 * per-family positive abstention breakdown for the
 * recommended moderate policy, the per-query FP / FN
 * lists for the recommended moderate policy, and a
 * short honest-reading block the README references.
 *
 * The function is pure: same report -> same string.
 * The CLI entry point writes the string to stdout.
 */
export function formatAbstentionPolicyReport(
  report: AbstentionPolicyReport,
): string {
  const lines: string[] = [];
  lines.push("=== curion retrieval abstention policy ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- config ---");
  lines.push(`  variant:           ${report.config.variant}`);
  lines.push(`  total:             ${report.config.total}`);
  lines.push(`  no-answer:         ${report.config.noAnswerCount}`);
  lines.push(`  positive:          ${report.config.positiveCount}`);
  lines.push(
    `  policies evaluated:${String(report.config.policyCount).padStart(3)} ` +
      `(primary=${report.policies.filter((p) => p.category === "primary").length}, ` +
      `ablation=${report.policies.filter((p) => p.category === "ablation").length})`,
  );
  lines.push("");
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY study.");
  lines.push(
    "  The policy evaluator tests how a set of rule-based",
  );
  lines.push(
    "  abstention policies behave on the fixture corpus. The",
  );
  lines.push(
    "  policies are NOT wired into the production `recall(text)`",
  );
  lines.push(
    "  controller, the public MCP API, or the existing audit /",
  );
  lines.push(
    "  calibration report shapes. The recommended moderate policy's",
  );
  lines.push(
    "  gains rely partly on the fixture-correlated",
  );
  lines.push(
    "  `isFalsePremiseLike` query-shape flag, so this is",
  );
  lines.push(
    "  research-only / fixture-dependent; do NOT generalise",
  );
  lines.push(
    "  the policy beyond the current fixture corpus without",
  );
  lines.push(
    "  re-evaluating on a new corpus.",
  );
  lines.push("");
  // ---- Headline policy frontier table ----
  lines.push("--- policy frontier ---");
  lines.push(
    "  policy                       TNR%   posAbst%  hit5Ret%  rank1Ret%  curT1Ret%  P     R     F1    | gate counts (score/agree/hN/fP)",
  );
  for (const row of report.policies) {
    const policyLabel = row.policyId.length > 28
      ? row.policyId.slice(0, 25) + "..."
      : row.policyId;
    lines.push(
      `  ${policyLabel.padEnd(28)}` +
        ` ${(row.noAnswerAbstainedRate * 100).toFixed(1).padStart(5)}` +
        `   ${(row.positiveAbstainedRate * 100).toFixed(1).padStart(5)}` +
        `    ${(row.hitAt5RetainedRate * 100).toFixed(1).padStart(5)}` +
        `     ${(row.rank1RetainedRate * 100).toFixed(1).padStart(5)}` +
        `      ${(row.currentTruthAt1RetainedRate * 100).toFixed(1).padStart(5)}` +
        `   ${row.precision.toFixed(2)}  ${row.recall.toFixed(2)}  ${row.f1.toFixed(2)}` +
        `    | ${String(row.gateCounts.score).padStart(2)}/${String(row.gateCounts.agreement).padStart(2)}/${String(row.gateCounts.hardNeg).padStart(2)}/${String(row.gateCounts.falsePrem).padStart(2)}`,
    );
  }
  lines.push("");
  lines.push(
    "  TNR%        = no-answer queries the policy abstained on (TNR equivalent).",
  );
  lines.push(
    "  posAbst%    = positive queries the policy abstained on (a damage metric).",
  );
  lines.push(
    "  hit5Ret%    = hit@5 retained on positive queries (vs un-gated baseline).",
  );
  lines.push(
    "  rank1Ret%   = rank1 retained on positive queries.",
  );
  lines.push(
    "  curT1Ret%   = currentTruthAt1 retained on positive queries.",
  );
  lines.push(
    "  P/R/F1      = precision / recall / F1 on the 'should-abstain' binary",
  );
  lines.push(
    "                task with `isNoAnswer` as the positive class.",
  );
  lines.push(
    "  gate counts = number of queries that triggered the score / agreement /",
  );
  lines.push(
    "                hardNeg / falsePrem gate (a query that triggered two",
  );
  lines.push(
    "                gates contributes to both buckets).",
  );
  lines.push("");
  // ---- Per-family positive abstention breakdown for the recommended policy ----
  const recommended = report.policies.find(
    (p) => p.policyId === "moderate-score-0.40",
  );
  if (recommended) {
    lines.push("--- per-family positive abstention (recommended: moderate-score-0.40) ---");
    lines.push(
      "  family           total  abstained  rate   notes",
    );
    const familyOrder = Object.keys(recommended.positiveAbstainedByFamily).sort();
    for (const family of familyOrder) {
      const slot = recommended.positiveAbstainedByFamily[family]!;
      const note = slot.abstained > 0
        ? flagNotesForFamily(family, recommended.falsePositives)
        : "no positive abstentions on this family";
      lines.push(
        `  ${family.padEnd(16)} ${String(slot.total).padStart(4)}    ${String(slot.abstained).padStart(4)}     ${(slot.rate * 100).toFixed(1).padStart(4)}%   ${note}`,
      );
    }
    lines.push("");
  }
  // ---- Per-query FP / FN lists for the recommended policy ----
  if (recommended) {
    lines.push("--- recommended policy: false positives (positive queries wrongly abstained) ---");
    if (recommended.falsePositives.length === 0) {
      lines.push("  (none)");
    } else {
      // Build a per-queryId -> labels map from the
      // perQuery block so the FP / FN lists can show
      // the explicit adversarial label alongside the
      // reason. A reviewer who wants to audit "which
      // labeled paraphrases / near-misses / divergent
      // temporals the recommended policy abstained on"
      // reads this column.
      const labelsByQueryId = new Map<string, string[]>();
      for (const p of report.perQuery) {
        if (p.queryLabels && p.queryLabels.length > 0) {
          labelsByQueryId.set(p.queryId, p.queryLabels);
        }
      }
      for (const fp of recommended.falsePositives) {
        const labels = labelsByQueryId.get(fp.queryId);
        const labelStr =
          labels && labels.length > 0 ? `  labels=${labels.join("|")}` : "";
        lines.push(
          `  [${fp.family}] ${fp.queryId}  reason=${fp.reason}${labelStr}`,
        );
      }
    }
    lines.push("");
    lines.push("--- recommended policy: false negatives (no-answer queries wrongly retained) ---");
    if (recommended.falseNegatives.length === 0) {
      lines.push("  (none)");
    } else {
      const labelsByQueryId = new Map<string, string[]>();
      for (const p of report.perQuery) {
        if (p.queryLabels && p.queryLabels.length > 0) {
          labelsByQueryId.set(p.queryId, p.queryLabels);
        }
      }
      for (const fn of recommended.falseNegatives) {
        const labels = labelsByQueryId.get(fn.queryId);
        const labelStr =
          labels && labels.length > 0 ? `  labels=${labels.join("|")}` : "";
        lines.push(
          `  [${fn.family}] ${fn.queryId}  reason=${fn.reason}${labelStr}`,
        );
      }
    }
    lines.push("");
  }
  // ---- Honest reading block ----
  lines.push("--- honest reading ---");
  lines.push(
    "  The flag-only baseline (`flag-only-zero-hit-cost`) abstains on the",
  );
  lines.push(
    "  query-shape-flag subset of no-answer queries. It is the cheap, low-",
  );
  lines.push(
    "  cost line; positive abstention rate is exactly the false-premise /",
  );
  lines.push(
    "  hard-negative flag's positive-query false-positive rate (low on this",
  );
  lines.push(
    "  fixture, but the gains on no-answer TNR are also low).",
  );
  lines.push(
    "  The recommended moderate policy adds the score gate (meanContributor",
  );
  lines.push(
    "  Score < 0.40 OR hardNeg OR falsePrem) and reaches a much higher TNR",
  );
  lines.push(
    "  at the cost of a non-trivial positive abstention rate. The cost is",
  );
  lines.push(
    "  concentrated on paraphrase and orientation queries; the per-family",
  );
  lines.push(
    "  table above shows where the damage is. The score gate's contribution",
  );
  lines.push(
    "  is mostly from the contributor-score distribution on paraphrases",
  );
  lines.push(
    "  (a paraphrase query can have a high lexical / FTS5 score and a low",
  );
  lines.push(
    "  vector-dense score, and the mean lands in the abstention band).",
  );
  lines.push(
    "  The aggressive full-catch policy (0.50 threshold, no false-premise",
  );
  lines.push(
    "  flag) catches more no-answer queries but inflicts more damage on",
  );
  lines.push(
    "  answerable queries. It is reported as a stress-test, not a",
  );
  lines.push(
    "  recommendation.",
  );
  lines.push(
    "  The score-only and agreement-only ablations show what each gate",
  );
  lines.push(
    "  contributes on its own. The agreement gate is a weak-signal",
  );
  lines.push(
    "  ablation; on a fixture where the ranker always populates the",
  );
  lines.push(
    "  contributor block with all three sources, the agreement-count",
  );
  lines.push(
    "  signal is a much weaker separator than the score gate.",
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Build a short per-family note the human report
 * uses to describe why the family took the damage it
 * did. The note is intentionally short: the report
 * is for a reviewer who already understands the
 * families; the per-query FP list below the table
 * carries the per-query evidence.
 */
function flagNotesForFamily(
  family: string,
  falsePositives: ReadonlyArray<{ queryId: string; family: string; reason: string }>,
): string {
  const fpInFamily = falsePositives.filter((fp) => fp.family === family);
  const reasons = new Set(fpInFamily.map((fp) => fp.reason));
  const reasonList = [...reasons].sort().join(", ");
  if (family === "paraphrase") {
    return `paraphrase queries can have a low vector-dense contributor score while the lexical / FTS5 score is high; the mean lands in the abstention band. reasons: ${reasonList || "n/a"}`;
  }
  if (family === "orientation") {
    return `orientation queries include project-status lookups with low per-source scores when the relevant memory is a multi-fact record; the score gate fires on the mean. reasons: ${reasonList || "n/a"}`;
  }
  if (family === "exact") {
    return `exact queries should not normally trip the score gate; check the FP list for outliers. reasons: ${reasonList || "n/a"}`;
  }
  if (family === "temporal") {
    return `temporal queries can have a low vector-dense score when the old fact dominates one of the contributors; the mean lands in the abstention band. reasons: ${reasonList || "n/a"}`;
  }
  if (family === "multi-hop") {
    return `multi-hop queries can have a low mean contributor score when no single contributor is strongly relevant. reasons: ${reasonList || "n/a"}`;
  }
  return `reasons: ${reasonList || "n/a"}`;
}
