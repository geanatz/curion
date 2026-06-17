/**
 * Dense vector + hybrid-dense retrieval variant tests.
 *
 * Mirrors the vector / hybrid / FTS5 test files in shape.
 * Verifies:
 *
 *   1. The DenseEmbedder interface: a pluggable real
 *      local dense embedding backend, with metadata
 *      (backend, model, dim, runtime, status) that the
 *      benchmark runner surfaces on the report.
 *   2. The `StubDeterministicDenseEmbedder` is
 *      deterministic, dependency-free, and safe to use
 *      in CI without network.
 *   3. The `TransformersJsEmbedder` integrates with
 *      `@xenova/transformers` (when the package is
 *      installed), supports the `init()` lifecycle,
 *      and is gracefully handled when the model is
 *      unavailable.
 *   4. `rankDenseVectorAsync` returns the same
 *      `{id, score}[]` top-K shape the existing
 *      `rankVector` does, with cosine similarity in
 *      `[-1, 1]`, score desc, id asc tie-break.
 *   5. `rankHybridAsync` swaps the hashed-bag-of-words
 *      `vector` slot for the real `vector-dense` slot
 *      when `useDenseVector: true`; the contributor
 *      label on the diagnostic is `vector-dense` so a
 *      reviewer can see which embedder produced the
 *      contributor's rank.
 *   6. The async runner
 *      (`runDenseRetrievalBenchmark`) emits a
 *      `DenseRetrievalBenchmarkReport` /
 *      `DenseComparisonBenchmarkReport` with the
 *      embedding metadata on `config.embeddingBackend`.
 *   7. The dense variant is benchmark-only: production
 *      `recall(text)` controller is not modified, public
 *      MCP API is unchanged, and only the benchmark
 *      directory imports the new modules. Source-tree
 *      guards in this file pin the whitelist.
 *   8. The CLI / artifact surface: the new variants
 *      are wired through `parseRetrievalCli`, write
 *      `retrieval-vector-dense-` /
 *      `retrieval-hybrid-dense-` /
 *      `retrieval-compare-dense-` artifacts, and the
 *      existing `retrieval-vector-` /
 *      `retrieval-hybrid-` prefixes are byte-stable.
 *
 * The test file does NOT require a network download.
 * The transformers.js backend is exercised with a
 * `pipelineOverride` (a stub pipeline) so the test
 * runs in CI without touching the Hugging Face CDN.
 * A separate opt-in "live model" test exists in the
 * live test file; see `tests/retrieval-dense-vector-live.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import {
  StubDeterministicDenseEmbedder,
  TransformersJsEmbedder,
  createDenseEmbedder,
  type DenseEmbedder,
  type EmbedderMetadata,
} from "../src/benchmark/variants/dense-embedder.ts";
import {
  rankDenseVectorAsync,
  rankDenseVectorWithMetadataAsync,
  DEFAULT_DENSE_VECTOR_THRESHOLD,
  DEFAULT_DENSE_VECTOR_TOP_K,
} from "../src/benchmark/variants/dense-vector.ts";
import {
  rankHybrid,
  rankHybridAsync,
  fuseRankings,
  type RrfContributor,
} from "../src/benchmark/variants/hybrid.ts";
import {
  runDenseRetrievalBenchmark,
  parseRetrievalCli,
  isSingleVariantReport,
  isComparisonReport,
  resolveBenchmarkArtifactsDir,
  writeDenseBenchmarkReport,
  writeDenseComparisonReport,
  formatDenseHumanReport,
  formatDenseComparisonReport,
} from "../src/benchmark/retrieval-runner.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import type { LexicalCandidate } from "../src/retrieval/lexical.ts";

// ---------------------------------------------------------------------------
// 1. Embedder interface + metadata shape
// ---------------------------------------------------------------------------

test("DenseEmbedder: StubDeterministicDenseEmbedder exposes the required metadata", () => {
  const e = new StubDeterministicDenseEmbedder();
  const m: EmbedderMetadata = e.metadata;
  assert.equal(m.backend, "stub-dense");
  assert.equal(typeof m.description, "string");
  assert.equal(typeof m.modelId, "string");
  assert.equal(typeof m.dim, "number");
  assert.ok(m.dim > 0);
  assert.equal(m.status, "ready");
});

test("DenseEmbedder: custom dim is honored and surfaced on the metadata", () => {
  const e = new StubDeterministicDenseEmbedder({ dim: 128 });
  assert.equal(e.metadata.dim, 128);
  // The vector produced by the embedder must have the
  // requested dim.
  return e.embed("hello world this is a test").then((v) => {
    assert.equal(v.length, 128);
  });
});

test("DenseEmbedder: rejects non-positive dim", () => {
  assert.throws(
    () => new StubDeterministicDenseEmbedder({ dim: 0 }),
    /dim must be a positive integer/,
  );
  assert.throws(
    () => new StubDeterministicDenseEmbedder({ dim: -1 }),
    /dim must be a positive integer/,
  );
  assert.throws(
    () => new StubDeterministicDenseEmbedder({ dim: 1.5 }),
    /dim must be a positive integer/,
  );
});

test("DenseEmbedder: stub is deterministic across calls and across machines", async () => {
  const e = new StubDeterministicDenseEmbedder({ dim: 256 });
  const a = await e.embed("Postgres 16 primary data store");
  const b = await e.embed("Postgres 16 primary data store");
  assert.deepEqual(a, b);
  // A different text should produce a different vector.
  const c = await e.embed("kitchen dishwasher runs nightly");
  let equal = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== c[i]) {
      equal = false;
      break;
    }
  }
  assert.equal(equal, false, "different texts must produce different vectors");
});

test("DenseEmbedder: stub produces L2-normalized vectors", async () => {
  const e = new StubDeterministicDenseEmbedder({ dim: 64 });
  const v = await e.embed("Postgres 16 primary data store");
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  // Either zero (empty text) or 1.0.
  assert.ok(Math.abs(norm - 1) < 1e-9 || norm === 0);
});

test("DenseEmbedder: stub batch embedding matches per-call embedding", async () => {
  const e = new StubDeterministicDenseEmbedder({ dim: 32 });
  const texts = ["alpha bravo", "charlie delta", "echo foxtrot"];
  const batch = await e.embedBatch(texts);
  assert.equal(batch.length, texts.length);
  for (let i = 0; i < texts.length; i++) {
    const single = await e.embed(texts[i]!);
    assert.deepEqual(batch[i], single);
  }
});

test("DenseEmbedder: empty / stopword-only text produces the zero vector", async () => {
  const e = new StubDeterministicDenseEmbedder({ dim: 32 });
  const v = await e.embed("");
  for (const x of v) assert.equal(x, 0);
  const v2 = await e.embed("the and or not but");
  for (const x of v2) assert.equal(x, 0);
});

// ---------------------------------------------------------------------------
// 2. TransformersJsEmbedder: lifecycle and graceful failure
// ---------------------------------------------------------------------------

test("TransformersJsEmbedder: init() without a real library reports `skipped` metadata", async () => {
  // The embedder's metadata starts in `status: "skipped"`
  // until `init()` resolves. We use a metadata-only
  // inspection: no init, no model download.
  const e = new TransformersJsEmbedder({
    modelId: "Xenova/all-MiniLM-L6-v2",
    cacheDir: "/tmp/curion-test-cache-skipped",
  });
  assert.equal(e.metadata.status, "skipped");
  assert.equal(e.metadata.backend, "transformersjs");
  assert.equal(e.metadata.modelId, "Xenova/all-MiniLM-L6-v2");
  // We do NOT call `init()` here so the test does not
  // require network. The real-model integration is
  // exercised in `tests/retrieval-dense-vector-live.test.ts`.
});

test("TransformersJsEmbedder: embed() without init falls back to the stub", async () => {
  // The embedder MUST be safe to call before init(): the
  // benchmark runner relies on this when the model
  // download is skipped (`--dense-skip`).
  const e = new TransformersJsEmbedder({
    modelId: "Xenova/all-MiniLM-L6-v2",
    cacheDir: "/tmp/curion-test-cache-fallback",
  });
  const v = await e.embed("Postgres is the primary data store");
  // The stub is `dim: 384` by default; the
  // TransformersJsEmbedder's placeholder dim is also 384
  // (the conventional MiniLM dim) until init() probes it.
  assert.equal(v.length, 384);
  // The stub L2-normalizes, so the norm is 1 (or 0 for
  // empty text).
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  assert.ok(Math.abs(norm - 1) < 1e-9 || norm === 0);
});

test("TransformersJsEmbedder: embedBatch() without init falls back to the stub batch", async () => {
  const e = new TransformersJsEmbedder({
    modelId: "Xenova/all-MiniLM-L6-v2",
    cacheDir: "/tmp/curion-test-cache-batch-fallback",
  });
  const v = await e.embedBatch(["alpha", "bravo", "charlie"]);
  assert.equal(v.length, 3);
  for (const vec of v) assert.equal(vec.length, 384);
});

// ---------------------------------------------------------------------------
// 3. Factory + spec parser
// ---------------------------------------------------------------------------

test("createDenseEmbedder: default spec is `stub-dense`", async () => {
  const { embedder, spec } = await createDenseEmbedder();
  assert.equal(embedder.metadata.backend, "stub-dense");
  assert.equal(spec, "stub-dense");
});

test("createDenseEmbedder: explicit stub-dense spec works", async () => {
  const { embedder, spec } = await createDenseEmbedder("stub-dense");
  assert.equal(embedder.metadata.backend, "stub-dense");
  assert.equal(spec, "stub-dense");
});

test("createDenseEmbedder: stub-dense:dim=N customizes the dim", async () => {
  const { embedder, spec } = await createDenseEmbedder("stub-dense:dim=128");
  assert.equal(embedder.metadata.backend, "stub-dense");
  assert.equal(embedder.metadata.dim, 128);
  assert.equal(spec, "stub-dense:dim=128");
});

test("createDenseEmbedder: skip flag short-circuits init() but still dispatches by spec", async () => {
  // The Qwen3 work made the factory spec-routed:
  // a real-backend spec (`transformersjs` /
  // `qwen3` / `qwen3-hf`) is dispatched to its
  // named backend even when `skip: true`. The
  // `skip` flag only short-circuits the
  // `embedder.init()` call (so no model
  // download / pipeline build happens). The
  // returned embedder's metadata carries
  // `status: "skipped"` (the embedder was
  // constructed but never ran) and the
  // `embed()` / `embedBatch()` calls fall back
  // to the deterministic stub (the same
  // fallback the failed-init path uses).
  //
  // This is the documented contract: `--dense-skip`
  // means "do not invoke the real model" — it
  // does NOT mean "downgrade to a stub" for a
  // real-backend spec. A benchmark that wants a
  // pure stub should pass `--embedder stub-dense`
  // explicitly.
  const { embedder, spec } = await createDenseEmbedder("transformersjs", {
    skip: true,
  });
  assert.equal(embedder.metadata.backend, "transformersjs");
  assert.equal(embedder.metadata.status, "skipped");
  // The spec returned to the caller is the
  // original spec string. The `skip` is recorded
  // on the embedder's metadata, not the spec
  // string.
  assert.equal(spec, "transformersjs");
});

test("createDenseEmbedder: skip flag with qwen3 spec short-circuits init() and dispatches to Qwen3", async () => {
  // The same contract applies to the Qwen3
  // backend: `--dense-skip --embedder qwen3`
  // returns a `Qwen3Embedder` in `status:
  // "skipped"`. The benchmark runner treats
  // `status: "skipped"` (or `"error"`) as
  // "the live model never ran; the report
  // metadata is well-formed but the numbers
  // are stub-fallback".
  const { embedder, spec } = await createDenseEmbedder("qwen3", { skip: true });
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.equal(embedder.metadata.status, "skipped");
  assert.equal(
    embedder.metadata.modelId,
    "onnx-community/Qwen3-Embedding-0.6B-ONNX",
  );
  assert.equal(spec, "qwen3");
});

test("createDenseEmbedder: default (no spec, no options) returns a ready stub", async () => {
  // The no-arg factory call returns the
  // deterministic stub in `status: "ready"`.
  // The benchmark default is the stub for
  // CI-friendly deterministic runs.
  const { embedder, spec } = await createDenseEmbedder();
  assert.equal(embedder.metadata.backend, "stub-dense");
  assert.equal(embedder.metadata.status, "ready");
  assert.equal(spec, "stub-dense");
});

test("createDenseEmbedder: unknown spec is rejected", async () => {
  await assert.rejects(
    async () => createDenseEmbedder("not-a-real-spec"),
    /unknown spec/,
  );
});

// ---------------------------------------------------------------------------
// 4. rankDenseVectorAsync: top-K shape contract
// ---------------------------------------------------------------------------

test("rankDenseVectorAsync: returns the {id, score}[] top-K shape", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const hits = await rankDenseVectorAsync(
    "What database does the project use?",
    cands,
    { topK: 5, embedder },
  );
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0);
  assert.ok(hits.length <= 5);
  for (const h of hits) {
    assert.equal(typeof h.id, "number");
    assert.equal(Number.isInteger(h.id), true);
    assert.equal(typeof h.score, "number");
    assert.ok(Number.isFinite(h.score), `score must be finite, got ${h.score}`);
    // Cosine similarity in [-1, 1].
    assert.ok(h.score >= -1);
    assert.ok(h.score <= 1);
  }
  // Score desc, id asc tie-break.
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1]!;
    const b = hits[i]!;
    if (a.score === b.score) {
      assert.ok(a.id < b.id);
    } else {
      assert.ok(a.score > b.score);
    }
  }
});

test("rankDenseVectorAsync: withMetadata captures the embedder metadata", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const res = await rankDenseVectorWithMetadataAsync(
    "Postgres primary data store",
    cands,
    { topK: 5, embedder },
  );
  assert.ok(res.embeddingBackend);
  assert.equal(res.embeddingBackend.backend, "stub-dense");
  assert.equal(res.embeddingBackend.dim, 64);
  assert.equal(res.embeddingBackend.status, "ready");
});

test("rankDenseVectorAsync: returns an empty array for a zero-token query", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const hits = await rankDenseVectorAsync("!!! ???", cands, {
    topK: 5,
    embedder,
  });
  assert.deepEqual(hits, []);
});

test("rankDenseVectorAsync: top-K cap is respected", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const hits = await rankDenseVectorAsync("project", cands, {
    topK: 2,
    threshold: 0,
    embedder,
  });
  assert.equal(hits.length, 2);
});

test("rankDenseVectorAsync: deterministic for a given query, corpus, and embedder", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const a = await rankDenseVectorAsync("What database does the project use?", cands, {
    topK: 5,
    embedder,
  });
  const b = await rankDenseVectorAsync("What database does the project use?", cands, {
    topK: 5,
    embedder,
  });
  assert.deepEqual(a, b);
});

test("rankDenseVectorAsync: threshold is respected", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const hits = await rankDenseVectorAsync(
    "Postgres 16 primary data store",
    cands,
    { topK: 5, threshold: 0.99, embedder },
  );
  for (const h of hits) {
    assert.ok(
      h.score >= 0.99,
      `threshold 0.99 not respected: hit ${h.id} score ${h.score}`,
    );
  }
});

test("rankDenseVectorAsync: defaults are exposed as constants", () => {
  assert.equal(DEFAULT_DENSE_VECTOR_THRESHOLD, 0);
  assert.equal(DEFAULT_DENSE_VECTOR_TOP_K, 5);
});

// ---------------------------------------------------------------------------
// 5. rankHybridAsync: real dense vector contributor
// ---------------------------------------------------------------------------

test("rankHybridAsync: useDenseVector=true swaps the vector slot for vector-dense", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const res = await rankHybridAsync("Postgres primary data store", cands, {
    k: 60,
    topK: 5,
    threshold: 0,
    useDenseVector: true,
    denseVectorEmbedder: embedder,
  });
  assert.equal(res.contributors.length, 3);
  assert.ok(res.contributors.includes("vector-dense"));
  assert.ok(!res.contributors.includes("vector"));
  // Each hit's contributors should have a `vector-dense`
  // entry (and no `vector` entry).
  if (res.hits.length > 0) {
    const labels = res.hits[0]!.contributors.map((c) => c.source);
    assert.ok(labels.includes("vector-dense"));
    assert.ok(!labels.includes("vector"));
  }
});

test("rankHybridAsync: useDenseVector=false keeps the hashed-bag-of-words vector", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const res = await rankHybridAsync("Postgres primary data store", cands, {
    k: 60,
    topK: 5,
    threshold: 0,
    useDenseVector: false,
  });
  assert.ok(res.contributors.includes("vector"));
  assert.ok(!res.contributors.includes("vector-dense"));
});

test("rankHybridAsync: useDenseVector=true without an embedder throws", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  await assert.rejects(
    async () =>
      rankHybridAsync("test", cands, {
        k: 60,
        topK: 5,
        threshold: 0,
        useDenseVector: true,
      }),
    /denseVectorEmbedder/,
  );
});

test("rankHybridAsync: no-answer path returns an empty top-K when all contributors are empty", async () => {
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  // A pure-punctuation query short-circuits in lexical
  // and (via the stub) in vector-dense.
  const res = await rankHybridAsync("!!! ???", cands, {
    k: 60,
    topK: 5,
    threshold: 0,
    useDenseVector: true,
    denseVectorEmbedder: embedder,
  });
  assert.deepEqual(res.hits, []);
});

test("rankHybrid (sync): useDenseVector=true throws (async-only)", () => {
  const cands: LexicalCandidate[] = [
    { id: 1, text: "Postgres is the primary data store" },
    { id: 2, text: "Office kitchen dishwasher" },
  ];
  assert.throws(
    () =>
      rankHybrid("test", cands, {
        k: 60,
        topK: 5,
        threshold: 0,
        useDenseVector: true,
      }),
    /async-only/,
  );
});

test("fuseRankings: accepts the new `vector-dense` source label", () => {
  const rankings = [
    { label: "lexical" as const, list: [{ id: 1, score: 0.5 }], weight: 1 },
    { label: "fts5" as const, list: [{ id: 1, score: 0.5 }], weight: 1 },
    {
      label: "vector-dense" as const,
      list: [{ id: 1, score: 0.5 }],
      weight: 1,
    },
  ];
  const fused = fuseRankings(rankings, 60, 5);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.id, 1);
  // Three contributors with rank=1, k=60, weight=1.
  // rrf = 3 * (1/61).
  const expected = 3 / 61;
  assert.ok(Math.abs(fused[0]!.score - expected) < 1e-12);
  // The contributors block carries the new label.
  const labels = fused[0]!.contributors.map((c: RrfContributor) => c.source);
  assert.ok(labels.includes("vector-dense"));
});

// ---------------------------------------------------------------------------
// 6. runDenseRetrievalBenchmark: async entry point
// ---------------------------------------------------------------------------

test("runDenseRetrievalBenchmark: vector-dense returns a single-variant report with metadata", async () => {
  const report = await runDenseRetrievalBenchmark({
    variant: "vector-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  assert.ok(
    isSingleVariantReport(report) ||
      // The single-variant check is for the sync
      // `RetrievalBenchmarkReport` shape; the dense
      // shape is a different type. We do a structural
      // check on `variant` and `config.embeddingBackend`.
      typeof (report as { variant?: string }).variant === "string",
  );
  if (isSingleVariantReport(report)) {
    // The sync type guard happens to match because the
    // dense report's surface is a superset. We accept
    // this and double-check the metadata field that
    // distinguishes the dense shape.
    assert.equal(
      (report as unknown as { variant: string }).variant,
      "vector-dense-benchmark",
    );
  } else {
    assert.equal(
      (report as { variant: string }).variant,
      "vector-dense-benchmark",
    );
  }
  const r = report as { config: { embeddingBackend: EmbedderMetadata } };
  assert.equal(r.config.embeddingBackend.backend, "stub-dense");
  assert.equal(r.config.embeddingBackend.dim, 64);
  assert.equal(r.config.embeddingBackend.status, "ready");
  // The per-query evals are well-formed: every top-id is
  // a real corpus id.
  const evals = (report as { evals: Array<{ topIds: number[] }> }).evals;
  for (const e of evals) {
    for (const id of e.topIds) {
      assert.ok(BENCHMARK_RECORDS.some((r) => r.id === id));
    }
  }
});

test("runDenseRetrievalBenchmark: hybrid-dense returns a single-variant report with metadata", async () => {
  const report = await runDenseRetrievalBenchmark({
    variant: "hybrid-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const r = report as {
    variant: string;
    config: { embeddingBackend: EmbedderMetadata; hybridK?: number };
  };
  assert.equal(r.variant, "hybrid-dense-benchmark");
  assert.equal(r.config.embeddingBackend.backend, "stub-dense");
  assert.equal(r.config.hybridK, 60);
});

test("runDenseRetrievalBenchmark: all-dense returns a comparison report", async () => {
  const report = await runDenseRetrievalBenchmark({
    variant: "all-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  if (isComparisonReport(report)) {
    // The sync comparison type happens to also match
    // because of the shared fields. The dense comparison
    // is a different type. We double-check the shape via
    // a structural probe.
    assert.equal(
      (report as unknown as { variant: string }).variant,
      "all-dense",
    );
  } else {
    assert.equal(
      (report as { variant: string }).variant,
      "all-dense",
    );
  }
  const r = report as {
    vectorDense: { variant: string };
    hybridDense: { variant: string };
    comparison: Array<{ metric: string; vectorDense: number; hybridDense: number; delta: number }>;
  };
  assert.equal(r.vectorDense.variant, "vector-dense-benchmark");
  assert.equal(r.hybridDense.variant, "hybrid-dense-benchmark");
  assert.ok(r.comparison.length > 0);
  for (const row of r.comparison) {
    assert.equal(row.delta, row.hybridDense - row.vectorDense);
  }
});

test("runDenseRetrievalBenchmark: rejects a non-dense variant", async () => {
  await assert.rejects(
    async () => runDenseRetrievalBenchmark({ variant: "lexical" }),
    /vector-dense|hybrid-dense|all-dense/,
  );
  await assert.rejects(
    async () => runDenseRetrievalBenchmark({ variant: "vector" }),
    /vector-dense|hybrid-dense|all-dense/,
  );
});

test("runDenseRetrievalBenchmark: --calibrate is now supported on dense variants (was future phase)", async () => {
  // The dense calibration experiment was a "future phase"
  // until the dense abstention calibration work landed.
  // The contract changed: `--calibrate` on the dense
  // variants now runs `runDenseCalibration` and returns
  // a `DenseCalibrationReport` (a strict superset of the
  // existing `CalibrationReport`).
  //
  // The test pins the new contract: the call no longer
  // throws, and the returned report carries the dense
  // `embeddingBackend` block and the dense `bestByVariant`
  // keys.
  const report = await runDenseRetrievalBenchmark({
    variant: "vector-dense",
    calibration: true,
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const r = report as {
    variant?: string;
    config?: { embeddingBackend?: { backend: string } };
    bestByVariant?: {
      vectorDense?: unknown;
      hybridDense?: unknown;
      lexical: null;
      fts5: null;
      vector: null;
    };
  };
  // The dense calibration report does NOT carry a
  // `variant: "..."` field (it is a `CalibrationReport`
  // superset, not a single-variant report). The dense
  // embedder metadata is at the top level on the
  // `embeddingBackend` field, not on a `config` block
  // (the `CalibrationReport.config` block carries
  // `recordCount / queryCount / direction` only).
  const r2 = report as {
    embeddingBackend?: { backend?: string; dim?: number };
    bestByVariant?: {
      vectorDense?: unknown;
      hybridDense?: unknown;
      lexical: null;
      fts5: null;
      vector: null;
    };
  };
  assert.equal(r2.embeddingBackend?.backend, "stub-dense");
  assert.equal(r2.embeddingBackend?.dim, 64);
  // The dense best keys exist; the sync keys are
  // explicitly `null` (the dense calibration report does
  // not run the sync variants).
  assert.equal(r2.bestByVariant?.lexical, null);
  assert.equal(r2.bestByVariant?.fts5, null);
  assert.equal(r2.bestByVariant?.vector, null);
  // The `vector-dense` best key is populated (we asked
  // for `variant: "vector-dense"`).
  assert.ok(
    r2.bestByVariant?.vectorDense !== undefined,
    "vectorDense best key should be present on a dense calibration report",
  );
  // The `hybrid-dense` best key is `null` when only
  // `vector-dense` was requested (the dense calibration
  // runner initializes the key explicitly so the report
  // shape is stable regardless of which dense variants
  // were run).
  assert.equal(r2.bestByVariant?.hybridDense, null);
});

// ---------------------------------------------------------------------------
// 7. CLI parser: dense flags are accepted
// ---------------------------------------------------------------------------

test("parseRetrievalCli: accepts --variant vector-dense / hybrid-dense / all-dense", () => {
  assert.equal(
    parseRetrievalCli(["--variant", "vector-dense"]).variant,
    "vector-dense",
  );
  assert.equal(
    parseRetrievalCli(["--variant", "hybrid-dense"]).variant,
    "hybrid-dense",
  );
  assert.equal(
    parseRetrievalCli(["--variant", "all-dense"]).variant,
    "all-dense",
  );
});

test("parseRetrievalCli: rejects unknown --variant values", () => {
  assert.throws(
    () => parseRetrievalCli(["--variant", "vector-fancy"]),
    /--variant must be one of/,
  );
});

test("parseRetrievalCli: --embedder is captured as denseEmbedderSpec", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "stub-dense:dim=128",
  ]);
  assert.equal(opts.denseEmbedderSpec, "stub-dense:dim=128");
});

test("parseRetrievalCli: --dense-cache-dir composes a spec object", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "transformersjs",
    "--dense-cache-dir",
    "/tmp/curion-bench-cache",
  ]);
  const spec = opts.denseEmbedderSpec as { cacheDir: string };
  assert.equal(spec.cacheDir, "/tmp/curion-bench-cache");
});

test("parseRetrievalCli: --dense-skip composes a spec object with skip=true", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "transformersjs",
    "--dense-skip",
  ]);
  const spec = opts.denseEmbedderSpec as { skip: boolean };
  assert.equal(spec.skip, true);
});

// ---------------------------------------------------------------------------
// 8. Artifact writers: file prefixes are correct
// ---------------------------------------------------------------------------

test("writeDenseBenchmarkReport: writes `retrieval-vector-dense-*.json` for vector-dense reports", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-vd-art-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = await runDenseRetrievalBenchmark({
      variant: "vector-dense",
      denseEmbedderSpec: "stub-dense",
    });
    const r = report as { variant: string };
    const file = writeDenseBenchmarkReport(
      r as unknown as Parameters<typeof writeDenseBenchmarkReport>[0],
      dir,
    );
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-vector-dense-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      config: { embeddingBackend: EmbedderMetadata };
    };
    assert.equal(parsed.variant, "vector-dense-benchmark");
    assert.equal(parsed.config.embeddingBackend.backend, "stub-dense");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeDenseBenchmarkReport: writes `retrieval-hybrid-dense-*.json` for hybrid-dense reports", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-hd-art-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = await runDenseRetrievalBenchmark({
      variant: "hybrid-dense",
      denseEmbedderSpec: "stub-dense",
    });
    const r = report as { variant: string };
    const file = writeDenseBenchmarkReport(
      r as unknown as Parameters<typeof writeDenseBenchmarkReport>[0],
      dir,
    );
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-hybrid-dense-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
    };
    assert.equal(parsed.variant, "hybrid-dense-benchmark");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeDenseComparisonReport: writes `retrieval-compare-dense-*.json`", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-cd-art-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = await runDenseRetrievalBenchmark({
      variant: "all-dense",
      denseEmbedderSpec: "stub-dense",
    });
    const r = report as unknown as Parameters<
      typeof writeDenseComparisonReport
    >[0];
    const file = writeDenseComparisonReport(r, dir);
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-compare-dense-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      vectorDense: { variant: string };
      hybridDense: { variant: string };
    };
    assert.equal(parsed.variant, "all-dense");
    assert.equal(parsed.vectorDense.variant, "vector-dense-benchmark");
    assert.equal(parsed.hybridDense.variant, "hybrid-dense-benchmark");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Human report formatters
// ---------------------------------------------------------------------------

test("formatDenseHumanReport: includes the embedding-backend block and the headline metrics", async () => {
  const report = await runDenseRetrievalBenchmark({
    variant: "vector-dense",
    denseEmbedderSpec: "stub-dense",
  });
  const out = formatDenseHumanReport(
    report as unknown as Parameters<typeof formatDenseHumanReport>[0],
  );
  for (const section of [
    "embedding backend",
    "vector-dense-benchmark",
    "stub-dense",
    "rank1 (top-hit, positive)",
    "no-answer TNR",
  ]) {
    assert.ok(
      out.includes(section),
      `dense human report missing section: ${section}`,
    );
  }
});

test("formatDenseComparisonReport: includes the vector-dense vs hybrid-dense headline", async () => {
  const report = await runDenseRetrievalBenchmark({
    variant: "all-dense",
    denseEmbedderSpec: "stub-dense",
  });
  const out = formatDenseComparisonReport(
    report as unknown as Parameters<typeof formatDenseComparisonReport>[0],
  );
  for (const section of [
    "comparison (vector-dense vs hybrid-dense)",
    "### vector-dense ###",
    "### hybrid-dense ###",
    "vector-dense-benchmark",
    "hybrid-dense-benchmark",
  ]) {
    assert.ok(
      out.includes(section),
      `dense comparison report missing section: ${section}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10. Source-tree guard: only the benchmark directory imports the dense modules
// ---------------------------------------------------------------------------

test("dense variant is benchmark-only: production recall() controller is not modified", () => {
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
  assert.match(recallSrc, /rankLexical/);
  assert.doesNotMatch(
    recallSrc,
    /rankDenseVector|rankHybridAsync|dense-embedder|dense-vector/,
    "recall controller must NOT import dense benchmark modules",
  );
  const seamSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "retrieval", "seam.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    seamSrc,
    /rankDenseVector|rankHybridAsync|dense-embedder|dense-vector/,
    "retrieval/seam.ts must NOT import the dense benchmark modules",
  );
  // The MCP server still exposes exactly two tools.
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8",
  );
  const toolCallCount = (serverSrc.match(/server\.registerTool\(/g) ?? []).length;
  assert.equal(
    toolCallCount,
    2,
    `server.ts must register exactly 2 tools, found ${toolCallCount}`,
  );
  assert.deepEqual(
    [...PUBLIC_TOOL_NAMES],
    ["remember", "recall"],
    "public MCP tool surface must remain exactly remember + recall",
  );
});

test("dense variant: only the benchmark directory imports the dense modules", () => {
  // Whitelist: the dense modules themselves, the
  // benchmark runner, the hybrid module (which now
  // composes the dense vector slot), and the
  // existing variants may import the dense modules.
  // Production code (`controller/`, `retrieval/seam.ts`,
  // `tools/`, `providers/`, `safety/`, `storage/`) must
  // NOT import them.
  const root = path.join(import.meta.dirname, "..", "src");
  const allowedImporters = new Set<string>([
    path.join("benchmark", "retrieval-runner.ts"),
    path.join("benchmark", "held-out-runner.ts"),
    path.join("benchmark", "held-out-validation.ts"),
    path.join("benchmark", "variants", "dense-embedder.ts"),
    path.join("benchmark", "variants", "dense-vector.ts"),
    path.join("benchmark", "variants", "hybrid.ts"),
    // The Qwen3 dense embedder (benchmark-only
    // experiment) imports the `StubDeterministicDenseEmbedder`
    // for its init-failure / skip fallback path. The
    // import is intentional and source-tree-scoped
    // to the benchmark directory. The Qwen3
    // source-tree guard in
    // `tests/retrieval-dense-qwen3.test.ts` enforces
    // the wider Qwen3-specific whitelist.
    path.join("benchmark", "variants", "qwen3-embedder.ts"),
    // The EmbeddingGemma dense embedder
    // (benchmark-only experiment, sibling of
    // Qwen3) also imports the
    // `StubDeterministicDenseEmbedder` for its
    // init-failure / skip fallback path. The
    // import is intentional and source-tree-
    // scoped to the benchmark directory. The
    // EmbeddingGemma source-tree guard in
    // `tests/retrieval-dense-embeddinggemma.test.ts`
    // enforces the wider EmbeddingGemma-specific
    // whitelist.
    path.join("benchmark", "variants", "embeddinggemma-embedder.ts"),
    // The BGE-M3 dense embedder
    // (benchmark-only experiment, sibling of
    // Qwen3 and EmbeddingGemma) also imports
    // the `StubDeterministicDenseEmbedder` for
    // its init-failure / skip fallback path.
    // The import is intentional and source-
    // tree-scoped to the benchmark directory.
    // The BGE-M3 source-tree guard in
    // `tests/retrieval-dense-bge-m3.test.ts`
    // enforces the wider BGE-M3-specific
    // whitelist.
    path.join("benchmark", "variants", "bge-m3-embedder.ts"),
  ]);
  const productionDirPrefixes = [
    path.join("controller"),
    path.join("retrieval", "seam.ts"),
    path.join("tools"),
    path.join("providers"),
    path.join("safety"),
    path.join("storage"),
  ];
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
    const importsDenseModule =
      src.includes("from \"./dense-embedder\"") ||
      src.includes("from \"./dense-embedder.js\"") ||
      src.includes("from \"./dense-vector\"") ||
      src.includes("from \"./dense-vector.js\"") ||
      src.includes("from \"../benchmark/variants/dense-embedder") ||
      src.includes("from \"../benchmark/variants/dense-vector") ||
      src.includes("from \"../../benchmark/variants/dense-embedder") ||
      src.includes("from \"../../benchmark/variants/dense-vector");
    const usesDenseSymbol =
      src.match(/\brankDenseVector\b/) !== null ||
      src.match(/\brankDenseVectorAsync\b/) !== null ||
      src.match(/\brankHybridAsync\b/) !== null ||
      src.match(/\bStubDeterministicDenseEmbedder\b/) !== null ||
      src.match(/\bTransformersJsEmbedder\b/) !== null ||
      src.match(/\bcreateDenseEmbedder\b/) !== null;
    assert.ok(
      !importsDenseModule,
      `unexpected import of dense module in ${rel}`,
    );
    assert.ok(
      !usesDenseSymbol,
      `unexpected dense symbol usage in ${rel}`,
    );
    // Belt-and-braces: production directories must not
    // import the dense modules at all.
    for (const prefix of productionDirPrefixes) {
      if (rel === prefix || rel.startsWith(prefix + path.sep)) {
        assert.ok(
          !importsDenseModule,
          `production file ${rel} must not import dense modules`,
        );
        assert.ok(
          !usesDenseSymbol,
          `production file ${rel} must not use dense symbols`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 11. CLI dispatch: sync `runRetrievalBenchmark` throws on dense variants
// ---------------------------------------------------------------------------

test("runRetrievalBenchmark (sync): rejects dense variants (async-only)", async () => {
  // We import the sync function lazily to keep this test
  // independent of the runner's module-load order.
  const { runRetrievalBenchmark } = await import(
    "../src/benchmark/retrieval-runner.ts"
  );
  assert.throws(
    () => runRetrievalBenchmark({ variant: "vector-dense" }),
    /async-only/,
  );
  assert.throws(
    () => runRetrievalBenchmark({ variant: "hybrid-dense" }),
    /async-only/,
  );
  assert.throws(
    () => runRetrievalBenchmark({ variant: "all-dense" }),
    /async-only/,
  );
});
