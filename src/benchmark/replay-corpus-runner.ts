/**
 * Benchmark-only replay corpus evaluation CLI runner.
 *
 * A small CLI that runs the replay corpus evaluation helper
 * (`src/benchmark/replay-corpus-evaluation.ts`) and writes
 * the JSON artifact under `.curion/benchmark/`.
 *
 * The runner mirrors the canonical benchmark runner flag style:
 *   --artifacts <path>   override the artifact directory
 *   --no-write           suppress the JSON artifact
 *   --no-stdout          suppress the human report on stdout
 *
 * Behaviour:
 *   - Runs the full evaluation (all corpus items) in-process.
 *   - Builds the evaluation report and (optionally) writes the
 *     JSON artifact under `.curion/benchmark/`.
 *   - Prints the human summary to stdout.
 *   - Exits with code 0 on success; code 1 on any unexpected
 *     error.
 *
 * Security:
 *   - No API keys, no Authorization headers, no live network.
 *     The scripted engine produces deterministic responses in-process.
 *   - No production storage is touched.
 *   - Corpus items contain no forbidden data (secrets, credentials,
 *     PII, raw private user text).
 *
 * Scope (benchmark-only):
 *   The CLI is read-only. It does not write to the production
 *   storage; the only on-disk effect is the JSON report under
 *   `.curion/benchmark/`. It does NOT modify the production
 *   `remember(text)` behavior, the public MCP API, or any
 *   existing report shapes.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  formatReplayCorpusReport,
  runReplayCorpusEvaluation,
  writeReplayCorpusReport,
} from "./replay-corpus-evaluation.js";

/**
 * Parse the replay corpus evaluation CLI args.
 *
 * The runner's CLI surface is intentionally narrow:
 * `--artifacts`, `--no-write`, `--no-stdout`.
 * A flag not recognised is a hard error.
 */
export function parseReplayCorpusEvaluationCli(argv: ReadonlyArray<string>): {
  artifactsDir: string;
  noWrite: boolean;
  noStdout: boolean;
} {
  return parseBenchmarkArtifactCli(argv, {
    supportNoWrite: true,
    supportNoStdout: true,
    contextLabel: "replay-corpus evaluation",
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    return argvPath === thisPath;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[curion-replay-corpus-eval] FATAL ${msg}\n`);
    process.exit(1);
  });
}

/**
 * Main entry point. Synchronous because the scripted replay
 * evaluation is deterministic.
 */
async function main(): Promise<void> {
  const opts = parseReplayCorpusEvaluationCli(process.argv.slice(2));
  const report = runReplayCorpusEvaluation();
  let artifactPath: string | undefined;
  if (!opts.noWrite) {
    artifactPath = writeReplayCorpusReport(report, opts.artifactsDir);
  }
  if (!opts.noStdout) {
    process.stdout.write(formatReplayCorpusReport(report) + "\n");
    if (artifactPath) {
      process.stdout.write(`\nartifact written: ${artifactPath}\n`);
    }
  }
}
