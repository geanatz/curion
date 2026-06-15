/**
 * Benchmark-only held-out validation CLI runner.
 *
 * A small CLI that exercises the held-out
 * validation runner on the same 132-record
 * corpus the dev-set benchmark uses. The CLI
 * is independent of `src/benchmark/
 * retrieval-runner.ts` so the held-out
 * validation has its own entry point and its
 * own CLI flag namespace.
 *
 * Behavior:
 *   - Loads the held-out query set from
 *     `src/benchmark/held-out-queries.ts`.
 *   - Runs the chosen retrieval variant
 *     (`lexical` / `hybrid` / `hybrid-dense`)
 *     against the held-out queries and the
 *     fixed `BENCHMARK_RECORDS` corpus.
 *   - Builds the held-out validation report
 *     via `buildHeldOutReport` and writes the
 *     JSON artifact under `.cortex/benchmark/`
 *     (or `--artifacts <path>`).
 *   - Prints the human summary to stdout.
 *
 * Flags (mirrors the existing
 * `retrieval-runner.ts` flag style so the
 * held-out CLI is immediately familiar to a
 * reviewer of the dev-set CLI):
 *
 *   --variant <name>       Retrieval variant.
 *                          Default: hybrid-dense.
 *                          Allowed: lexical | hybrid |
 *                          hybrid-dense.
 *   --embedder <spec>      Dense embedder spec for the
 *                          hybrid-dense variant. Default:
 *                          stub-dense. See
 *                          `createDenseEmbedder` in
 *                          `./variants/dense-embedder.ts`
 *                          for the accepted shapes.
 *   --hybrid-k <n>         RRF smoothing constant for the
 *                          hybrid / hybrid-dense variants.
 *                          Default: 60.
 *   --top-k <n>            Top-K the ranker returns.
 *                          Default: 5.
 *   --artifacts <path>     Override the JSON report
 *                          directory. Default:
 *                          `.cortex/benchmark/` under
 *                          cwd.
 *
 * Security:
 *   - No API keys, no Authorization headers, no live
 *     network. The dense embedder is the local
 *     `Xenova/all-MiniLM-L6-v2` ONNX model (or the
 *     deterministic stub if `--embedder stub-dense`
 *     is passed).
 *   - The held-out queries are sanitized (no
 *     credentials, no raw text).
 *
 * Scope (benchmark-only):
 *   The CLI is read-only. It does not write to the
 *   production storage; the only on-disk effect is
 *   the JSON report under `.cortex/benchmark/`. It
 *   does NOT modify the production `recall(text)`
 *   behavior, the public MCP API, or the existing
 *   dev-set / audit / calibration / policy report
 *   shapes.
 *
 * Why this is a separate entry point:
 *   The dev-set retrieval runner is a 4k-line module
 *   that has been reviewed against the dev-set
 *   contract for many checkpoints. Adding the
 *   held-out CLI as a separate file keeps the
 *   held-out validation's contract surface narrow
 *   and auditable. A reviewer who wants to audit
 *   the held-out validation reads this file plus
 *   `src/benchmark/held-out-validation.ts` and
 *   `src/benchmark/held-out-queries.ts`; the
 *   dev-set runner is not part of the held-out
 *   read path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHeldOutReport,
  formatHeldOutReport,
  runHeldOutEvals,
  type HeldOutVariant,
  writeHeldOutReport,
  HELD_OUT_QUERIES,
} from "./held-out-validation.js";
import { createDenseEmbedder } from "./variants/dense-embedder.js";
import { type DenseEmbedder } from "./variants/dense-embedder.js";

// ---------------------------------------------------------------------------
// CLI config
// ---------------------------------------------------------------------------

interface HeldOutCliOptions {
  variant: HeldOutVariant;
  topK: number;
  hybridK: number;
  artifactsDir: string;
  embedderSpec: string;
  embedder?: DenseEmbedder;
}

/**
 * Parse the held-out CLI args. The parser is a
 * minimal hand-rolled loop that mirrors the
 * dev-set runner's flag style. A flag not
 * recognised is a hard error; the brief is
 * explicit that the held-out CLI is a narrow
 * tool, not a general benchmark runner.
 */
export function parseHeldOutCli(argv: ReadonlyArray<string>): HeldOutCliOptions {
  const opts: HeldOutCliOptions = {
    variant: "hybrid-dense",
    topK: 5,
    hybridK: 60,
    artifactsDir: path.join(process.cwd(), ".cortex", "benchmark"),
    embedderSpec: "stub-dense",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variant" && argv[i + 1] !== undefined) {
      const v = argv[++i]!;
      if (v !== "lexical" && v !== "hybrid" && v !== "hybrid-dense") {
        throw new Error(
          `--variant must be one of lexical|hybrid|hybrid-dense (got "${v}")`,
        );
      }
      opts.variant = v;
    } else if (a === "--embedder" && argv[i + 1] !== undefined) {
      opts.embedderSpec = argv[++i]!;
    } else if (a === "--hybrid-k" && argv[i + 1] !== undefined) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
          `--hybrid-k requires a positive finite number (got "${argv[i]}")`,
        );
      }
      opts.hybridK = n;
    } else if (a === "--top-k" && argv[i + 1] !== undefined) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
          `--top-k requires a positive finite number (got "${argv[i]}")`,
        );
      }
      opts.topK = n;
    } else if (a === "--artifacts" && argv[i + 1] !== undefined) {
      opts.artifactsDir = argv[++i]!;
    } else {
      throw new Error(`unknown held-out cli flag: "${a}"`);
    }
  }
  return opts;
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
    process.stderr.write(`[cortex-held-out] FATAL ${msg}\n`);
    process.exit(1);
  });
}

/**
 * Main entry point. The function is async
 * because the hybrid-dense path is async.
 * The function is `void main()` (not
 * exported) because the CLI is a
 * one-shot tool: the test surface imports
 * `parseHeldOutCli` and the
 * `held-out-validation` helpers
 * directly.
 */
async function main(): Promise<void> {
  const opts = parseHeldOutCli(process.argv.slice(2));
  // Resolve the embedder. The hybrid-dense
  // path requires an embedder; the lexical /
  // hybrid paths ignore it.
  if (opts.variant === "hybrid-dense") {
    const { embedder } = await createDenseEmbedder(opts.embedderSpec);
    opts.embedder = embedder;
  }
  // Run the held-out evals. The function is
  // async; the sync lexical / hybrid paths
  // complete synchronously inside the async
  // wrapper.
  const evalResult = await runHeldOutEvals({
    variant: opts.variant,
    queries: HELD_OUT_QUERIES,
    embedder: opts.embedder,
    topK: opts.topK,
    hybridK: opts.hybridK,
  });
  // Build the held-out report. The function
  // is pure; the same evals + queries + meta
  // produce the same report.
  const report = buildHeldOutReport({
    variant: opts.variant,
    topK: evalResult.topK,
    ...(evalResult.hybridK !== undefined
      ? { hybridK: evalResult.hybridK }
      : {}),
    ...(evalResult.embedderMetadata
      ? { embedderMetadata: evalResult.embedderMetadata }
      : {}),
    evals: evalResult.evals,
  });
  // Write the JSON artifact. The file
  // prefix is `retrieval-held-out-validation-`
  // so a reviewer can find the held-out
  // artifact next to the regular reports.
  const file = writeHeldOutReport(report, opts.artifactsDir);
  // Print the human summary. The CLI writes
  // to stdout (the held-out runner is not
  // the MCP stdio server, so writing to
  // stdout is fine here).
  process.stdout.write(formatHeldOutReport(report) + "\n");
  process.stdout.write(`\nartifact written: ${file}\n`);
}
