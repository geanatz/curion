/**
 * Benchmark-only paraphrase-specific recovery /
 * refined-threshold experiment runner.
 *
 * The runner is a thin orchestrator that:
 *   1. Loads the most recent lexical-baseline
 *      no-answer abstention artifact under
 *      `.cortex/benchmark/`.
 *   2. (Optionally) loads a pre-computed
 *      semantic-evidence map from a JSON file.
 *      The map is a `{queryId -> "hit"|"miss"}`
 *      object derived from a separate dense
 *      benchmark run; the runner NEVER runs a
 *      new dense benchmark.
 *   3. Calls
 *      `runParaphraseRecoveryExperiment` to
 *      produce the report.
 *   4. Writes the JSON artifact to disk and
 *      prints the human-readable report.
 *
 * The runner is benchmark-only and never
 * modifies the production `recall(text)`
 * controller, the public MCP API, or the
 * storage schema. It is a CLI entry point
 * over the pure functions in
 * `src/benchmark/paraphrase-recovery.ts`.
 *
 * Determinism:
 *   The runner is deterministic for a given
 *   (no-answer artifact, semantic evidence
 *   file, custom variants, baseline policy).
 *   The pure-function report is byte-stable;
 *   the human report's column order is
 *   fixed; the JSON artifact's entries are
 *   in declaration order. The on-disk
 *   artifact is byte-stable for a fixed
 *   input. The only non-deterministic field
 *   is `generatedAt` (an ISO timestamp the
 *   formatter documents).
 *
 * CLI flags:
 *   --no-answer-artifact <path>   — the
 *     `retrieval-no-answer-abstention-*.json`
 *     artifact the prior experiment
 *     produced. Default: the most recent
 *     lexical-baseline artifact under
 *     `.cortex/benchmark/`.
 *   --semantic-evidence <path>    — OPTIONAL
 *     JSON file with shape
 *     `{source: string, byQueryId: {[qid]:
 *     "hit"|"miss"}}`. When omitted, the
 *     report has no semantic annotation;
 *     the honest-reading block is unchanged.
 *   --out-dir <path>              — output
 *     dir. Default: `.cortex/benchmark/`.
 *   --no-write                    — do not
 *     write the JSON artifact. Useful for
 *     CI / smoke tests that just want the
 *     human report on stdout.
 *   --no-stdout                   — do not
 *     print the human report. Useful for
 *     scripts that only want the JSON
 *     artifact.
 *   --baseline-policy <id>        —
 *     override the baseline policy id.
 *     Default:
 *     `score-or-sufficiency-insufficient`
 *     (the accepted production-like
 *     policy).
 */

import fs from "node:fs";
import path from "node:path";

import type { NoAnswerArtifact } from "./false-abstention-damage-runner.js";
import { reconstructPerQuery } from "./false-abstention-damage-runner.js";
import type { SemanticEvidenceMap } from "./false-abstention-damage.js";
import {
  runParaphraseRecoveryExperiment,
  formatParaphraseRecoveryReport,
  type ParaphraseRecoveryReport,
  type ParaphraseRecoveryVariant,
  type ParaphraseRecoveryConfig,
} from "./paraphrase-recovery.js";

// ---------------------------------------------------------------------------
// Artifact reader
// ---------------------------------------------------------------------------

/**
 * Read a no-answer-abstention artifact from
 * disk and return its in-memory shape. The
 * runner re-uses the upstream reader from the
 * false-abstention-damage-runner module (the
 * shape is the same).
 */
export function readParaphraseRecoveryNoAnswerArtifact(
  filePath: string,
): NoAnswerArtifact {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  return raw as NoAnswerArtifact;
}

/**
 * Read a semantic-evidence file. The file's
 * shape is `{source: string, byQueryId:
 * {[qid]: "hit"|"miss"}}`. The runner
 * re-uses the upstream reader from the
 * false-abstention-damage-runner module
 * (the shape is the same).
 */
export function readParaphraseRecoverySemanticEvidenceFile(
  filePath: string,
): SemanticEvidenceMap {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new Error(
      `readParaphraseRecoverySemanticEvidenceFile: ${filePath} must have a non-empty string 'source' field`,
    );
  }
  if (typeof raw.byQueryId !== "object" || raw.byQueryId === null) {
    throw new Error(
      `readParaphraseRecoverySemanticEvidenceFile: ${filePath} must have an object 'byQueryId' field`,
    );
  }
  const map = new Map<string, "hit" | "miss">();
  for (const [k, v] of Object.entries(raw.byQueryId)) {
    if (v !== "hit" && v !== "miss") {
      throw new Error(
        `readParaphraseRecoverySemanticEvidenceFile: ${filePath} byQueryId.${k} must be "hit" or "miss", got ${JSON.stringify(v)}`,
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
 */
export function findParaphraseRecoveryMostRecentArtifact(
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
// Top-level runner
// ---------------------------------------------------------------------------

/**
 * Top-level runner. Consumes the no-answer
 * artifact + (optionally) the semantic-evidence
 * map and emits the `ParaphraseRecoveryReport`.
 * The function is pure: no I/O. The CLI entry
 * point writes the artifact to disk; the
 * function itself is a pure orchestrator.
 *
 * The function does NOT call any provider, any
 * ranker, or any external service. It
 * consumes the artifacts the prior experiments
 * produced.
 */
export function runParaphraseRecoveryAnalysis(args: {
  /** The no-answer artifact. */
  noAnswerArtifact: NoAnswerArtifact;
  /** Optional semantic evidence. */
  semantic?: SemanticEvidenceMap;
  /** Optional config override. */
  config?: ParaphraseRecoveryConfig;
  /** Override the baseline policy id. */
  baselinePolicyId?: string;
}): ParaphraseRecoveryReport {
  const { noAnswerArtifact, semantic, config } = args;
  // The baseline policy id. The runner
  // re-uses the upstream `reconstructPerQuery`
  // helper when the override is the default
  // (`score-or-sufficiency-insufficient`)
  // because the helper is the canonical
  // source for the per-query input the
  // no-answer experiment recorded. When the
  // override is a different policy, the
  // helper is bypassed and the runner uses
  // the artifact's perQuery array directly
  // (the artifact's perQuery is the same
  // shape for every policy the experiment
  // evaluated, so a different policy is
  // safe to evaluate on the same input).
  const baselinePolicyId =
    args.baselinePolicyId ??
    (config?.baselinePolicyId ?? undefined) ??
    "score-or-sufficiency-insufficient";
  const perQuery =
    baselinePolicyId === "score-or-sufficiency-insufficient" ||
    noAnswerArtifact.decisions.some((d) => d.policyId === baselinePolicyId)
      ? reconstructPerQuery(noAnswerArtifact, baselinePolicyId)
      : noAnswerArtifact.perQuery.map((p) => ({ ...p }));
  return runParaphraseRecoveryExperiment({
    recordCount: noAnswerArtifact.config.recordCount,
    perQuery,
    config: {
      ...(config ?? {}),
      ...(args.baselinePolicyId !== undefined
        ? { baselinePolicyId: args.baselinePolicyId }
        : {}),
    },
    ...(semantic ? { semantic: { source: semantic.source, byQueryId: semantic.byQueryId } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-paraphrase-recovery";

/**
 * Write a recovery report to disk. The file
 * prefix is
 * `retrieval-paraphrase-recovery-*.json`
 * (distinct from the existing audit / policy /
 * diagnostic / benchmark / calibration /
 * no-answer-abstention / false-abstention-
 * damage prefixes) so a reviewer can find
 * the experiment artifacts next to the
 * regular reports without confusing them.
 */
export function writeParaphraseRecoveryReport(
  report: ParaphraseRecoveryReport,
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
 * CLI argument shape. The CLI is small:
 * each field is OPTIONAL; the defaults pick
 * the most recent lexical-baseline artifacts
 * under `.cortex/benchmark/`.
 */
export interface ParaphraseRecoveryCliArgs {
  noAnswerArtifact?: string;
  semanticEvidence?: string;
  outDir?: string;
  noWrite?: boolean;
  noStdout?: boolean;
  baselinePolicy?: string;
  /** OPTIONAL: a path to a JSON file
   *  containing an array of custom
   *  `ParaphraseRecoveryVariant` objects
   *  that the runner evaluates in
   *  addition to the built-in variants.
   *  The custom variant list is useful
   *  for ad-hoc tests without modifying
   *  the built-in table. */
  customVariants?: string;
  /** OPTIONAL: a JSON array of variant ids
   *  to restrict the report to. */
  onlyVariantIds?: string;
}

function parseJsonArrayField<T = string>(s: string): T[] {
  const trimmed = s.trim();
  if (!trimmed.startsWith("[")) {
    throw new Error(
      `parseJsonArrayField: expected a JSON array, got: ${s.slice(0, 50)}`,
    );
  }
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `parseJsonArrayField: expected a JSON array, got: ${typeof parsed}`,
    );
  }
  return parsed as T[];
}

/**
 * Run the CLI. The function is the entry
 * point the `tsx` invocation calls; it is
 * not part of the public TypeScript surface
 * (the function does its own argument
 * parsing).
 */
export async function runParaphraseRecoveryCli(
  args: ParaphraseRecoveryCliArgs,
): Promise<{
  report: ParaphraseRecoveryReport;
  written?: string;
}> {
  const outDir = args.outDir ?? ".cortex/benchmark";
  const defaultNoAnswer =
    args.noAnswerArtifact ??
    findParaphraseRecoveryMostRecentArtifact(
      outDir,
      "retrieval-no-answer-abstention-",
    );
  if (!defaultNoAnswer) {
    throw new Error(
      `runParaphraseRecoveryCli: no --no-answer-artifact given and no ` +
        `retrieval-no-answer-abstention-*.json found under ${outDir}`,
    );
  }
  const noAnswerArtifact = readParaphraseRecoveryNoAnswerArtifact(
    defaultNoAnswer,
  );
  let semantic: SemanticEvidenceMap | undefined;
  if (args.semanticEvidence) {
    semantic = readParaphraseRecoverySemanticEvidenceFile(
      args.semanticEvidence,
    );
  }
  let customVariants: ParaphraseRecoveryVariant[] | undefined;
  if (args.customVariants) {
    const text = fs.readFileSync(args.customVariants, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `runParaphraseRecoveryCli: --custom-variants file must contain a JSON array, got ${typeof parsed}`,
      );
    }
    customVariants = parsed as ParaphraseRecoveryVariant[];
  }
  let onlyVariantIds: string[] | undefined;
  if (args.onlyVariantIds) {
    onlyVariantIds = parseJsonArrayField<string>(args.onlyVariantIds);
  }
  const config: ParaphraseRecoveryConfig = {};
  if (customVariants !== undefined) config.customVariants = customVariants;
  if (onlyVariantIds !== undefined) config.onlyVariantIds = onlyVariantIds;
  if (args.baselinePolicy !== undefined) {
    config.baselinePolicyId = args.baselinePolicy;
  }
  const report = runParaphraseRecoveryAnalysis({
    noAnswerArtifact,
    ...(semantic ? { semantic } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  });
  let written: string | undefined;
  if (!args.noWrite) {
    written = writeParaphraseRecoveryReport(report, outDir);
  }
  if (!args.noStdout) {
    process.stderr.write(
      `[paraphrase-recovery] no-answer artifact: ${defaultNoAnswer}\n`,
    );
    if (semantic) {
      process.stderr.write(
        `[paraphrase-recovery] semantic evidence:  ${args.semanticEvidence}\n`,
      );
    }
    if (written) {
      process.stderr.write(
        `[paraphrase-recovery] wrote:              ${written}\n`,
      );
    }
    process.stdout.write(
      formatParaphraseRecoveryReport(report) + "\n",
    );
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
export function parseParaphraseRecoveryCliArgs(
  argv: ReadonlyArray<string>,
): ParaphraseRecoveryCliArgs {
  const out: ParaphraseRecoveryCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-answer-artifact" && i + 1 < argv.length) {
      out.noAnswerArtifact = argv[++i];
    } else if (a === "--semantic-evidence" && i + 1 < argv.length) {
      out.semanticEvidence = argv[++i];
    } else if (a === "--out-dir" && i + 1 < argv.length) {
      out.outDir = argv[++i];
    } else if (a === "--baseline-policy" && i + 1 < argv.length) {
      out.baselinePolicy = argv[++i];
    } else if (a === "--custom-variants" && i + 1 < argv.length) {
      out.customVariants = argv[++i];
    } else if (a === "--only-variant-ids" && i + 1 < argv.length) {
      out.onlyVariantIds = argv[++i];
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
): Promise<ParaphraseRecoveryReport> {
  const args = parseParaphraseRecoveryCliArgs(argv);
  const { report } = await runParaphraseRecoveryCli(args);
  return report;
}

/**
 * Run the CLI when this module is the entry
 * point. The guard compares `import.meta.url`
 * to the resolved path of the script (when
 * available) so tests can `import` the module
 * without triggering a CLI run.
 */
const isMainEntry = (() => {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  if (!/paraphrase-recovery-runner\.(ts|js)$/.test(entry)) return false;
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
      `[paraphrase-recovery] error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
