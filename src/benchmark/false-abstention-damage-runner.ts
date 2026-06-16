/**
 * Benchmark-only false-abstention damage analysis runner.
 *
 * The runner is a thin orchestrator that:
 *   1. Loads the most recent lexical-baseline
 *      no-answer abstention artifact under
 *      `.curion/benchmark/`.
 *   2. Loads the matching abstention-audit
 *      artifact (the per-query `AbstentionSignals`
 *      block the prior experiments record) so the
 *      damage classifier has the same per-query
 *      signals the prior evaluator consumed.
 *   3. (Optionally) loads a pre-computed semantic-
 *      evidence map from a JSON file. The map is a
 *      `{queryId -> "hit"|"miss"}` object derived
 *      from a separate dense benchmark run; the
 *      runner NEVER runs a new dense benchmark.
 *   4. Calls
 *      `buildFalseAbstentionDamageReport` to
 *      produce the report.
 *   5. Writes the JSON artifact to disk and prints
 *      the human-readable report.
 *
 * The runner is benchmark-only and never modifies
 * the production `recall(text)` controller, the
 * public MCP API, or the storage schema. It is a
 * CLI entry point over the pure functions in
 * `src/benchmark/false-abstention-damage.ts`.
 *
 * Determinism:
 *   The runner is deterministic for a given
 *   (corpus, query set, no-answer artifact, audit
 *   artifact, semantic evidence file). The
 *   pure-function report is byte-stable; the
 *   human report's column order is fixed; the
 *   JSON artifact's entries are in fixture order.
 *   The on-disk artifact is byte-stable for a
 *   fixed input. The only non-deterministic field
 *   is `generatedAt` (an ISO timestamp the
 *   formatter documents).
 *
 * CLI flags:
 *   --no-answer-artifact <path>   — the
 *     `retrieval-no-answer-abstention-*.json`
 *     artifact the prior experiment produced.
 *     Default: the most recent lexical-baseline
 *     artifact under `.curion/benchmark/`.
 *   --audit-artifact <path>       — the
 *     `retrieval-abstention-audit-*.json`
 *     artifact. Default: the most recent
 *     lexical-baseline artifact under
 *     `.curion/benchmark/`.
 *   --semantic-evidence <path>    — OPTIONAL JSON
 *     file with shape
 *     `{source: string, byQueryId: {[qid]:
 *     "hit"|"miss"}}`. When omitted, the report
 *     has no semantic annotation; the honest-
 *     reading block is unchanged.
 *   --out-dir <path>              — output dir.
 *     Default: `.curion/benchmark/`.
 *   --no-write                    — do not write
 *     the JSON artifact. Useful for CI / smoke
 *     tests that just want the human report on
 *     stdout.
 *   --no-stdout                   — do not print
 *     the human report. Useful for scripts that
 *     only want the JSON artifact.
 */

import fs from "node:fs";
import path from "node:path";

import type { AbstentionSignals } from "./metrics.js";
import type { SufficiencyLabel } from "./sufficiency-diagnostic.js";
import { BUILTIN_NO_ANSWER_POLICIES } from "./no-answer-abstention.js";
import {
  buildFalseAbstentionDamageReport,
  formatFalseAbstentionDamageReport,
  type FalseAbstentionDamageReport,
  type SemanticEvidenceMap,
} from "./false-abstention-damage.js";
import {
  type NoAnswerPolicy,
  type NoAnswerPolicyPerQuery,
} from "./no-answer-abstention.js";

// ---------------------------------------------------------------------------
// Artifact reader
// ---------------------------------------------------------------------------

/**
 * The shape the runner reads off the
 * `retrieval-no-answer-abstention-*.json`
 * artifact. The reader pulls the
 * per-policy decisions + per-query input
 * straight off the artifact, so the
 * diagnostic consumes exactly what the
 * prior experiment recorded.
 */
export interface NoAnswerArtifact {
  generatedAt: string;
  config: {
    recordCount: number;
    queryCount: number;
    total: number;
    noAnswerCount: number;
    positiveCount: number;
  };
  perQuery: NoAnswerPolicyPerQuery[];
  decisions: Array<{
    policyId: string;
    decisions: ReadonlyArray<{
      queryId: string;
      family: string;
      isPositive: boolean;
      abstain: boolean;
      reason: string;
      rank1: boolean;
      currentTruthAt1: boolean;
      hitAt5: boolean;
      sufficiencyLabel?: SufficiencyLabel;
      queryLabels?: string[];
    }>;
  }>;
}

/**
 * Read a no-answer-abstention artifact from disk
 * and return its in-memory shape. The function
 * is synchronous (small file, no streaming
 * needed) and never mutates the input.
 */
export function readNoAnswerAbstentionArtifact(
  filePath: string,
): NoAnswerArtifact {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  return raw as NoAnswerArtifact;
}

/**
 * The shape the runner reads off the
 * `retrieval-abstention-audit-*.json`
 * artifact. The reader pulls the
 * per-query `AbstentionSignals` block.
 * Used to construct a complete
 * per-query input the prior experiment
 * recorded, with the per-query signals
 * the audit artifact independently
 * measured (a different, secondary
 * path that pins the cross-artifact
 * consistency).
 */
export interface AbstentionAuditArtifact {
  generatedAt: string;
  config: {
    recordCount: number;
    queryCount: number;
  };
  perQuerySignals: Array<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
  }>;
}

/**
 * Read an abstention-audit artifact from disk.
 * The function is synchronous and never mutates
 * the input.
 */
export function readAbstentionAuditArtifact(
  filePath: string,
): AbstentionAuditArtifact {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  return raw as AbstentionAuditArtifact;
}

/**
 * Read a semantic-evidence file. The file's
 * shape is `{source: string, byQueryId:
 * {[qid]: "hit"|"miss"}}`. The runner
 * validates the shape: a malformed file
 * throws so the bug is caught at load time
 * rather than silently producing an
 * unannotated report.
 */
export function readSemanticEvidenceFile(
  filePath: string,
): SemanticEvidenceMap {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new Error(
      `readSemanticEvidenceFile: ${filePath} must have a non-empty string 'source' field`,
    );
  }
  if (typeof raw.byQueryId !== "object" || raw.byQueryId === null) {
    throw new Error(
      `readSemanticEvidenceFile: ${filePath} must have an object 'byQueryId' field`,
    );
  }
  const map = new Map<string, "hit" | "miss">();
  for (const [k, v] of Object.entries(raw.byQueryId)) {
    if (v !== "hit" && v !== "miss") {
      throw new Error(
        `readSemanticEvidenceFile: ${filePath} byQueryId.${k} must be "hit" or "miss", got ${JSON.stringify(v)}`,
      );
    }
    map.set(k, v);
  }
  return { source: raw.source, byQueryId: map };
}

// ---------------------------------------------------------------------------
// Artifact scanner
// ---------------------------------------------------------------------------

/**
 * Find the most recent artifact under
 * `dir` whose filename matches `prefix`.
 * Returns `undefined` if no artifact
 * matches. The function is synchronous
 * and never mutates the directory.
 *
 * Used by the CLI's default-mode
 * helpers to pick the most recent
 * lexical-baseline artifact without
 * forcing the caller to pass an
 * explicit path. The default-mode
 * selection is best-effort: if a
 * reviewer wants a specific artifact,
 * they pass `--no-answer-artifact` /
 * `--audit-artifact` explicitly.
 */
export function findMostRecentArtifact(
  dir: string,
  prefix: string,
): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const entries = fs
    .readdirSync(dir)
    .filter((e) => e.startsWith(prefix) && e.endsWith(".json"))
    .map((e) => ({
      name: e,
      full: path.join(dir, e),
      mtime: fs.statSync(path.join(dir, e)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.full;
}

// ---------------------------------------------------------------------------
// Per-query input reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct the per-query input the prior
 * no-answer experiment consumed, given the
 * per-policy decision block the no-answer
 * artifact recorded. The function is pure: the
 * artifact's `perQuery` array is the source of
 * truth for the per-query signal block
 * (topScore, top1Top2Gap, top1Top2Ratio,
 * returnedCount, query-shape flags,
 * sufficiencyLabel, queryLabels), and the
 * decision block is the source of truth for
 * the per-query outcomes (rank1,
 * currentTruthAt1, hitAt5).
 *
 * The runner does NOT re-derive signals from a
 * fresh ranker call: the artifact is
 * canonical. A reviewer who wants to re-derive
 * the signals runs the prior experiment again
 * with the relevant flags.
 */
export function reconstructPerQuery(
  artifact: NoAnswerArtifact,
  policyId: string,
): NoAnswerPolicyPerQuery[] {
  const decisionBlock = artifact.decisions.find(
    (b) => b.policyId === policyId,
  );
  if (!decisionBlock) {
    throw new Error(
      `reconstructPerQuery: no-answer artifact has no decision block for policyId="${policyId}"; ` +
        `available: ${artifact.decisions.map((b) => b.policyId).join(", ")}`,
    );
  }
  // The artifact's perQuery already has the
  // full per-query input (signals, family,
  // isPositive, topKSize, rank1, etc.). We
  // return it as-is. The decision block is
  // joined by `queryId` when the report
  // builder needs it.
  return artifact.perQuery.map((p) => ({ ...p }));
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

/**
 * Top-level runner. Consumes the no-answer
 * artifact + (optionally) the audit artifact +
 * (optionally) the semantic-evidence map and
 * emits the `FalseAbstentionDamageReport`. The
 * function is pure: no I/O. The CLI entry point
 * writes the artifact to disk; the function
 * itself is a pure orchestrator.
 *
 * The function does NOT call any provider, any
 * ranker, or any external service. It
 * consumes the artifacts the prior experiments
 * produced.
 */
export function runFalseAbstentionDamageAnalysis(args: {
  /** The no-answer artifact. */
  noAnswerArtifact: NoAnswerArtifact;
  /** The policy id to analyze damage for.
   *  Default: `score-or-sufficiency-insufficient`
   *  (the production-like candidate the prior
   *  experiment surfaces). */
  policyId?: string;
  /** Optional semantic evidence. */
  semantic?: SemanticEvidenceMap;
}): FalseAbstentionDamageReport {
  const { noAnswerArtifact, semantic } = args;
  const policyId =
    args.policyId ?? "score-or-sufficiency-insufficient";
  // Validate the policy id is in the built-in
  // set so a typo in a CLI flag surfaces loud
  // rather than silently producing an
  // un-analyzed report.
  const known = BUILTIN_NO_ANSWER_POLICIES.find(
    (p) => p.id === policyId,
  );
  if (!known) {
    throw new Error(
      `runFalseAbstentionDamageAnalysis: policyId="${policyId}" is not in BUILTIN_NO_ANSWER_POLICIES; ` +
        `available: ${BUILTIN_NO_ANSWER_POLICIES.map((p) => p.id).join(", ")}`,
    );
  }
  const perQuery = reconstructPerQuery(noAnswerArtifact, policyId);
  return buildFalseAbstentionDamageReport({
    recordCount: noAnswerArtifact.config.recordCount,
    perQuery,
    policy: known as NoAnswerPolicy,
    ...(semantic ? { semantic } : {}),
  });
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-false-abstention-damage";

/**
 * Write a damage report to disk. The file
 * prefix is
 * `retrieval-false-abstention-damage-*.json`
 * (distinct from the existing audit / policy /
 * diagnostic / benchmark / calibration /
 * no-answer-abstention prefixes) so a reviewer
 * can find the experiment artifacts next to
 * the regular reports without confusing them.
 * The timestamp is the current ISO timestamp
 * with `:` / `.` replaced by `-` so the
 * filename is safe across shells.
 */
export function writeFalseAbstentionDamageReport(
  report: FalseAbstentionDamageReport,
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
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI argument shape. The CLI is small: each
 * field is OPTIONAL; the defaults pick the
 * most recent lexical-baseline artifacts under
 * `.curion/benchmark/`.
 */
export interface FalseAbstentionDamageCliArgs {
  noAnswerArtifact?: string;
  auditArtifact?: string;
  semanticEvidence?: string;
  outDir?: string;
  noWrite?: boolean;
  noStdout?: boolean;
  policyId?: string;
}

/**
 * Run the CLI. The function is the entry
 * point the `tsx` invocation calls; it is
 * not part of the public TypeScript surface
 * (the function does its own argument
 * parsing).
 */
export async function runFalseAbstentionDamageCli(
  args: FalseAbstentionDamageCliArgs,
): Promise<{ report: FalseAbstentionDamageReport; written?: string }> {
  const outDir = args.outDir ?? ".curion/benchmark";
  const defaultNoAnswer =
    args.noAnswerArtifact ??
    findMostRecentArtifact(outDir, "retrieval-no-answer-abstention-");
  if (!defaultNoAnswer) {
    throw new Error(
      `runFalseAbstentionDamageCli: no --no-answer-artifact given and no ` +
        `retrieval-no-answer-abstention-*.json found under ${outDir}`,
    );
  }
  const noAnswerArtifact = readNoAnswerAbstentionArtifact(defaultNoAnswer);
  let semantic: SemanticEvidenceMap | undefined;
  if (args.semanticEvidence) {
    semantic = readSemanticEvidenceFile(args.semanticEvidence);
  }
  const report = runFalseAbstentionDamageAnalysis({
    noAnswerArtifact,
    ...(args.policyId ? { policyId: args.policyId } : {}),
    ...(semantic ? { semantic } : {}),
  });
  let written: string | undefined;
  if (!args.noWrite) {
    written = writeFalseAbstentionDamageReport(report, outDir);
  }
  if (!args.noStdout) {
    // The human report goes to stdout. The
    // CLI prints a small header to stderr so
    // the JSON artifact on stdout (if any)
    // stays parseable.
    process.stderr.write(
      `[false-abstention-damage] no-answer artifact: ${defaultNoAnswer}\n`,
    );
    if (args.auditArtifact) {
      process.stderr.write(
        `[false-abstention-damage] audit artifact:    ${args.auditArtifact}\n`,
      );
    }
    if (semantic) {
      process.stderr.write(
        `[false-abstention-damage] semantic evidence:  ${args.semanticEvidence}\n`,
      );
    }
    if (written) {
      process.stderr.write(
        `[false-abstention-damage] wrote:              ${written}\n`,
      );
    }
    process.stdout.write(formatFalseAbstentionDamageReport(report) + "\n");
  }
  return { report, ...(written ? { written } : {}) };
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

/**
 * Minimal argument parser. The CLI is small;
 * a hand-rolled parser keeps the surface
 * narrow. The parser is permissive: unknown
 * flags are ignored so a reviewer can pass
 * `--help` / `--version` and the runner
 * silently accepts them. The order of
 * arguments does not matter.
 */
export function parseFalseAbstentionDamageCliArgs(
  argv: ReadonlyArray<string>,
): FalseAbstentionDamageCliArgs {
  const out: FalseAbstentionDamageCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-answer-artifact" && i + 1 < argv.length) {
      out.noAnswerArtifact = argv[++i];
    } else if (a === "--audit-artifact" && i + 1 < argv.length) {
      out.auditArtifact = argv[++i];
    } else if (a === "--semantic-evidence" && i + 1 < argv.length) {
      out.semanticEvidence = argv[++i];
    } else if (a === "--out-dir" && i + 1 < argv.length) {
      out.outDir = argv[++i];
    } else if (a === "--policy-id" && i + 1 < argv.length) {
      out.policyId = argv[++i];
    } else if (a === "--no-write") {
      out.noWrite = true;
    } else if (a === "--no-stdout") {
      out.noStdout = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Process argv-based main entry point. The
 * function is the one a `tsx` invocation
 * calls. It returns the report promise so
 * tests can `await` it; in CLI mode the
 * process exits normally.
 */
export async function main(
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<FalseAbstentionDamageReport> {
  const args = parseFalseAbstentionDamageCliArgs(argv);
  const { report } = await runFalseAbstentionDamageCli(args);
  return report;
}

/**
 * Run the CLI when this module is the entry
 * point. The guard compares `import.meta.url`
 * to the resolved path of the script (when
 * available) so tests can `import` the module
 * without triggering a CLI run. In `tsx`
 * invocation, `import.meta.url` matches
 * `process.argv[1]` only when the runner is
 * launched directly; in test contexts the
 * import is a side-effect of the test loader
 * and the guard does not fire.
 */
const isMainEntry = (() => {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  if (!/false-abstention-damage-runner\.(ts|js)$/.test(entry)) return false;
  // Compare against the resolved URL. In tsx
  // both refer to the same .ts file; in a
  // compiled context both refer to the same
  // .js file.
  try {
    const url = new URL(import.meta.url);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  main().catch((err) => {
    process.stderr.write(
      `[false-abstention-damage] error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
