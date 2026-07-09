/**
 * Applied-simulation benchmark CLI runner.
 *
 * Runs the Phase 3 applied-simulation evaluation harness
 * (`src/benchmark/applied-simulation-evaluation.ts`) and writes the JSON
 * artifact under `.curion/benchmark/`.
 *
 * Flag surface:
 *   --artifacts <path>   override the artifact directory
 *                         (default: `.curion/benchmark/`)
 *   --no-write           suppress the JSON artifact
 *                         (human report still prints)
 *   --no-stdout          suppress the human report
 *                         (artifact still written)
 *
 * This runner does NOT support a live mode — applied simulation
 * is always scripted/offline/synthetic-only by design.
 *
 * Safety:
 *   - No network calls (scripted fetch only).
 *   - No production storage touched (temp DBs only).
 *   - No engine activation in active mode (shadow seam captures
 *     decisions, harness applies via storage lifecycle seams).
 *   - No changes to public MCP API or tool schemas.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  formatAppliedSimulationReport,
  runAppliedSimulationEvaluation,
  writeAppliedSimulationReport,
} from "./applied-simulation-evaluation.js";

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
    process.stderr.write(`[curion-applied-simulation] FATAL ${msg}\n`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const opts = parseBenchmarkArtifactCli(process.argv.slice(2), {
    supportNoWrite: true,
    supportNoStdout: true,
    contextLabel: "applied-simulation",
  });

  const report = await runAppliedSimulationEvaluation();
  let artifactPath: string | undefined;
  if (!opts.noWrite) {
    artifactPath = writeAppliedSimulationReport(report, opts.artifactsDir);
  }
  if (!opts.noStdout) {
    process.stdout.write(formatAppliedSimulationReport(report) + "\n");
    if (artifactPath) {
      process.stdout.write(`\nartifact written: ${artifactPath}\n`);
    }
  }
}
