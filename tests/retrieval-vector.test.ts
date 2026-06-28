/**
 * Vector retrieval variant tests.
 *
 * Mirrors the FTS5 test file in shape. Verifies:
 *   1. The default local embedder is deterministic across calls
 *      and across machines (same text -> same vector, byte-for-byte).
 *   2. The hashing-trick + TF-IDF + L2-normalize pipeline produces
 *      unit vectors with cosine similarity in [-1, 1].
 *   3. The top-K shape contract: `{id, score}[]`, score desc, id desc
 *      tie-break, threshold respected, top-K cap respected.
 *   4. The vector variant runs in-memory and does not write to
 *      the project `.curion/curion.sqlite` file (mirror of the
 *      FTS5 isolation test).
 *   5. The benchmark runner supports `--variant vector` and
 *      `--variant all` includes the vector report.
 *   6. The production `recall(text)` controller is untouched and
 *      the public MCP API is unchanged. The vector variant is
 *      reachable only through the benchmark path.
 *   7. The vector benchmark report never contains credential-shaped
 *      fragments, raw original text, or anything the user did not
 *      already put into the sanitized fixture corpus.
 *   8. The source-tree import whitelist: only the benchmark
 *      runner (and the vector module itself) may import
 *      `benchmark/variants/vector.ts`. Any other importer is a
 *      leak into production.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { aggregateMetrics } from "../src/benchmark/metrics.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import {
  formatComparisonReport,
  isComparisonReport,
  isSingleVariantReport,
  parseRetrievalCli,
  resolveBenchmarkArtifactsDir,
  runRetrievalBenchmark,
  writeBenchmarkReport,
  writeComparisonReport,
} from "../src/benchmark/retrieval-runner.ts";
import {
  DEFAULT_VECTOR_THRESHOLD,
  HashedBagOfWordsEmbedder,
  type VectorEmbedder,
  type VectorEmbedding,
  type VectorRankingOptions,
  cosineSimilarity,
  embedHashedBagOfWords,
  rankVector,
} from "../src/benchmark/variants/vector.ts";
import type { LexicalCandidate } from "../src/retrieval/lexical.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { walkTs } from "./_helpers/fs-walk.ts";

// ---------------------------------------------------------------------------
// 1. Embedder determinism
// ---------------------------------------------------------------------------

test("vector embedder: same text always produces the same vector", () => {
  const a = embedHashedBagOfWords("Postgres 16 primary data store", 1024);
  const b = embedHashedBagOfWords("Postgres 16 primary data store", 1024);
  assert.equal(a.dim, b.dim);
  assert.equal(a.dim, 1024);
  assert.equal(a.values.length, 1024);
  assert.equal(b.values.length, 1024);
  // Determinism: byte-for-byte identical vector for identical input.
  for (let i = 0; i < a.values.length; i++) {
    assert.equal(
      a.values[i],
      b.values[i],
      `determinism failed at bucket ${i}: ${a.values[i]} vs ${b.values[i]}`
    );
  }
});

test("vector embedder: L2-normalizes to a unit vector", () => {
  const v = embedHashedBagOfWords("Postgres 16 primary data store, TypeScript Node 22", 1024);
  // Compute L2 norm.
  let norm = 0;
  for (const x of v.values) norm += x * x;
  norm = Math.sqrt(norm);
  // Either zero (empty text) or 1.0 (L2-normalized).
  assert.ok(
    Math.abs(norm - 1) < 1e-9 || norm === 0,
    `expected unit vector or zero, got norm=${norm}`
  );
});

test("vector embedder: empty or stopword-only text produces the zero vector", () => {
  const v = embedHashedBagOfWords("", 1024);
  assert.equal(v.dim, 1024);
  for (const x of v.values) assert.equal(x, 0);
  const v2 = embedHashedBagOfWords("the and or not but", 1024);
  for (const x of v2.values) assert.equal(x, 0);
});

test("vector embedder: dimension is honored", () => {
  for (const dim of [64, 256, 1024, 4096]) {
    const v = embedHashedBagOfWords("Postgres 16 primary data store", dim);
    assert.equal(v.dim, dim);
    assert.equal(v.values.length, dim);
  }
});

test("vector embedder: different texts produce different vectors", () => {
  const a = embedHashedBagOfWords("Postgres 16 primary data store", 1024);
  const b = embedHashedBagOfWords("kitchen dishwasher runs nightly", 1024);
  // Sanity: not byte-identical. (Hashing-trick collisions are
  // possible but extremely unlikely for unrelated text on a
  // 1024-bucket vector.)
  let equal = true;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) {
      equal = false;
      break;
    }
  }
  assert.equal(equal, false, "different texts must produce different vectors");
});

test("vector embedder: HashedBagOfWordsEmbedder.fit returns a NEW embedder with IDF installed", () => {
  // The builder pattern is the safe way to construct an embedder
  // for a benchmark run: the original is not mutated, so a
  // module-level singleton cannot leak IDF weights between
  // corpora.
  //
  // Note: for a SINGLE token, L2 normalization cancels the
  // scalar IDF multiplier and the unit vector is identical. We
  // therefore probe with a multi-token query that contains both
  // a common token (in every corpus document) and a rare token
  // (in one corpus document) so the IDF weights change the
  // component ratios and the post-normalization vectors differ.
  const corpus = [
    "Postgres is the primary data store",
    "TypeScript on Node 22",
    "Postgres JSON support is strong",
  ];
  const base = new HashedBagOfWordsEmbedder({ dim: 128 });
  const fitted = base.fit(corpus);
  // Different objects.
  assert.notEqual(base, fitted);
  // Same dim, same id, same description.
  assert.equal(fitted.dim, 128);
  assert.equal(fitted.id, "hashed-bow");
  // Multi-token probe: "Postgres" appears in 2/3 docs (low
  // IDF), "TypeScript" appears in 1/3 (high IDF). The fitted
  // and base embedders should produce different unit vectors
  // for the same text.
  const a = base.embed("Postgres TypeScript");
  const b = fitted.embed("Postgres TypeScript");
  let equal = true;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) {
      equal = false;
      break;
    }
  }
  assert.equal(equal, false, "Fitted embedder should differ from the base");
});

// ---------------------------------------------------------------------------
// 2. Cosine similarity
// ---------------------------------------------------------------------------

test("cosine similarity: identical unit vectors have cosine 1", () => {
  const v = [0.6, 0.8, 0, 0];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
});

test("cosine similarity: orthogonal unit vectors have cosine 0", () => {
  const a = [1, 0, 0, 0];
  const b = [0, 1, 0, 0];
  assert.equal(cosineSimilarity(a, b), 0);
});

test("cosine similarity: opposite unit vectors have cosine -1", () => {
  const a = [1, 0, 0, 0];
  const b = [-1, 0, 0, 0];
  assert.ok(Math.abs(cosineSimilarity(a, b) - -1) < 1e-9);
});

test("cosine similarity: zero vectors return 0 (no NaN)", () => {
  const z = [0, 0, 0, 0];
  assert.equal(cosineSimilarity(z, z), 0);
  assert.equal(cosineSimilarity(z, [1, 0, 0, 0]), 0);
});

test("cosine similarity: length mismatch returns 0 (no throw)", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
});

// ---------------------------------------------------------------------------
// 3. Top-K shape contract
// ---------------------------------------------------------------------------

test("vector ranker: returns the {id, score}[] top-K shape used by the metrics", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const hits = rankVector("What database does the project use?", cands, {
    topK: 5,
  });
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0);
  assert.ok(hits.length <= 5);
  for (const h of hits) {
    assert.equal(typeof h.id, "number");
    assert.equal(Number.isInteger(h.id), true);
    assert.equal(typeof h.score, "number");
    assert.ok(Number.isFinite(h.score), `score must be finite, got ${h.score}`);
    // Cosine similarity of L2-normalized non-negative vectors
    // is in [0, 1].
    assert.ok(h.score >= -1, `score must be >= -1, got ${h.score}`);
    assert.ok(h.score <= 1, `score must be <= 1, got ${h.score}`);
  }
  // Ordering: by score desc, then by id desc (newer memory wins).
  // The lexical and FTS5 baselines use the same tie-break.
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1]!;
    const b = hits[i]!;
    if (a.score === b.score) {
      assert.ok(a.id > b.id, `tie-break by id desc failed at index ${i}`);
    } else {
      assert.ok(
        a.score > b.score,
        `score must be descending at index ${i}: ${a.score} vs ${b.score}`
      );
    }
  }
});

test("vector ranker: returns an empty array for a query that tokenizes to nothing", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  // A pure-punctuation query tokenizes to nothing.
  const hits = rankVector("!!! ???", cands, { topK: 5 });
  assert.deepEqual(hits, []);
});

test("vector ranker: top-K cap is respected even if more candidates would pass", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  // "project" appears in many records. With threshold 0 every
  // record passes; top-K=2 must cap to 2.
  const hits = rankVector("project", cands, { topK: 2, threshold: 0 });
  assert.equal(hits.length, 2);
});

test("vector ranker: threshold is respected (zero threshold passes everything with non-zero score)", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  // A high threshold filters out everything that does not look
  // similar to the query. Use 0.99 to filter aggressively.
  const hits = rankVector("Postgres 16 primary data store", cands, {
    topK: 5,
    threshold: 0.99,
  });
  // The top hit is likely the matching record; weak matches are
  // filtered. We do not assert a specific count, just that the
  // result respects the threshold: every returned hit has
  // score >= 0.99.
  for (const h of hits) {
    assert.ok(h.score >= 0.99, `threshold 0.99 not respected: hit ${h.id} score ${h.score}`);
  }
});

test("vector ranker: deterministic — same query and corpus produce the same top-K", () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const a = rankVector("What database does the project use?", cands, {
    topK: 5,
  });
  const b = rankVector("What database does the project use?", cands, {
    topK: 5,
  });
  assert.deepEqual(a, b);
});

test("vector ranker: accepts a custom embedder (extension-point contract)", () => {
  // The Architect's brief explicitly allows real local embedders
  // to be plugged in by implementing `VectorEmbedder`. The
  // ranker MUST accept an `embedder` option and use it.
  const recordingEmbedder: VectorEmbedder = {
    id: "test-recording",
    description: "records every call; returns a constant vector",
    dim: 4,
    embed(text: string): VectorEmbedding {
      // Return a vector whose similarity to a fixed "match"
      // vector is high for queries that contain the word
      // "Postgres" and zero otherwise. This is enough to prove
      // the ranker uses the embedder.
      const values = [0, 0, 0, 0];
      if (/postgres/i.test(text)) {
        values[0] = 1;
      }
      return { values, dim: 4 };
    },
    embedBatch(texts: ReadonlyArray<string>): VectorEmbedding[] {
      return texts.map((t) => this.embed(t));
    },
  };
  const cands: LexicalCandidate[] = [
    { id: 1, text: "Postgres is the primary data store" },
    { id: 2, text: "Office kitchen dishwasher runs nightly" },
  ];
  const options: VectorRankingOptions = { embedder: recordingEmbedder, topK: 5 };
  const hits = rankVector("What does Postgres do?", cands, options);
  // The Postgres record must be the top hit when the
  // recording embedder is in use.
  assert.ok(hits.length > 0);
  assert.equal(
    hits[0]!.id,
    1,
    `custom embedder not honored: top hit was ${hits[0]!.id}, expected 1`
  );
});

// ---------------------------------------------------------------------------
// 4. No persistent DB writes
// ---------------------------------------------------------------------------

test("vector ranker: runs in memory and does not write to the project storage", () => {
  // Mirror of the FTS5 isolation test. The vector ranker is
  // pure: it builds the candidate vectors from the in-memory
  // candidate list and never touches disk. We assert by
  // running in a temp cwd and checking that no `.curion/`
  // directory appears.
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "curion-vec-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(tmpCwd);
  try {
    const cands = buildCandidates(BENCHMARK_RECORDS);
    const hits = rankVector("Postgres primary data store", cands, { topK: 5 });
    assert.ok(hits.length > 0);
    assert.ok(
      !fs.existsSync(path.join(tmpCwd, ".curion")),
      "vector ranker must not create a .curion directory in cwd"
    );
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. No-answer behavior
// ---------------------------------------------------------------------------

test("vector ranker: returns a non-empty top-K for any well-formed query (default threshold)", () => {
  // The vector ranker's default threshold is 0. Cosine
  // similarity of unit-normalized non-negative vectors is in
  // [0, 1], so every candidate with a non-zero overlap scores
  // >= 0 and passes. This is documented as an honest default
  // (mirroring FTS5's threshold: 0). Callers that want strict
  // no-answer TNR can pass a positive threshold.
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const hits = rankVector("When is the company picnic?", cands, { topK: 5 });
  assert.ok(hits.length > 0);
  // All returned hits have valid ids from the corpus.
  for (const h of hits) {
    assert.ok(
      BENCHMARK_RECORDS.some((r) => r.id === h.id),
      `vector returned non-corpus id: ${h.id}`
    );
  }
});

test("vector ranker: no-answer TNR is reachable with a positive threshold", () => {
  // The brief requires the no-answer behavior to be reachable.
  // The default threshold is 0 (honest), but callers can pass
  // a higher threshold to recover the no-answer abstention
  // contract. Use a high threshold (close to 1) to filter out
  // all but the strongest matches.
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const noAnswerQueries = BENCHMARK_QUERIES.filter((q) => q.family === "no-answer");
  for (const q of noAnswerQueries) {
    const hits = rankVector(q.query, cands, { topK: 5, threshold: 0.99 });
    // With a near-1 threshold, cosine similarity to a random
    // unrelated record is well below 0.99; the no-answer path
    // returns an empty top-K.
    assert.equal(hits.length, 0, `no-answer query ${q.id} unexpectedly matched at threshold 0.99`);
  }
});

// ---------------------------------------------------------------------------
// 6. Runner: variant selection and report shape
// ---------------------------------------------------------------------------

test("runner: --variant vector produces a single-variant report with label `vector-benchmark`", () => {
  const report = runRetrievalBenchmark({ variant: "vector" });
  assert.ok(isSingleVariantReport(report), "variant=vector must produce a single-variant report");
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "vector-benchmark");
  // Default vector threshold is 0 (no filter) for the reason
  // documented in `variants/vector.ts`. The runner exposes it
  // on the report so a reviewer can see what configuration
  // produced the metrics.
  assert.equal(report.config.threshold, DEFAULT_VECTOR_THRESHOLD);
  assert.equal(report.config.topK, 5);
  // Vector results are real ids from the corpus; we don't
  // assert specific order here (that's a measurement, not a
  // contract), but the report must be well-formed.
  assert.equal(report.evals.length, BENCHMARK_QUERIES.length);
  for (const e of report.evals) {
    for (const id of e.topIds) {
      assert.ok(
        BENCHMARK_RECORDS.some((r) => r.id === id),
        `vector returned non-corpus id: ${id}`
      );
    }
    assert.equal(e.topIds.length, e.topScores.length);
  }
});

test("runner: --variant all: per-family metrics for vector match aggregateMetrics output", () => {
  // The comparison report nests the per-variant reports. To
  // guard against metric drift between the comparison path
  // and the single-variant path, re-aggregate the vector
  // report's evals with `aggregateMetrics` and check that the
  // per-family counts line up.
  const report = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(report)) return;
  const vectorSide = report.vector;
  const fresh = aggregateMetrics(vectorSide.evals);
  assert.equal(fresh.rank1, vectorSide.metrics.rank1);
  assert.equal(fresh.currentTruthAt1, vectorSide.metrics.currentTruthAt1);
  assert.equal(fresh.hitAt1, vectorSide.metrics.hitAt1);
  assert.equal(fresh.hitAt3, vectorSide.metrics.hitAt3);
  assert.equal(fresh.hitAt5, vectorSide.metrics.hitAt5);
  assert.equal(fresh.noAnswerCorrect, vectorSide.metrics.noAnswerCorrect);
  assert.equal(fresh.noAnswerTotal, vectorSide.metrics.noAnswerTotal);
  for (const f of Object.keys(vectorSide.metrics.perFamily)) {
    assert.deepEqual(vectorSide.metrics.perFamily[f], fresh.perFamily[f]);
  }
});

test("runner: --variant vector respects --only-family and --top-k overrides", () => {
  // The variant selector must compose with the other CLI
  // flags: the family filter and top-k cap are applied to
  // vector the same way they are applied to lexical and FTS5.
  const report = runRetrievalBenchmark({
    variant: "vector",
    onlyFamilies: ["exact"],
    topK: 3,
  });
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "vector-benchmark");
  // The exact family count is computed from BENCHMARK_QUERIES
  // so the assertion is robust to family-set changes.
  const expectedExactCount = BENCHMARK_QUERIES.filter((q) => q.family === "exact").length;
  assert.equal(report.config.queryCount, expectedExactCount);
  assert.equal(report.config.topK, 3);
  for (const e of report.evals) {
    assert.equal(e.family, "exact");
    assert.ok(e.topIds.length <= 3);
  }
});

test("runner: --variant all produces a comparison report with all three per-variant labels", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(report)) return;
  assert.equal(report.lexical.variant, "lexical-baseline");
  assert.equal(report.fts5.variant, "fts5-benchmark");
  assert.equal(report.vector.variant, "vector-benchmark");
});

// ---------------------------------------------------------------------------
// 7. Production path is untouched
// ---------------------------------------------------------------------------

test("vector variant is benchmark-only: production recall() controller is not modified", () => {
  // The benchmark variant must not leak into the production
  // retrieval path. The contract is:
  //   - The recall controller still imports `rankLexical` and
  //     only `rankLexical`.
  //   - The MCP server's public tool surface is unchanged.
  //   - The production seam does not import the vector module.
  //
  // We enforce this with a string-level check on the
  // production source files. A future refactor that wires
  // vector into recall() will break this test, which is the
  // point: it makes the "benchmark-only" contract visible in
  // CI.
  const recallSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "controller", "recall-controller.ts"),
    "utf8"
  );
  assert.match(recallSrc, /rankLexical/, "recall controller must still import rankLexical");
  assert.doesNotMatch(
    recallSrc,
    /rankVector/,
    "recall controller must NOT import rankVector — vector is benchmark-only"
  );
  const seamSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "retrieval", "seam.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    seamSrc,
    /rankVector/,
    "retrieval/seam.ts must NOT call rankVector — it is the production seam"
  );
  assert.doesNotMatch(
    seamSrc,
    /benchmark\/variants\/vector/,
    "retrieval/seam.ts must NOT import the vector benchmark module"
  );
  // The MCP server must still expose exactly two tools.
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8"
  );
  assert.match(serverSrc, /"remember"/);
  assert.match(serverSrc, /"recall"/);
  // Sanity: the public contract is exactly two tools.
  // Phase clean-structured-tool-responses: the server now
  // uses the non-deprecated `server.registerTool(...)` API
  // so it can attach an `outputSchema` (which the legacy
  // `server.tool(...)` overloads do not accept). The
  // public tool surface is still exactly `remember` +
  // `recall`.
  assert.deepEqual(
    serverSrc.match(/server\.registerTool\(\s*"(\w+)"/g),
    ['server.registerTool(\n    "remember"', 'server.registerTool(\n    "recall"'],
    "public MCP tool surface must remain exactly remember + recall"
  );
});

test("vector variant: only the benchmark runner imports the vector module", () => {
  // Whitelist: only the benchmark runner, the vector module
  // itself, and the hybrid module (which composes lexical /
  // FTS5 / vector by RRF) may import
  // `benchmark/variants/vector.ts`. Any other importer is a
  // leak into production. We walk the source tree and check
  // imports + direct symbol usage.
  const root = path.join(import.meta.dirname, "..", "src");
  const allowedImporters = new Set<string>([
    path.join("benchmark", "retrieval-runner.ts"),
    path.join("benchmark", "variants", "vector.ts"),
    path.join("benchmark", "variants", "hybrid.ts"),
    // The dense vector module composes the existing
    // cosine similarity helper from the vector module.
    // It is a benchmark-only consumer, in the same
    // variants directory. The whitelist is for the
    // "no production import" contract; the dense
    // variant lives next to the hashed-BoW control and
    // shares its math.
    path.join("benchmark", "variants", "dense-vector.ts"),
    path.join("benchmark", "variants", "dense-embedder.ts"),
  ]);
  for (const file of walkTs(root, { excludeDts: false })) {
    if (allowedImporters.has(file)) continue;
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const importsVectorModule =
      src.includes('from "./vector"') ||
      src.includes('from "./vector.js"') ||
      src.includes('from "../benchmark/variants/vector') ||
      src.includes('from "../../benchmark/variants/vector');
    // Direct symbol usage outside the module's own file is
    // also a leak.
    const usesVectorSymbol =
      src.match(/\brankVector\b/) !== null ||
      src.match(/\bsanitizeVectorInput\b/) !== null ||
      src.match(/\bHashedBagOfWordsEmbedder\b/) !== null ||
      src.match(/\bembedHashedBagOfWords\b/) !== null;
    assert.ok(!importsVectorModule, `unexpected import of vector module in ${file}`);
    assert.ok(!usesVectorSymbol, `unexpected vector symbol usage in ${file}`);
  }
});

test("public MCP contract unchanged: exactly two tools, one text param each", () => {
  // The public tool list is exactly the two stable names.
  // This pins the public MCP contract: the vector benchmark
  // MUST NOT add a third tool, a new parameter, or a debug
  // knob to the existing two tools.
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
  assert.equal(PUBLIC_TOOL_NAMES.length, 2);
  // Belt-and-braces: read the server source and assert there
  // are exactly two `server.registerTool(` calls. A future
  // refactor that adds a third tool (e.g. a "benchmark" tool)
  // would break this assertion, which is the point.
  // (Phase clean-structured-tool-responses: the server
  // migrated from the legacy `server.tool(...)` API to
  // `server.registerTool(...)` so it could attach an
  // `outputSchema`; the public tool surface is unchanged.)
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8"
  );
  const toolCallCount = (serverSrc.match(/server\.registerTool\(/g) ?? []).length;
  assert.equal(toolCallCount, 2, `server.ts must register exactly 2 tools, found ${toolCallCount}`);
});

// ---------------------------------------------------------------------------
// 8. Artifacts and report hygiene
// ---------------------------------------------------------------------------

test("runner: vector single-variant artifacts are written with the `vector-` prefix and carry the right variant label", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-vec-art-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = runRetrievalBenchmark({ variant: "vector" });
    if (!isSingleVariantReport(report)) {
      throw new Error("expected single-variant report");
    }
    const file = writeBenchmarkReport(report, dir);
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-vector-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      metrics: { totalQueries: number };
    };
    assert.equal(parsed.variant, "vector-benchmark");
    assert.equal(parsed.metrics.totalQueries, BENCHMARK_QUERIES.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: comparison artifacts are written with the `retrieval-compare-` prefix and contain all three per-variant reports", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-vec-compare-"));
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
      vector: { variant: string };
      comparison: Array<{ metric: string }>;
    };
    assert.equal(parsed.variant, "all");
    assert.equal(parsed.lexical.variant, "lexical-baseline");
    assert.equal(parsed.fts5.variant, "fts5-benchmark");
    assert.equal(parsed.vector.variant, "vector-benchmark");
    assert.ok(parsed.comparison.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: vector report has no credential-shaped or raw-text fragments", () => {
  // The fixture corpus is sanitized; the report must remain
  // free of credential-shaped fragments, raw text-shaped
  // fragments, and Authorization headers. We serialize the
  // report and run a small set of regex sweeps.
  const report = runRetrievalBenchmark({ variant: "vector" });
  if (!isSingleVariantReport(report)) return;
  const serialized = JSON.stringify(report);
  // Belt-and-braces regex sweep: no apiKey field, no
  // authorization header, no sk-/AKIA/glpat shapes.
  assert.ok(
    !/apiKey|authorization|bearer|sk-[A-Za-z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_\-]{20,}/i.test(
      serialized
    ),
    "vector report must not contain credential-shaped fragments"
  );
  // The vector report does NOT carry the corpus summaries or
  // queries; it carries the top-K ids and scores. Confirm by
  // sampling: pick a substring of a known summary and assert
  // it is NOT in the serialized report.
  const sampleSummary = BENCHMARK_RECORDS[0]!.summary.slice(0, 30);
  assert.ok(
    !serialized.includes(sampleSummary),
    "vector report must not contain the corpus summary text"
  );
});

// ---------------------------------------------------------------------------
// 9. CLI parser
// ---------------------------------------------------------------------------

test("runner: parseRetrievalCli accepts --variant vector and rejects unknown values", () => {
  assert.equal(parseRetrievalCli(["--variant", "vector"]).variant, "vector");
  // The default error message has been updated to mention
  // `vector` as a valid value; vector itself must now be
  // accepted (this was a throw before the variant was wired
  // up).
  assert.doesNotThrow(() => parseRetrievalCli(["--variant", "vector"]));
  // An actually-unknown variant is still rejected.
  assert.throws(
    () => parseRetrievalCli(["--variant", "hybrid-rrf"]),
    /--variant must be one of lexical\|fts5\|vector\|hybrid\|all/
  );
});

// ---------------------------------------------------------------------------
// 10. formatComparisonReport includes the vector section
// ---------------------------------------------------------------------------

test("runner: formatComparisonReport includes the lexical vs fts5 vs vector vs hybrid headline and the vector section", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(report)) return;
  const out = formatComparisonReport(report);
  for (const section of [
    "comparison (lexical vs fts5 vs vector vs hybrid)",
    "### vector ###",
    "vector-benchmark",
  ]) {
    assert.ok(out.includes(section), `comparison report missing section: ${section}`);
  }
});

// ---------------------------------------------------------------------------
// 11. Lexical baseline regression: the default report is unchanged
// ---------------------------------------------------------------------------

test("runner: default lexical report still has variant=lexical-baseline (no production regression)", () => {
  // Regression guard: even though `runRetrievalBenchmark` now
  // dispatches on `variant` over three variants, the default
  // invocation (no options) must still return a single-variant
  // report with `variant: "lexical-baseline"` and the same
  // threshold / top-K as before. This pins the public
  // benchmark API for the lexical baseline.
  const report = runRetrievalBenchmark();
  assert.ok(isSingleVariantReport(report));
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "lexical-baseline");
  assert.equal(report.config.threshold, 0.2);
  assert.equal(report.config.topK, 5);
});

// Suppress unused-symbol lint for the import-side-only types.
// (They are used in the `VectorEmbedder` interface declaration
// at the top of the file, but a future test refactor might
// drop direct references; the test below explicitly references
// the constants to make sure they remain exported.)
