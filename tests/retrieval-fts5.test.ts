/**
 * FTS5 retrieval variant tests.
 *
 * These tests cover the FTS5 benchmark variant
 * (`src/benchmark/variants/fts5.ts`) and the variant
 * selector on the benchmark runner.
 *
 * Contract under test:
 *   1. The FTS5 variant runs in a fully in-memory SQLite
 *      database. It must NOT open, read, or write the
 *      project `.cortex/cortex.sqlite` file.
 *   2. The FTS5 variant's top-K shape is identical to the
 *      lexical baseline's: `{id, score}[]`. This is what the
 *      benchmark metrics rely on.
 *   3. Query escaping prevents FTS5 syntax errors for inputs
 *      that contain operator characters, quoted phrases, and
 *      reserved keywords like `AND`, `OR`, `NOT`, `NEAR`.
 *   4. The benchmark runner supports `--variant lexical` (the
 *      default), `--variant fts5`, and `--variant all`. The
 *      report's `variant` field reflects the variant that
 *      produced it.
 *   5. FTS5 report metrics are computed correctly: rank1,
 *      currentTruthAt1, hit@1/3/5, no-answer TNR all line up
 *      with the underlying per-query evals.
 *   6. The production `recall(text)` controller is untouched
 *      and the public MCP API is unchanged. The FTS5 variant
 *      is reachable only through the benchmark path.
 *   7. The `--variant all` comparison report includes both
 *      per-variant reports plus a side-by-side comparison
 *      table, and the per-family metrics for each variant
 *      still match the `aggregateMetrics` output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import {
  buildFts5Index,
  normalizeFts5Score,
  rankFts5,
  sanitizeFts5Query,
  DEFAULT_FTS5_THRESHOLD,
} from "../src/benchmark/variants/fts5.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import type { LexicalCandidate } from "../src/retrieval/lexical.ts";
import {
  runRetrievalBenchmark,
  parseRetrievalCli,
  isSingleVariantReport,
  isComparisonReport,
  resolveBenchmarkArtifactsDir,
  writeBenchmarkReport,
  writeComparisonReport,
  formatComparisonReport,
} from "../src/benchmark/retrieval-runner.ts";
import { aggregateMetrics } from "../src/benchmark/metrics.ts";

// ---------------------------------------------------------------------------
// 1. In-memory index: no persistent DB writes
// ---------------------------------------------------------------------------

test("FTS5 index: uses an in-memory database and does not write to the project storage", () => {
  // Build the FTS5 index in a brand-new in-memory database.
  // The function MUST not write to disk. We verify by
  // asserting that the returned handle is backed by a
  // `:memory:` connection and that no `.cortex/cortex.sqlite`
  // file is created or modified in the test cwd. The test
  // runs in a temp cwd, so any accidental file write would
  // be visible here.
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fts5-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(tmpCwd);
  try {
    const idx = buildFts5Index(buildCandidates(BENCHMARK_RECORDS));
    try {
      assert.equal(idx.size, BENCHMARK_RECORDS.length);
      // better-sqlite3's `:memory:` connection is not
      // backed by a file. The simplest invariant we can
      // assert without reaching into the private handle is
      // "the `.cortex/` directory was NOT created".
      assert.ok(
        !fs.existsSync(path.join(tmpCwd, ".cortex")),
        "FTS5 index must not create a .cortex directory in cwd",
      );
      // A query against the in-memory index returns rows
      // for a known record.
      const row = idx.db
        .prepare(
          "SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? LIMIT 1",
        )
        .get(`"postgres"`);
      assert.ok(row !== undefined, "expected at least one FTS5 hit for 'postgres'");
    } finally {
      idx.close();
    }
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test("FTS5 index: loading 0 candidates still produces a queryable empty index", () => {
  const idx = buildFts5Index([]);
  try {
    assert.equal(idx.size, 0);
    const row = idx.db
      .prepare("SELECT COUNT(*) AS c FROM memories_fts")
      .get() as { c: number };
    assert.equal(row.c, 0);
  } finally {
    idx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Top-K shape contract
// ---------------------------------------------------------------------------

test("FTS5 ranker: returns the {id, score}[] top-K shape used by the metrics", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const hits = rankFts5("What database does the project use?", cands, {
    topK: 5,
  });
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0);
  assert.ok(hits.length <= 5);
  for (const h of hits) {
    assert.equal(typeof h.id, "number");
    assert.equal(Number.isInteger(h.id), true);
    assert.equal(typeof h.score, "number");
    // Score must be a finite, positive number in (0, 1] (the
    // squashed BM25). Threshold 0 is the default; we don't
    // expect exactly 0 because the squashing function
    // returns 0 only for an exact-zero BM25.
    assert.ok(Number.isFinite(h.score), `score must be finite, got ${h.score}`);
    assert.ok(h.score >= 0, `score must be non-negative, got ${h.score}`);
    assert.ok(h.score <= 1, `score must be <= 1, got ${h.score}`);
  }
  // Ordering: by score desc, then by id asc. The lexical
  // baseline uses the same tie-break.
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1]!;
    const b = hits[i]!;
    if (a.score === b.score) {
      assert.ok(a.id < b.id, `tie-break by id asc failed at index ${i}`);
    } else {
      assert.ok(
        a.score > b.score,
        `score must be descending at index ${i}: ${a.score} vs ${b.score}`,
      );
    }
  }
});

test("FTS5 ranker: returns an empty array for a query that tokenizes to nothing", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  // A pure-punctuation query tokenizes to [].
  const hits = rankFts5("!!! ???", cands, { topK: 5 });
  assert.deepEqual(hits, []);
});

test("FTS5 ranker: top-K cap is respected even if more candidates would pass", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  // "project" appears in many records; with OR semantics
  // FTS5 returns several. Top-K=2 must cap to 2.
  const hits = rankFts5("project", cands, { topK: 2, threshold: 0 });
  assert.equal(hits.length, 2);
});

// ---------------------------------------------------------------------------
// 3. Query escaping
// ---------------------------------------------------------------------------

test("FTS5 sanitizer: tokenizes and quotes a free-form query", () => {
  // Basic case: "What is Postgres?" -> the stopword filter
  // drops "is"; "postgres" is the only surviving content
  // token. FTS5 sees `"postgres"`.
  const out = sanitizeFts5Query("What is Postgres?");
  assert.equal(out, '"postgres"');
});

test("FTS5 sanitizer: drops FTS5 reserved words (AND, OR, NOT, NEAR)", () => {
  // Reserved words are stripped so a user query like
  // "Postgres OR MySQL" is not interpreted as a disjunction
  // by the FTS5 parser. The remaining tokens are joined
  // with " OR " to give the same disjunction semantics
  // explicitly.
  const out = sanitizeFts5Query("Postgres OR MySQL");
  assert.equal(out, '"postgres" OR "mysql"');
  // The other reserved words behave the same way.
  assert.equal(
    sanitizeFts5Query("Postgres AND MySQL"),
    '"postgres" OR "mysql"',
  );
  assert.equal(
    sanitizeFts5Query("Postgres NOT MySQL"),
    '"postgres" OR "mysql"',
  );
  assert.equal(
    sanitizeFts5Query("Postgres NEAR MySQL"),
    '"postgres" OR "mysql"',
  );
});

test("FTS5 sanitizer: query with operator characters does not throw and produces a safe match expression", () => {
  // Without the sanitizer, FTS5 would throw `fts5: syntax
  // error` on these inputs because `*`, `(`, `)`, `:`, `^`,
  // `-`, `+` are operator characters. The tokenizer strips
  // them before the sanitizer wraps the surviving tokens
  // in double quotes, so FTS5 sees only safe literals.
  const tricky = [
    'What is "Postgres" + CI?',
    "hello:world*foo(bar)",
    "a^b - c + d",
    'phrase with "quoted" words and *star*',
    "WEIRD (paren) [bracket] {brace}",
  ];
  for (const q of tricky) {
    const safe = sanitizeFts5Query(q);
    // Either a non-empty safe match expression (most cases)
    // or an empty string (a query that is all stopwords /
    // operator chars). Both are well-formed; the contract
    // is that FTS5 will accept them.
    assert.ok(typeof safe === "string", `sanitizer returned non-string for: ${q}`);
    // Round-trip through the FTS5 ranker: must not throw.
    const cands = buildCandidates(BENCHMARK_RECORDS);
    assert.doesNotThrow(() => {
      rankFts5(q, cands, { topK: 5 });
    }, `rankFts5 threw on tricky input: ${q}`);
  }
});

test("FTS5 sanitizer: empty / whitespace / stopword-only inputs return an empty match expression", () => {
  // An empty match expression MUST be handled by `rankFts5`
  // as "no query" (returns []); the sanitizer alone just
  // returns "" so the ranker can short-circuit.
  for (const q of ["", "   ", "the and or not", "123 456", "?!.,:"]) {
    assert.equal(
      sanitizeFts5Query(q),
      "",
      `expected empty match expression for: ${JSON.stringify(q)}`,
    );
  }
});

test("FTS5 ranker: rankFts5 returns [] for a no-answer-style query whose tokens are absent from the corpus", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  // "company picnic" has no document with these terms.
  const hits = rankFts5("When is the company picnic?", cands, { topK: 5 });
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// 4. Score normalization
// ---------------------------------------------------------------------------

test("FTS5 normalizeFts5Score: monotonic, positive, and bounded by 1", () => {
  // bm25 returns non-positive numbers where more negative is
  // better. The normalize function negates and squashes to
  // (0, 1] using `pos / (pos + k)`. Stronger (more negative)
  // BM25 means a LARGER `pos`, which means a LARGER squashed
  // score.
  assert.equal(normalizeFts5Score(0), 0);
  // Stronger (more negative) matches yield larger scores.
  assert.ok(normalizeFts5Score(-2) > normalizeFts5Score(-1));
  assert.ok(normalizeFts5Score(-4) > normalizeFts5Score(-2));
  assert.ok(normalizeFts5Score(-8) > normalizeFts5Score(-4));
  // The score is bounded above by 1 (asymptotic; never
  // reaches 1 for finite BM25).
  assert.ok(normalizeFts5Score(-1000) <= 1);
  assert.ok(normalizeFts5Score(-1000) > 0);
  // Non-finite inputs return 0.
  assert.equal(normalizeFts5Score(Number.NaN), 0);
  assert.equal(normalizeFts5Score(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeFts5Score(Number.NEGATIVE_INFINITY), 0);
});

test("FTS5 ranker: deterministic — same query and corpus produce the same top-K", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const a = rankFts5("What database does the project use?", cands, {
    topK: 5,
  });
  const b = rankFts5("What database does the project use?", cands, {
    topK: 5,
  });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 5. Runner: variant selection and report shape
// ---------------------------------------------------------------------------

test("runner: default variant is lexical and the report variant label is `lexical-baseline`", () => {
  // Backward-compat: callers that don't pass `variant` get
  // the existing lexical report shape unchanged.
  const report = runRetrievalBenchmark();
  assert.ok(
    isSingleVariantReport(report),
    "default run must produce a single-variant report",
  );
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "lexical-baseline");
  assert.equal(report.config.threshold, 0.2);
  assert.equal(report.config.topK, 5);
});

test("runner: --variant fts5 produces a single-variant report with label `fts5-benchmark`", () => {
  const report = runRetrievalBenchmark({ variant: "fts5" });
  assert.ok(
    isSingleVariantReport(report),
    "variant=fts5 must produce a single-variant report",
  );
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "fts5-benchmark");
  // The default FTS5 threshold is 0 (no filter) for the
  // reason documented in `variants/fts5.ts`. The runner
  // exposes it on the report so a reviewer can see what
  // configuration produced the metrics.
  assert.equal(report.config.threshold, DEFAULT_FTS5_THRESHOLD);
  assert.equal(report.config.topK, 5);
  // FTS5 results are real ids from the corpus; we don't
  // assert specific order here (that's a measurement, not a
  // contract), but the report must be well-formed.
  assert.equal(report.evals.length, BENCHMARK_QUERIES.length);
  for (const e of report.evals) {
    for (const id of e.topIds) {
      assert.ok(
        BENCHMARK_RECORDS.some((r) => r.id === id),
        `FTS5 returned non-corpus id: ${id}`,
      );
    }
    assert.equal(e.topIds.length, e.topScores.length);
  }
});

test("runner: --variant all produces a comparison report with all three per-variant reports", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  assert.ok(
    isComparisonReport(report),
    "variant=all must produce a comparison report",
  );
  if (!isComparisonReport(report)) return;
  assert.equal(report.variant, "all");
  assert.equal(report.lexical.variant, "lexical-baseline");
  assert.equal(report.fts5.variant, "fts5-benchmark");
  assert.equal(report.vector.variant, "vector-benchmark");
  // All per-variant reports must cover the same queries.
  assert.equal(report.lexical.evals.length, report.fts5.evals.length);
  assert.equal(report.lexical.evals.length, report.vector.evals.length);
  assert.equal(
    report.lexical.evals.length,
    BENCHMARK_QUERIES.length,
  );
  // The comparison table is a non-empty array of metric
  // rows; every row is a labeled integer.
  assert.ok(Array.isArray(report.comparison));
  assert.ok(report.comparison.length > 0);
  for (const r of report.comparison) {
    assert.equal(typeof r.metric, "string");
    assert.equal(typeof r.lexical, "number");
    assert.equal(typeof r.fts5, "number");
    assert.equal(typeof r.vector, "number");
    assert.equal(r.delta, r.fts5 - r.lexical);
  }
});

test("runner: --variant all: per-family metrics for each variant match aggregateMetrics output", () => {
  // The comparison report nests the per-variant reports. To
  // guard against metric drift between the comparison path
  // and the single-variant path, re-aggregate each variant's
  // evals with `aggregateMetrics` and check that the
  // per-family counts line up.
  const report = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(report)) return;
  for (const side of [report.lexical, report.fts5] as const) {
    const fresh = aggregateMetrics(side.evals);
    assert.equal(fresh.rank1, side.metrics.rank1);
    assert.equal(fresh.currentTruthAt1, side.metrics.currentTruthAt1);
    assert.equal(fresh.hitAt1, side.metrics.hitAt1);
    assert.equal(fresh.hitAt3, side.metrics.hitAt3);
    assert.equal(fresh.hitAt5, side.metrics.hitAt5);
    assert.equal(fresh.noAnswerCorrect, side.metrics.noAnswerCorrect);
    assert.equal(fresh.noAnswerTotal, side.metrics.noAnswerTotal);
    for (const f of Object.keys(side.metrics.perFamily)) {
      assert.deepEqual(side.metrics.perFamily[f], fresh.perFamily[f]);
    }
  }
});

test("runner: parseRetrievalCli accepts --variant lexical|fts5|vector|hybrid|all and rejects unknown values", () => {
  assert.equal(parseRetrievalCli(["--variant", "lexical"]).variant, "lexical");
  assert.equal(parseRetrievalCli(["--variant", "fts5"]).variant, "fts5");
  assert.equal(parseRetrievalCli(["--variant", "vector"]).variant, "vector");
  assert.equal(parseRetrievalCli(["--variant", "hybrid"]).variant, "hybrid");
  assert.equal(parseRetrievalCli(["--variant", "all"]).variant, "all");
  // Default: omitted variant. We assert by running and
  // checking the result.
  assert.equal(parseRetrievalCli([]).variant, undefined);
  // Unknown variants are rejected.
  assert.throws(
    () => parseRetrievalCli(["--variant", "hybrid-rrf"]),
    /--variant must be one of lexical\|fts5\|vector\|hybrid\|all/,
  );
  // Missing argument.
  assert.throws(() => parseRetrievalCli(["--variant"]), /--variant/);
});

test("runner: --variant fts5 respects --only-family and --top-k overrides", () => {
  // The variant selector must compose with the other CLI
  // flags: the family filter and top-k cap are applied to
  // FTS5 the same way they are applied to lexical.
  const report = runRetrievalBenchmark({
    variant: "fts5",
    onlyFamilies: ["exact"],
    topK: 3,
  });
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "fts5-benchmark");
  // The exact family count is computed from BENCHMARK_QUERIES
  // so the assertion is robust to family-set changes.
  const expectedExactCount = BENCHMARK_QUERIES.filter(
    (q) => q.family === "exact",
  ).length;
  assert.equal(report.config.queryCount, expectedExactCount);
  assert.equal(report.config.topK, 3);
  for (const e of report.evals) {
    assert.equal(e.family, "exact");
    assert.ok(e.topIds.length <= 3);
  }
});

// ---------------------------------------------------------------------------
// 6. Production path is untouched
// ---------------------------------------------------------------------------

test("FTS5 variant is benchmark-only: production recall() controller is not modified", () => {
  // The benchmark variant must not leak into the production
  // retrieval path. The contract is:
  //   - The recall controller (`src/controller/recall-controller.ts`)
  //     still imports `rankLexical` and only `rankLexical`.
  //   - The MCP server's public tool surface is unchanged.
  //
  // We enforce this with a string-level check on the
  // production source files. A future refactor that wires
  // FTS5 into recall() will break this test, which is the
  // point: it makes the "benchmark-only" contract visible
  // in CI.
  const recallSrc = fs.readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "src",
      "controller",
      "recall-controller.ts",
    ),
    "utf8",
  );
  assert.match(
    recallSrc,
    /rankLexical/,
    "recall controller must still import rankLexical",
  );
  assert.doesNotMatch(
    recallSrc,
    /rankFts5/,
    "recall controller must NOT import rankFts5 — FTS5 is benchmark-only",
  );
  // The production seam (`retrieval/seam.ts`) is independent
  // of the FTS5 module. The seam's docstring may mention
  // FTS5 as a future variant (the comment is from the MVP
  // design), but the file MUST NOT import the FTS5 module
  // or call `rankFts5` directly. A future refactor that
  // wires FTS5 into the seam (the planned production
  // upgrade) will break this assertion, which is the
  // intended upgrade signal.
  const seamSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "retrieval", "seam.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    seamSrc,
    /rankFts5/,
    "retrieval/seam.ts must NOT call rankFts5 — it is the production seam",
  );
  assert.doesNotMatch(
    seamSrc,
    /benchmark\/variants\/fts5/,
    "retrieval/seam.ts must NOT import the FTS5 benchmark module",
  );
});

test("FTS5 variant: only the benchmark runner imports the FTS5 module", () => {
  // Whitelist: only the benchmark runner, the FTS5 module
  // itself, and the hybrid module (which composes lexical /
  // FTS5 / vector by RRF) may import
  // `benchmark/variants/fts5.ts`. Any other importer is a
  // leak into production. We walk the source tree and check
  // imports + direct symbol usage.
  const root = path.join(import.meta.dirname, "..", "src");
  const allowedImporters = new Set<string>([
    path.join("benchmark", "retrieval-runner.ts"),
    path.join("benchmark", "variants", "fts5.ts"),
    path.join("benchmark", "variants", "hybrid.ts"),
  ]);
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full));
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }
  for (const file of walk(root)) {
    const rel = path.relative(root, file);
    if (allowedImporters.has(rel)) continue;
    const src = fs.readFileSync(file, "utf8");
    // The relative import path is the canonical form
    // (`./fts5.js` is what TypeScript emits for ESM).
    const importsFts5Module =
      src.includes("from \"./fts5\"") ||
      src.includes("from \"./fts5.js\"") ||
      src.includes("from \"../benchmark/variants/fts5") ||
      src.includes("from \"../../benchmark/variants/fts5");
    // Direct symbol usage outside the module's own file is
    // also a leak.
    const usesFts5Symbol =
      src.match(/\brankFts5\b/) !== null ||
      src.match(/\bsanitizeFts5Query\b/) !== null ||
      src.match(/\bbuildFts5Index\b/) !== null;
    assert.ok(
      !importsFts5Module,
      `unexpected import of FTS5 module in ${rel}`,
    );
    assert.ok(
      !usesFts5Symbol,
      `unexpected FTS5 symbol usage in ${rel}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Artifacts
// ---------------------------------------------------------------------------

test("runner: FTS5 single-variant artifacts are written with the `fts5-` prefix and carry the right variant label", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fts5-art-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = runRetrievalBenchmark({ variant: "fts5" });
    if (!isSingleVariantReport(report)) {
      throw new Error("expected single-variant report");
    }
    const file = writeBenchmarkReport(report, dir);
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-fts5-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      metrics: { totalQueries: number };
    };
    assert.equal(parsed.variant, "fts5-benchmark");
    assert.equal(parsed.metrics.totalQueries, BENCHMARK_QUERIES.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: comparison artifacts are written with the `retrieval-compare-` prefix and contain both per-variant reports", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fts5-compare-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = runRetrievalBenchmark({ variant: "all" });
    if (!isComparisonReport(report)) {
      throw new Error("expected comparison report");
    }
    const file = writeComparisonReport(report, dir);
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-compare-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      lexical: { variant: string };
      fts5: { variant: string };
      comparison: Array<{ metric: string }>;
    };
    assert.equal(parsed.variant, "all");
    assert.equal(parsed.lexical.variant, "lexical-baseline");
    assert.equal(parsed.fts5.variant, "fts5-benchmark");
    assert.ok(parsed.comparison.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: formatComparisonReport includes the lexical vs fts5 vs vector vs hybrid headline and all per-variant sections", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(report)) return;
  const out = formatComparisonReport(report);
  for (const section of [
    "comparison (lexical vs fts5 vs vector vs hybrid)",
    "rank1 (positive)",
    "### lexical ###",
    "### fts5 ###",
    "### vector ###",
    "### hybrid ###",
    "lexical-baseline",
    "fts5-benchmark",
    "vector-benchmark",
    "hybrid-benchmark",
  ]) {
    assert.ok(
      out.includes(section),
      `comparison report missing section: ${section}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Per-family FTS5 metrics are well-formed
// ---------------------------------------------------------------------------

test("FTS5 report: per-family metrics cover the corpus families and add up to total queries", () => {
  const report = runRetrievalBenchmark({ variant: "fts5" });
  if (!isSingleVariantReport(report)) return;
  let total = 0;
  const seen = new Set<string>();
  for (const f of Object.keys(report.metrics.perFamily)) {
    total += report.metrics.perFamily[f]!.total;
    seen.add(f);
  }
  assert.equal(total, report.metrics.totalQueries);
  for (const f of ["exact", "paraphrase", "temporal", "multi-hop", "no-answer", "orientation"]) {
    assert.ok(
      seen.has(f),
      `FTS5 report missing family: ${f}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Lexical baseline regression: the default report is unchanged
// ---------------------------------------------------------------------------

test("runner: default lexical report still has variant=lexical-baseline (no production regression)", () => {
  // Regression guard: even though `runRetrievalBenchmark`
  // now dispatches on `variant`, the default invocation
  // (no options) must still return a single-variant report
  // with `variant: "lexical-baseline"` and the same
  // threshold / top-K as before. This pins the public
  // benchmark API for the lexical baseline.
  const report = runRetrievalBenchmark();
  assert.ok(isSingleVariantReport(report));
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "lexical-baseline");
  assert.equal(report.config.threshold, 0.2);
  assert.equal(report.config.topK, 5);
  // Same set of failures as before: two paraphrase
  // failures (`para-storage-detail` and
  // `para-architecture-decisions`). If a future change to
  // the corpus or the ranker alters this, the regression
  // is intentional and this assertion is the place to
  // update it.
  const failureIds = new Set(report.failures.map((f) => f.queryId));
  assert.ok(
    failureIds.has("para-storage-detail"),
    "expected para-storage-detail to be a lexical failure",
  );
  assert.ok(
    failureIds.has("para-architecture-decisions"),
    "expected para-architecture-decisions to be a lexical failure",
  );
});
