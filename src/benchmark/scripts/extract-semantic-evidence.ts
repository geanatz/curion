/**
 * Benchmark-only semantic-evidence extractor.
 *
 * Reads the EmbeddingGemma hybrid-dense verify
 * log (a previously measured run, NOT a fresh
 * benchmark) and emits the static semantic-
 * evidence JSON file the false-abstention damage
 * runner consumes.
 *
 * Why this exists:
 *   The damage runner's `--semantic-evidence`
 *   flag expects a `{source, byQueryId}` JSON
 *   file. The hand-curated evidence is
 *   deterministic, but a reviewer who wants to
 *   regenerate the evidence from the source log
 *   (e.g. after a corpus revision) runs this
 *   script. The script is small, pure, and
 *   deterministic: it parses the log line by
 *   line, extracts every `rank-1 miss` block, and
 *   writes the JSON.
 *
 * The script does NOT call any provider, any
 * ranker, or any external service. It does NOT
 * re-run the EmbeddingGemma benchmark; it
 * consumes the previously measured log.
 *
 * CLI:
 *   tsx src/benchmark/scripts/extract-semantic-evidence.ts \
 *     --log <log-path> --out <json-path> \
 *     --source <source-string> --model <model-id>
 *
 * Default `--log`: `.curion/verify-logs/embeddinggemma-hybrid-dense.log`.
 * Default `--out`: `src/benchmark/data/false-abstention-damage-semantic-evidence.json`.
 * Default `--source`: `embeddinggemma-hybrid-dense-176-queries-v1`.
 * Default `--model`: `onnx-community/embeddinggemma-300m-ONNX`.
 *
 * Output shape (the runner consumes it
 * verbatim):
 *   {
 *     "source": "<source-string>",
 *     "model":  "<model-id>",
 *     "logSource": "<log-path>",
 *     "byQueryId": { "<queryId>": "miss", ... },
 *   }
 */

import fs from "node:fs";
import path from "node:path";

interface CliArgs {
  log: string;
  out: string;
  source: string;
  model: string;
  variant: string;
  corpus: string;
  metric: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = {
    log: ".curion/verify-logs/embeddinggemma-hybrid-dense.log",
    out: "src/benchmark/data/false-abstention-damage-semantic-evidence.json",
    source: "embeddinggemma-hybrid-dense-176-queries-v1",
    model: "onnx-community/embeddinggemma-300m-ONNX",
    variant: "hybrid-dense (lexical + fts5 + vector-dense RRF, k=60)",
    corpus: "132-record / 176-query adversarial-expansion checkpoint",
    metric: "rank-1 outcome on positive queries (rank1=false -> 'miss')",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log" && i + 1 < argv.length) out.log = argv[++i]!;
    else if (a === "--out" && i + 1 < argv.length) out.out = argv[++i]!;
    else if (a === "--source" && i + 1 < argv.length) out.source = argv[++i]!;
    else if (a === "--model" && i + 1 < argv.length) out.model = argv[++i]!;
    else if (a === "--variant" && i + 1 < argv.length) out.variant = argv[++i]!;
    else if (a === "--corpus" && i + 1 < argv.length) out.corpus = argv[++i]!;
    else if (a === "--metric" && i + 1 < argv.length) out.metric = argv[++i]!;
  }
  return out;
}

interface ExtractedMiss {
  queryId: string;
  family: string;
}

/**
 * Parse the rank-1 misses block from a
 * retrieval-runner log. The expected block
 * format is the existing runner's
 * `--- rank-1 misses ... ---` block: lines
 * like `     [family] queryId`. The function
 * returns the de-duplicated miss set; the
 * `no-answer` family is excluded (the
 * damage analysis is on POSITIVE queries,
 * and a no-answer query's rank-1 hit is
 * confabulation, not a positive miss).
 */
export function extractRank1MissesFromLog(logText: string): ExtractedMiss[] {
  const out: ExtractedMiss[] = [];
  const seen = new Set<string>();
  // Match lines that look like:
  //   "  [family-name] query-id"
  // The runner prefixes each line with 3+
  // spaces and the `[family]` block is
  // surrounded by `[` and `]`.
  const re = /^\s{2,}\[([a-z\-]+)\]\s+([a-z0-9\-]+)\s*$/gm;
  for (const m of logText.matchAll(re)) {
    const family = m[1]!;
    const queryId = m[2]!;
    if (family === "no-answer") continue;
    if (seen.has(queryId)) continue;
    seen.add(queryId);
    out.push({ family, queryId });
  }
  return out;
}

export function main(argv: ReadonlyArray<string>): {
  outPath: string;
  count: number;
} {
  const args = parseArgs(argv);
  const logText = fs.readFileSync(args.log, "utf8");
  const misses = extractRank1MissesFromLog(logText);
  const byQueryId: Record<string, "miss"> = {};
  for (const m of misses) byQueryId[m.queryId] = "miss";
  const json: Record<string, unknown> = {
    _doc: "Semantic evidence for the false-abstention damage analysis. The 'byQueryId' map records the rank-1 outcome of an EmbeddingGemma hybrid-dense benchmark on the same 132-record / 176-query corpus the lexical baseline uses. A 'miss' entry means the dense ranker rank-1-missed the query. The 'source' field is the canonical citation the runner surfaces in the report's rollup block.",
    source: args.source,
    model: args.model,
    corpus: args.corpus,
    variant: args.variant,
    metric: args.metric,
    logSource: args.log,
    byQueryId,
  };
  // Make sure the output directory exists.
  const outDir = path.dirname(args.out);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(args.out, JSON.stringify(json, null, 2) + "\n", "utf8");
  return { outPath: args.out, count: misses.length };
}

if (
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  /extract-semantic-evidence\.(ts|js)$/.test(process.argv[1])
) {
  const result = main(process.argv.slice(2));
  process.stdout.write(
    `[extract-semantic-evidence] wrote ${result.count} misses to ${result.outPath}\n`
  );
}
