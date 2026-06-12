/**
 * Benchmark-only abstention-signal audit runner.
 *
 * The runner consumes a `QueryEval[]` (the standard
 * benchmark output) and emits an
 * `AbstentionAuditReport`. The runner is a thin
 * orchestrator: it does NOT call any ranker, does NOT
 * touch the production `recall(text)` controller,
 * does NOT change the public MCP API, and does NOT
 * change the existing benchmark / calibration report
 * shapes.
 *
 * What the runner does:
 *   1. Build the per-record token sets (cached once
 *      per run).
 *   2. Run the query-shape detector on every query
 *      and attach the flags to the per-query
 *      `AbstentionSignals` block.
 *   3. Build the per-query abstention signals from
 *      the per-query eval (top-1 score, gap, ratio,
 *      returned count, hybrid contributor block).
 *   4. Compute the headline "all" slice (every
 *      query) and a small set of stable per-family /
 *      per-shape slices.
 *   5. Compute the per-signal AUROC, risk-coverage
 *      curve, coverage-at-risk, risk-at-coverage
 *      summaries.
 *   6. Pick the most / least confident queries
 *      (no-answer / positive) so the human report
 *      can show honest per-query examples.
 *   7. Render the human report and write the JSON
 *      artifact.
 *
 * CLI dispatch: the runner is reachable through the
 * benchmark runner CLI via
 * `npm run benchmark:retrieval:abstention-audit`. The
 * CLI flags mirror the existing dense CLI flags
 * (`--variant vector-dense | hybrid-dense |
 * all-dense`, `--embedder stub-dense | transformersjs`,
 * `--dense-skip`). The output is the abstention-audit
 * report, NOT the regular dense benchmark report.
 *
 * Determinism: the runner is deterministic for a
 * given (corpus, query set, embedder, variant,
 * hybridK). The shapes the audit studies come from
 * the ranker output (which is deterministic for a
 * given embedder); the AUROC / risk-coverage / slice
 * math is pure; the per-query example selection is
 * pure. The CLI entry point writes a timestamped
 * artifact under `.cortex/benchmark/`; the on-disk
 * shape is byte-stable for a fixed audit config.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type AbstentionSignals,
  type QueryEval,
} from "./metrics.js";
import {
  type AuditSlice,
  type AbstentionAuditConfig,
  type AbstentionAuditReport,
  type AuditPerQueryExamples,
  auditSlice,
  AUDIT_SIGNAL_NAMES,
} from "./abstention-audit.js";
import {
  detectQueryShape,
  buildCorpusTokenSets,
  type QueryShapeFlags,
} from "./query-shapes.js";
import type { BenchmarkQuery } from "./queries.js";
import type { BenchmarkMemoryRecord } from "./corpus.js";

// ---------------------------------------------------------------------------
// Per-query signal builder
// ---------------------------------------------------------------------------

/**
 * Build the `AbstentionSignals` block for a single
 * per-query eval. The function is pure. It consumes
 * the per-query eval + the per-query benchmark query
 * + the query-shape flags and emits the audit's
 * per-query signal block.
 *
 * The contributor signals (min / max / mean RRF rank
 * and raw score) are derived from
 * `eval.hybridContributors` when present (the
 * `hybrid` / `hybrid-dense` run path attaches it).
 * On the single-variant runs the field is absent;
 * the contributor signals are `null` and the audit
 * surface reports "no contributor trace" for those
 * signals on those runs. A reviewer who wants the
 * contributor signals MUST run the audit on
 * `hybrid-dense`.
 */
export function buildAbstentionSignals(
  eval_: QueryEval,
  flags: QueryShapeFlags,
): AbstentionSignals {
  // ---- Retrieval signals (top score + gap + ratio) ----
  const topScore =
    eval_.topScores.length > 0 ? (eval_.topScores[0] ?? 0) : 0;
  const secondScore =
    eval_.topScores.length > 1 ? (eval_.topScores[1] ?? 0) : 0;
  const top1Top2Gap = topScore - secondScore;
  let top1Top2Ratio: number;
  if (topScore === 0 && secondScore === 0) top1Top2Ratio = 1.0;
  else if (secondScore === 0) top1Top2Ratio = Number.POSITIVE_INFINITY;
  else top1Top2Ratio = topScore / secondScore;
  const returnedCount = eval_.topIds.length;
  // ---- Hybrid contributor signals ----
  // The hybrid run attaches `hybridContributors` to the
  // per-query eval. The block is a list of
  // `{source, rank, score, contribution, weight}`
  // entries, one per source (lexical, fts5, vector /
  // vector-dense).
  let agreementCount = 0;
  let minContributorRank: number | null = null;
  let maxContributorRank: number | null = null;
  let meanContributorRank: number | null = null;
  let minContributorScore: number | null = null;
  let maxContributorScore: number | null = null;
  let meanContributorScore: number | null = null;
  let sourcePresence = "___";
  if (eval_.hybridContributors !== undefined) {
    const contribs = eval_.hybridContributors;
    // Count contributors that surfaced the candidate.
    let presentCount = 0;
    let rankSum = 0;
    let rankCount = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    let presence = "";
    for (const c of contribs) {
      if (c.rank !== null) {
        presentCount += 1;
        rankSum += c.rank;
        rankCount += 1;
        if (c.score !== null) {
          scoreSum += c.score;
          scoreCount += 1;
          if (minContributorScore === null || c.score < minContributorScore) {
            minContributorScore = c.score;
          }
          if (maxContributorScore === null || c.score > maxContributorScore) {
            maxContributorScore = c.score;
          }
        }
        if (minContributorRank === null || c.rank < minContributorRank) {
          minContributorRank = c.rank;
        }
        if (maxContributorRank === null || c.rank > maxContributorRank) {
          maxContributorRank = c.rank;
        }
      }
      // Presence pattern: `L` / `F` / `V` if the
      // source surfaced the candidate, `_` if not.
      const label =
        c.source === "lexical"
          ? "L"
          : c.source === "fts5"
            ? "F"
            : c.source === "vector"
              ? "V"
              : "V";
      presence += c.rank !== null ? label : "_";
    }
    agreementCount = presentCount;
    if (rankCount > 0) meanContributorRank = rankSum / rankCount;
    if (scoreCount > 0) meanContributorScore = scoreSum / scoreCount;
    sourcePresence = presence;
  }
  // ---- Query-shape flags ----
  return {
    topScore,
    top1Top2Gap,
    top1Top2Ratio,
    returnedCount,
    agreementCount,
    minContributorRank,
    maxContributorRank,
    meanContributorRank,
    minContributorScore,
    maxContributorScore,
    meanContributorScore,
    sourcePresence,
    isNoAnswerHardNegative: flags.isNoAnswerHardNegative,
    isTemporalCurrent: flags.isTemporalCurrent,
    isNegationLike: flags.isNegationLike,
    isOodEntityLike: flags.isOodEntityLike,
    isParaphraseTrap: flags.isParaphraseTrap,
    isFalsePremiseLike: flags.isFalsePremiseLike,
  };
}

// ---------------------------------------------------------------------------
// Slice construction
// ---------------------------------------------------------------------------

/**
 * Build the headline "all" slice (every query) and
 * the stable per-family / per-shape slices the audit
 * reports. The function is pure: same inputs ->
 * same slices. The order of slices in the output is
 * fixed ("all" first, then per-family, then per-shape)
 * so the on-disk JSON is byte-stable.
 */
export function buildSlices(
  perQuery: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
  }>,
  config: AbstentionAuditConfig,
): AuditSlice[] {
  const signals = perQuery.map((p) => p.signals);
  const labels: Array<0 | 1> = perQuery.map((p) => (p.isPositive ? 0 : 1));
  const opts = {
    ...(config.riskTargets !== undefined
      ? { riskTargets: config.riskTargets }
      : {}),
    ...(config.coverageTargets !== undefined
      ? { coverageTargets: config.coverageTargets }
      : {}),
  };
  const slices: AuditSlice[] = [];
  // "all" — every query.
  slices.push(
    auditSlice(
      "all",
      "Every query (the headline AUROC / risk-coverage reading).",
      signals,
      labels,
      opts,
    ),
  );
  // Per-family slices.
  const families = new Set<string>();
  for (const p of perQuery) families.add(p.family);
  const sortedFamilies = [...families].sort();
  for (const f of sortedFamilies) {
    const idx = perQuery
      .map((p, i) => (p.family === f ? i : -1))
      .filter((i) => i >= 0);
    if (idx.length === 0) continue;
    slices.push(
      auditSlice(
        `family:${f}`,
        `Per-family slice: family=${f}.`,
        idx.map((i) => signals[i]!),
        idx.map((i) => labels[i]!),
        opts,
      ),
    );
  }
  // Per-shape slices.
  const shapeSlices: Array<{
    name: string;
    description: string;
    predicate: (p: (typeof perQuery)[number]) => boolean;
  }> = [
    {
      name: "no-answer-easy",
      description:
        "No-answer queries that are NOT hard-negatives (the 'easy abstain' slice).",
      predicate: (p) => p.family === "no-answer" && !p.signals.isNoAnswerHardNegative,
    },
    {
      name: "no-answer-hard",
      description:
        "No-answer queries that ARE hard-negatives (the 'confabulation pressure' slice).",
      predicate: (p) => p.signals.isNoAnswerHardNegative,
    },
    {
      name: "temporal-divergent",
      description:
        "Temporal queries whose `expectedIds` does NOT equal `currentTruthIds` (the labeled divergent cases).",
      predicate: (p) =>
        p.family === "temporal" && queryIsDivergent(p.queryId, perQuery),
    },
    {
      name: "temporal-non-divergent",
      description:
        "Temporal queries whose `expectedIds` equals `currentTruthIds` (the non-divergent baseline).",
      predicate: (p) =>
        p.family === "temporal" && !queryIsDivergent(p.queryId, perQuery),
    },
    {
      name: "temporal-current",
      description:
        "Queries the temporal-current detector flagged (contain 'current' / 'now' / 'today' etc.).",
      predicate: (p) => p.signals.isTemporalCurrent,
    },
    {
      name: "negation-like",
      description:
        "Queries the negation detector flagged (contain 'not' / 'no' / 'never' etc.).",
      predicate: (p) => p.signals.isNegationLike,
    },
    {
      name: "ood-entity-like",
      description:
        "Queries the OOD-entity detector flagged (mention a tool the corpus does not have, and share tokens with a legacy record).",
      predicate: (p) => p.signals.isOodEntityLike,
    },
    {
      name: "paraphrase-trap",
      description:
        "Paraphrase-family queries (the known-bad lexical baseline case).",
      predicate: (p) => p.signals.isParaphraseTrap,
    },
    {
      name: "false-premise-like",
      description:
        "No-answer queries that mention a missing tool (a labeled false-premise case).",
      predicate: (p) => p.signals.isFalsePremiseLike,
    },
  ];
  for (const sh of shapeSlices) {
    const idx = perQuery
      .map((p, i) => (sh.predicate(p) ? i : -1))
      .filter((i) => i >= 0);
    if (idx.length === 0) continue;
    slices.push(
      auditSlice(
        sh.name,
        sh.description,
        idx.map((i) => signals[i]!),
        idx.map((i) => labels[i]!),
        opts,
      ),
    );
  }
  return slices;
}

/**
 * The list of labeled divergent temporal query ids.
 * The audit uses this list to slice the corpus into
 * "temporal-divergent" / "temporal-non-divergent".
 * The list is the same one the existing tests pin
 * (see `tests/retrieval-benchmark.test.ts`).
 */
export const DIVERGENT_TEMPORAL_IDS: ReadonlySet<string> = new Set([
  "temp-storage-raw-text",
  "temp-controller-validation",
]);

function queryIsDivergent(
  queryId: string,
  perQuery: ReadonlyArray<{ queryId: string }>,
): boolean {
  return DIVERGENT_TEMPORAL_IDS.has(queryId);
}

// ---------------------------------------------------------------------------
// Per-query examples
// ---------------------------------------------------------------------------

/**
 * Pick the most / least confident queries for the
 * "honest per-query examples" block. The
 * "confidence" is the `topScore` signal; the audit
 * surfaces the top 5 in each category. A reviewer
 * who wants to see "what does a high-signal
 * no-answer look like?" reads `mostConfidentNoAnswer`;
 * a reviewer who wants to see "what does a
 * low-signal positive look like?" reads
 * `leastConfidentPositive`.
 *
 * The selection is pure and deterministic. Ties on
 * `topScore` are broken by `queryId` ascending so
 * the selection is byte-stable.
 */
export function buildPerQueryExamples(
  perQuery: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
  }>,
  perSlice = 5,
): AuditPerQueryExamples {
  const positives = perQuery.filter((p) => p.isPositive);
  const noAnswers = perQuery.filter((p) => !p.isPositive);
  const sortByScore = (
    a: { signals: AbstentionSignals; queryId: string },
    b: { signals: AbstentionSignals; queryId: string },
  ): number => {
    if (a.signals.topScore !== b.signals.topScore) {
      return a.signals.topScore - b.signals.topScore;
    }
    return a.queryId.localeCompare(b.queryId);
  };
  const sortedNoAnswerLowToHigh = [...noAnswers].sort(sortByScore);
  const sortedNoAnswerHighToLow = [...noAnswers].sort((a, b) => -sortByScore(a, b));
  const sortedPositiveLowToHigh = [...positives].sort(sortByScore);
  const sortedPositiveHighToLow = [...positives].sort((a, b) => -sortByScore(a, b));
  return {
    mostConfidentNoAnswer: sortedNoAnswerHighToLow.slice(0, perSlice).map((p) => ({
      queryId: p.queryId,
      family: p.family,
      signals: p.signals,
    })),
    leastConfidentPositive: sortedPositiveLowToHigh.slice(0, perSlice).map((p) => ({
      queryId: p.queryId,
      family: p.family,
      signals: p.signals,
    })),
    leastConfidentNoAnswer: sortedNoAnswerLowToHigh.slice(0, perSlice).map((p) => ({
      queryId: p.queryId,
      family: p.family,
      signals: p.signals,
    })),
    mostConfidentPositive: sortedPositiveHighToLow.slice(0, perSlice).map((p) => ({
      queryId: p.queryId,
      family: p.family,
      signals: p.signals,
    })),
  };
}

// ---------------------------------------------------------------------------
// Audit runner
// ---------------------------------------------------------------------------

/**
 * The top-level audit runner. Consumes a
 * `QueryEval[]` + the corpus + the query set, emits
 * the `AbstentionAuditReport` + the JSON artifact.
 *
 * The function is pure. No I/O, no provider calls, no
 * network. The CLI entry point writes the artifact to
 * disk; the function itself is a pure orchestrator.
 */
export function runAbstentionAudit(args: {
  variant: "lexical" | "fts5" | "vector" | "vector-dense" | "hybrid-dense";
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  records: ReadonlyArray<BenchmarkMemoryRecord>;
  config: AbstentionAuditConfig;
}): AbstentionAuditReport {
  const { evals, queries, records, config } = args;
  // Build the per-record token sets once. The
  // per-query detection loop reuses the same sets.
  const corpusTokenSets = buildCorpusTokenSets(records);
  // Build the per-query abstention signals. The
  // detector is run on every query; the per-query
  // `eval` provides the retrieval signals (top score,
  // gap, ratio, returned count, hybrid contributors).
  const perQuery: Array<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
  }> = [];
  const evalById = new Map<string, QueryEval>();
  for (const e of evals) evalById.set(e.queryId, e);
  for (const q of queries) {
    const eval_ = evalById.get(q.id);
    if (!eval_) continue;
    const flags = detectQueryShape(q, corpusTokenSets);
    const signals = buildAbstentionSignals(eval_, flags);
    perQuery.push({
      queryId: q.id,
      family: q.family,
      isPositive: q.family !== "no-answer",
      signals,
    });
  }
  // Build the slices. The audit uses the per-query
  // signals + the binary label ("is this a no-answer
  // query?") as the AUROC / risk-coverage input.
  const slices = buildSlices(perQuery, config);
  const allSlice = slices.find((s) => s.name === "all");
  if (!allSlice) {
    // Defensive: buildSlices always emits "all" first.
    throw new Error("internal: audit slice 'all' not found");
  }
  // Per-query examples.
  const perQueryExamples = buildPerQueryExamples(perQuery);
  let total = 0;
  let noAnswerCount = 0;
  for (const p of perQuery) {
    total += 1;
    if (!p.isPositive) noAnswerCount += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    config: {
      recordCount: records.length,
      queryCount: queries.length,
      total,
      noAnswerCount,
      positiveCount: total - noAnswerCount,
      riskTargets: config.riskTargets ?? [0.05, 0.1, 0.2],
      coverageTargets: config.coverageTargets ?? [0.5, 0.8, 0.95],
    },
    slices,
    allSlices: [allSlice],
    perQueryExamples,
    perQuerySignals: perQuery,
  };
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-abstention-audit";

/**
 * Write an abstention-audit report to disk. The file
 * prefix is `retrieval-abstention-audit-*.json`
 * (distinct from the existing benchmark / calibration
 * prefixes) so a reviewer can find the audit
 * artifacts next to the regular reports without
 * confusing them.
 */
export function writeAbstentionAuditReport(
  report: AbstentionAuditReport,
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
 * Format the audit report as a human-readable string.
 * The report is intentionally narrow: the headline
 * "all" slice AUROC table, the per-family slice
 * AUROC table, the per-shape slice AUROC table, the
 * coverage-at-risk and risk-at-coverage summaries for
 * the top-3 signals on the "all" slice, and the
 * honest per-query examples.
 *
 * The function is pure: same report -> same string.
 * The CLI entry point writes the string to stdout.
 */
export function formatAbstentionAuditReport(
  report: AbstentionAuditReport,
): string {
  const lines: string[] = [];
  lines.push("=== cortex-mcp-v2 retrieval abstention audit ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- config ---");
  lines.push(`  records:        ${report.config.recordCount}`);
  lines.push(`  queries:        ${report.config.queryCount}`);
  lines.push(`  total:          ${report.config.total}`);
  lines.push(`  no-answer:      ${report.config.noAnswerCount}`);
  lines.push(`  positive:       ${report.config.positiveCount}`);
  lines.push(
    `  risk targets:   ${report.config.riskTargets.map((t) => `${(t * 100).toFixed(0)}%`).join(", ")}`,
  );
  lines.push(
    `  cov. targets:   ${report.config.coverageTargets.map((t) => `${(t * 100).toFixed(0)}%`).join(", ")}`,
  );
  lines.push("");
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY study.");
  lines.push(
    "  The audit measures how well simple retrieval-derived",
  );
  lines.push(
    "  signals separate answerable from no-answer queries. It is",
  );
  lines.push(
    "  NOT a deployment policy. The abstention gates it surfaces",
  );
  lines.push(
    "  are NOT wired into the production `recall(text)` controller.",
  );
  lines.push(
    "  The brief asks for an honest answer, not a sale. If a signal",
  );
  lines.push(
    "  is weak on real data, the report says so.",
  );
  lines.push("");
  // ---- Headline "all" slice AUROC table ----
  const allSlice = report.allSlices[0];
  if (!allSlice) {
    lines.push("  (no audit data)");
    return lines.join("\n");
  }
  lines.push("--- per-signal AUROC (slice=all) ---");
  lines.push(
    "  signal                       AUROC  direction         notes",
  );
  // Sort the signals by AUROC descending so the
  // reviewer can see the strongest signals first.
  const sortedSignals = [...allSlice.signalResults].sort(
    (a, b) => b.auroc - a.auroc,
  );
  for (const s of sortedSignals) {
    const dir = s.scoreIsHigherIsMorePositive
      ? "higher=positive"
      : "lower=positive ";
    lines.push(
      `  ${s.signal.padEnd(28)} ${s.auroc.toFixed(3)}  ${dir}  ${s.notes}`,
    );
  }
  lines.push("");
  // ---- Coverage at fixed risk on the top-3 signals ----
  lines.push("--- coverage at fixed risk (slice=all, top-3 signals) ---");
  lines.push(
    "  signal                  risk<=5%   risk<=10%   risk<=20%",
  );
  for (const s of sortedSignals.slice(0, 3)) {
    const cov = s.coverageAtRisk;
    const c5 = cov.find((c) => Math.abs(c.riskTarget - 0.05) < 1e-9)?.coverage ?? 0;
    const c10 = cov.find((c) => Math.abs(c.riskTarget - 0.1) < 1e-9)?.coverage ?? 0;
    const c20 = cov.find((c) => Math.abs(c.riskTarget - 0.2) < 1e-9)?.coverage ?? 0;
    lines.push(
      `  ${s.signal.padEnd(22)} ${(c5 * 100).toFixed(1).padStart(7)}%   ${(c10 * 100).toFixed(1).padStart(7)}%    ${(c20 * 100).toFixed(1).padStart(7)}%`,
    );
  }
  lines.push("");
  // ---- Risk at fixed coverage on the top-3 signals ----
  lines.push("--- risk at fixed coverage (slice=all, top-3 signals) ---");
  lines.push(
    "  signal                  cov>=50%   cov>=80%   cov>=95%",
  );
  for (const s of sortedSignals.slice(0, 3)) {
    const risk = s.riskAtCoverage;
    const r50 = risk.find((c) => Math.abs(c.coverageTarget - 0.5) < 1e-9)?.risk ?? 1;
    const r80 = risk.find((c) => Math.abs(c.coverageTarget - 0.8) < 1e-9)?.risk ?? 1;
    const r95 = risk.find((c) => Math.abs(c.coverageTarget - 0.95) < 1e-9)?.risk ?? 1;
    lines.push(
      `  ${s.signal.padEnd(22)} ${(r50 * 100).toFixed(1).padStart(7)}%   ${(r80 * 100).toFixed(1).padStart(7)}%   ${(r95 * 100).toFixed(1).padStart(7)}%`,
    );
  }
  lines.push("");
  // ---- Per-family slice AUROC table ----
  lines.push("--- per-family slice AUROC (top-3 signals) ---");
  lines.push(
    "  family                  n   noAns   bestSignal   AUROC   coverage@5%risk",
  );
  const familySlices = report.slices.filter(
    (s) => s.name.startsWith("family:"),
  );
  for (const slice of familySlices) {
    const sortedSliceSignals = [...slice.signalResults].sort(
      (a, b) => b.auroc - a.auroc,
    );
    const best = sortedSliceSignals[0];
    if (!best) continue;
    // A single-class slice has no positive / negative
    // pairs to rank against, so the AUROC is the
    // uninformative prior (0.5) by definition. Render
    // `n/a` in the human report so a reviewer is not
    // misled into reading a real signal where there is
    // only an undefined prior. The on-disk JSON
    // artifact keeps the documented 0.5 value (with a
    // `singleClass: true` flag the formatter uses to
    // make this decision).
    if (slice.singleClass) {
      lines.push(
        `  ${slice.name.replace("family:", "").padEnd(22)} ${String(slice.total).padStart(3)}   ${String(slice.noAnswerCount).padStart(5)}   ${best.signal.padEnd(12)}     n/a            n/a  (single-class slice)`,
      );
      continue;
    }
    const cov5 = best.coverageAtRisk.find((c) =>
      Math.abs(c.riskTarget - 0.05) < 1e-9,
    )?.coverage ?? 0;
    lines.push(
      `  ${slice.name.replace("family:", "").padEnd(22)} ${String(slice.total).padStart(3)}   ${String(slice.noAnswerCount).padStart(5)}   ${best.signal.padEnd(12)} ${best.auroc.toFixed(3)}    ${(cov5 * 100).toFixed(1)}%`,
    );
  }
  lines.push("");
  // ---- Per-shape slice AUROC table ----
  lines.push("--- per-shape slice AUROC (top-3 signals) ---");
  lines.push(
    "  shape                   n   noAns   bestSignal   AUROC   coverage@5%risk",
  );
  const familyNames = new Set(familySlices.map((s) => s.name));
  const shapeSlices = report.slices.filter(
    (s) => !familyNames.has(s.name) && s.name !== "all",
  );
  for (const slice of shapeSlices) {
    if (slice.total === 0) continue;
    const sortedSliceSignals = [...slice.signalResults].sort(
      (a, b) => b.auroc - a.auroc,
    );
    const best = sortedSliceSignals[0];
    if (!best) continue;
    // See the per-family block above for the
    // rationale: a single-class slice has no AUROC
    // signal; render `n/a` so a reviewer can tell the
    // prior from a real reading.
    if (slice.singleClass) {
      lines.push(
        `  ${slice.name.padEnd(22)} ${String(slice.total).padStart(3)}   ${String(slice.noAnswerCount).padStart(5)}   ${best.signal.padEnd(12)}     n/a            n/a  (single-class slice)`,
      );
      continue;
    }
    const cov5 = best.coverageAtRisk.find((c) =>
      Math.abs(c.riskTarget - 0.05) < 1e-9,
    )?.coverage ?? 0;
    lines.push(
      `  ${slice.name.padEnd(22)} ${String(slice.total).padStart(3)}   ${String(slice.noAnswerCount).padStart(5)}   ${best.signal.padEnd(12)} ${best.auroc.toFixed(3)}    ${(cov5 * 100).toFixed(1)}%`,
    );
  }
  lines.push("");
  // ---- Per-query examples ----
  lines.push("--- per-query examples (honest) ---");
  const examples = report.perQueryExamples;
  lines.push("  MOST CONFIDENT no-answer (ranker strongly confabulated):");
  for (const e of examples.mostConfidentNoAnswer) {
    lines.push(
      `    [${e.family}] ${e.queryId}  topScore=${e.signals.topScore.toFixed(3)} ` +
        `gap=${e.signals.top1Top2Gap.toFixed(3)} returned=${e.signals.returnedCount} ` +
        `agreement=${e.signals.agreementCount} presence="${e.signals.sourcePresence}"`,
    );
  }
  lines.push("");
  lines.push("  LEAST CONFIDENT positive (ranker barely answered):");
  for (const e of examples.leastConfidentPositive) {
    lines.push(
      `    [${e.family}] ${e.queryId}  topScore=${e.signals.topScore.toFixed(3)} ` +
        `gap=${e.signals.top1Top2Gap.toFixed(3)} returned=${e.signals.returnedCount} ` +
        `agreement=${e.signals.agreementCount} presence="${e.signals.sourcePresence}"`,
    );
  }
  lines.push("");
  lines.push("  LEAST CONFIDENT no-answer (easy abstain case):");
  for (const e of examples.leastConfidentNoAnswer) {
    lines.push(
      `    [${e.family}] ${e.queryId}  topScore=${e.signals.topScore.toFixed(3)} ` +
        `gap=${e.signals.top1Top2Gap.toFixed(3)} returned=${e.signals.returnedCount} ` +
        `agreement=${e.signals.agreementCount} presence="${e.signals.sourcePresence}"`,
    );
  }
  lines.push("");
  lines.push("  MOST CONFIDENT positive (clean answer case):");
  for (const e of examples.mostConfidentPositive) {
    lines.push(
      `    [${e.family}] ${e.queryId}  topScore=${e.signals.topScore.toFixed(3)} ` +
        `gap=${e.signals.top1Top2Gap.toFixed(3)} returned=${e.signals.returnedCount} ` +
        `agreement=${e.signals.agreementCount} presence="${e.signals.sourcePresence}"`,
    );
  }
  lines.push("");
  lines.push(
    "How to interpret this report: see the README's",
  );
  lines.push(
    "  'How to interpret the abstention audit' section. The brief:",
  );
  lines.push(
    "  - AUROC 0.5 = uninformative (the signal does not separate",
  );
  lines.push(
    "    answerable from no-answer queries).",
  );
  lines.push(
    "  - AUROC 1.0 = perfect (the signal perfectly separates them).",
  );
  lines.push(
    "  - A signal that works on a 'no-answer-hard' slice but not on",
  );
  lines.push(
    "    the 'all' slice is a hard-negative detector, not a general",
  );
  lines.push(
    "    abstention signal.",
  );
  lines.push(
    "  - The 'coverage@X% risk' number is the headline trade-off:",
  );
  lines.push(
    "    'at most X% confabulation rate, how much of the corpus can",
  );
  lines.push(
    "    we keep?'. A low number means the signal is weak.",
  );
  return lines.join("\n");
}
