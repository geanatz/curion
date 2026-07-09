/**
 * Shadow-comparison benchmark CLI runner.
 *
 * Runs the shadow-comparison evaluation harness
 * (`src/benchmark/shadow-comparison.ts`) and writes the JSON
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
 * This runner does NOT support a live mode — shadow comparison
 * is always scripted/offline/synthetic-only by design.
 *
 * Safety:
 *   - No network calls (scripted fetch only).
 *   - No production storage touched (temp DBs only).
 *   - No engine activation (shadow decisions captured only).
 *   - No changes to public MCP API or tool schemas.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  formatShadowComparisonReport,
  runShadowComparison,
  writeShadowComparisonReport,
} from "./shadow-comparison.js";

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
    process.stderr.write(`[curion-shadow-comparison] FATAL ${msg}\n`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const opts = parseBenchmarkArtifactCli(process.argv.slice(2), {
    supportNoWrite: true,
    supportNoStdout: true,
    contextLabel: "shadow-comparison",
  });

  const report = await runShadowComparison();
  let artifactPath: string | undefined;
  if (!opts.noWrite) {
    artifactPath = writeShadowComparisonReport(report, opts.artifactsDir);
  }
  if (!opts.noStdout) {
    process.stdout.write(formatShadowComparisonReport(report) + "\n");
    if (artifactPath) {
      process.stdout.write(`\nartifact written: ${artifactPath}\n`);
    }
  }
}
