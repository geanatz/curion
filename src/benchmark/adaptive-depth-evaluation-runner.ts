/**
 * Benchmark-only adaptive-depth evaluation CLI runner.
 *
 * A small CLI that runs the adaptive-depth evaluation
 * helper (`src/benchmark/adaptive-depth-evaluation.ts`)
 * and writes the JSON artifact under `.curion/benchmark/`.
 *
 * The runner mirrors the canonical held-out / dev-set
 * runner flag style: `--artifacts <path>` overrides the
 * JSON report directory; default is `.curion/benchmark/`
 * under cwd. There is no other flag — the helper's
 * default scenario set + configs are the only knob the
 * v1 runner exposes. A future v2 that adds new
 * scenarios or new configs is a deliberate, visible
 * change.
 *
 * Behaviour:
 *   - Runs the full evaluation (6 scenarios x 2 configs =
 *     12 controller invocations) in-process.
 *   - Builds the evaluation report and writes the JSON
 *     artifact under `.curion/benchmark/`.
 *   - Prints the human summary to stdout.
 *   - Exits with code 0 on success; code 1 on any
 *     unexpected error.
 *
 * Security:
 *   - No API keys, no Authorization headers, no live
 *     network. The scripted fetch in the helper returns
 *     canned responses in-process.
 *   - The seeded memories are safe text (no secrets, no
 *     raw input). The controller's safety pre-check is
 *     never triggered.
 *   - Each scenario creates an isolated tmp storage and
 *     tears it down after the run.
 *
 * Scope (benchmark-only):
 *   The CLI is read-only. It does not write to the
 *   production storage; the only on-disk effect is the
 *   JSON report under `.curion/benchmark/`. It does
 *   NOT modify the production `recall(text)` behavior,
 *   the public MCP API, or the existing dev-set / audit /
 *   calibration / policy / held-out report shapes.
 *
 * Why this is a separate entry point:
 *   The held-out CLI is a thin read-path harness; the
 *   adaptive-depth evaluation is a SEPARATE study with
 *   its own (small) scenario set, its own controller
 *   code path (the test-only `adaptiveDepth` option),
 *   and its own report shape. A reviewer who wants to
 *   audit the adaptive-depth evaluation reads this
 *   file plus `src/benchmark/adaptive-depth-evaluation.ts`
 *   and `tests/adaptive-depth-evaluation.test.ts`; the
 *   held-out runner is not part of the adaptive-depth
 *   read path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  formatAdaptiveDepthEvaluationReport,
  runAdaptiveDepthEvaluation,
  writeAdaptiveDepthEvaluationReport,
} from "./adaptive-depth-evaluation.js";

/**
 * Parse the adaptive-depth evaluation CLI args. The
 * runner's CLI surface is intentionally narrow:
 * `--artifacts <path>` and nothing else. `--no-write` and
 * `--no-stdout` are not supported (the adaptive-depth
 * runner is a one-shot benchmark tool; the JSON artifact
 * + human report are both its primary output).
 *
 * The parser is a thin wrapper over the shared
 * `parseBenchmarkArtifactCli` helper so the runner, the
 * decision-policy runner, and any future benchmark runner
 * share the same parsing semantics. The per-runner label
 * (`"adaptive-depth evaluation"`) is preserved verbatim
 * from the inline implementation so the existing tests'
 * error-message regex assertion (`/unknown adaptive-depth
 * evaluation cli flag/`) keeps passing.
 */
export function parseAdaptiveDepthEvaluationCli(argv: ReadonlyArray<string>): {
  artifactsDir: string;
} {
  const parsed = parseBenchmarkArtifactCli(argv, {
    // `--no-write` and `--no-stdout` are deliberately NOT
    // supported: the adaptive-depth runner's only flag
    // is `--artifacts <path>`. Passing them through would
    // silently broaden the runner's CLI surface, which the
    // brief explicitly forbids.
    supportNoWrite: false,
    supportNoStdout: false,
    contextLabel: "adaptive-depth evaluation",
  });
  return { artifactsDir: parsed.artifactsDir };
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
    process.stderr.write(`[curion-adaptive-depth-eval] FATAL ${msg}\n`);
    process.exit(1);
  });
}

/**
 * Main entry point. The function is async because
 * `runAdaptiveDepthEvaluation` is async. The function
 * is `void main()` (not exported) because the CLI is a
 * one-shot tool: the test surface imports the helper
 * directly.
 */
async function main(): Promise<void> {
  const opts = parseAdaptiveDepthEvaluationCli(process.argv.slice(2));
  const report = await runAdaptiveDepthEvaluation();
  const file = writeAdaptiveDepthEvaluationReport(report, opts.artifactsDir);
  process.stdout.write(formatAdaptiveDepthEvaluationReport(report) + "\n");
  process.stdout.write(`\nartifact written: ${file}\n`);
}
