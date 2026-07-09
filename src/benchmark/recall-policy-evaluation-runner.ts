/**
 * Benchmark-only recall-policy evaluation CLI runner (v1).
 *
 * A small CLI that runs the recall-policy evaluation helper
 * (`src/benchmark/recall-policy-evaluation.ts`) and writes
 * the JSON artifact under `.curion/benchmark/`.
 *
 * The runner mirrors the canonical adaptive-depth runner
 * flag style: `--artifacts <path>` overrides the JSON
 * report directory; default is `.curion/benchmark/` under
 * cwd. `--no-write` suppresses the JSON artifact (the
 * human report still prints). `--no-stdout` suppresses the
 * human report on stdout (the runner still writes the
 * artifact). The runner deliberately does NOT expose a
 * `--live` flag — v1 ships scripted mode only because the
 * production recall-policy decision engine does not yet
 * exist, and a live mode would require a server-internal
 * adapter that does not exist either.
 *
 * Behaviour:
 *   - Runs the full evaluation (16 scenarios in v1)
 *     in-process.
 *   - Builds the evaluation report and (optionally) writes
 *     the JSON artifact under `.curion/benchmark/`.
 *   - Prints the human summary to stdout.
 *   - Exits with code 0 on success; code 1 on any unexpected
 *     error.
 *
 * Security:
 *   - No API keys, no Authorization headers, no live
 *     network. The scripted fetch in the helper returns
 *     canned responses in-process.
 *   - The seeded evidence packets carry only safe text (no
 *     secrets, no raw input fields).
 *   - No production storage is touched.
 *   - The benchmark-only adapter is consumed ONLY by the
 *     recall-policy evaluation harness; production code
 *     paths do NOT import the adapter (the public recall
 *     controller and the public MCP `recall` tool surface
 *     are unchanged).
 *
 * Scope (benchmark-only):
 *   The CLI is read-only. It does not write to the production
 *   storage; the only on-disk effect is the JSON report under
 *   `.curion/benchmark/`. It does NOT modify the production
 *   `recall(text)` behavior, the public MCP API, or the
 *   existing dev-set / audit / calibration / policy / held-
 *   out / adaptive-depth-evaluation / decision-policy-
 *   evaluation report shapes.
 *
 * Why this is a separate entry point:
 *   The decision-policy runner, the adaptive-depth runner,
 *   and the recall-policy runner each exercise distinct
 *   code paths with distinct scenario sets and report
 *   shapes. A reviewer who wants to audit the recall-policy
 *   evaluation reads this file plus
 *   `src/benchmark/recall-policy-evaluation.ts` and
 *   `tests/recall-policy-evaluation.test.ts`; the other
 *   runners are not part of the recall-policy read path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  formatRecallPolicyEvaluationReport,
  runRecallPolicyEvaluation,
  writeRecallPolicyEvaluationReport,
} from "./recall-policy-evaluation.js";

/**
 * Parse the recall-policy evaluation CLI args. The runner's
 * CLI surface is narrow: `--artifacts`, `--no-write`, and
 * `--no-stdout`. The `--live` flag is deliberately NOT
 * supported — the v1 evaluation has no live mode because
 * the production recall-policy adapter does not yet exist.
 * A future v2 that exposes a live mode can opt in via the
 * shared `parseBenchmarkArtifactCli` helper with
 * `supportLive: true`. Passing `--live` to this runner
 * surfaces a clear "unknown flag" error so a misspelled flag
 * is caught at the CLI boundary.
 *
 * The parser is a thin wrapper over the shared
 * `parseBenchmarkArtifactCli` helper so the runner, the
 * decision-policy runner, and the adaptive-depth runner
 * share the same parsing semantics. The per-runner label
 * (`"recall-policy evaluation"`) is preserved verbatim so
 * a test that asserts on `/unknown recall-policy evaluation
 * cli flag/` regex keeps passing.
 */
export function parseRecallPolicyEvaluationCli(argv: ReadonlyArray<string>): {
  artifactsDir: string;
  noWrite: boolean;
  noStdout: boolean;
} {
  const parsed = parseBenchmarkArtifactCli(argv, {
    supportNoWrite: true,
    supportNoStdout: true,
    // `supportLive` deliberately left at the default `false`:
    // the recall-policy evaluation v1 has no live mode.
    contextLabel: "recall-policy evaluation",
  });
  return {
    artifactsDir: parsed.artifactsDir,
    noWrite: parsed.noWrite,
    noStdout: parsed.noStdout,
  };
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
    process.stderr.write(`[curion-recall-policy-eval] FATAL ${msg}\n`);
    process.exit(1);
  });
}

/**
 * Main entry point. The function is async because
 * `runRecallPolicyEvaluation` is async. The function is
 * `void main()` (not exported) because the CLI is a one-shot
 * tool: the test surface imports the helper directly.
 */
async function main(): Promise<void> {
  const opts = parseRecallPolicyEvaluationCli(process.argv.slice(2));
  const report = await runRecallPolicyEvaluation();
  let artifactPath: string | undefined;
  if (!opts.noWrite) {
    artifactPath = writeRecallPolicyEvaluationReport(report, opts.artifactsDir);
  }
  if (!opts.noStdout) {
    process.stdout.write(formatRecallPolicyEvaluationReport(report) + "\n");
    if (artifactPath) {
      process.stdout.write(`\nartifact written: ${artifactPath}\n`);
    }
  }
}
