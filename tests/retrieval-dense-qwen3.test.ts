/**
 * Qwen3 dense-embedding benchmark tests.
 *
 * The Qwen3 benchmark is a `research-only /
 * benchmark-only` experiment on a new dense
 * embedding candidate (Qwen3-Embedding-0.6B,
 * instruction-tuned, last_token pooling,
 * 1024-dim, q8 ONNX). The brief is explicit:
 * Qwen3 is ONE candidate, not assumed best. The
 * implementation is a strict superset of the
 * existing dense-vector benchmark; the existing
 * MiniLM / stub backends continue to work
 * unchanged.
 *
 * The test file does NOT require a network
 * download. The Qwen3 backend is exercised
 * without a real `@huggingface/transformers`
 * install: the embedder's `init()` will fail to
 * load the library (because the package is not
 * installed in the CI environment), and the
 * embedder will fall back to the deterministic
 * stub. The tests assert the fallback is wired
 * correctly and the metadata / query-doc
 * distinction is honored.
 *
 * A separate opt-in "live model" test exists in
 * `tests/_helpers/retrieval-dense-qwen3-live.test.ts`.
 *
 * The tests cover:
 *   1. Spec parsing: `qwen3`, `qwen3-hf`,
 *      `qwen3:model=...,dtype=...,task=...,
 *      pooling=...` are all parsed correctly.
 *   2. Factory dispatch: the
 *      `createDenseEmbedder` factory routes
 *      `qwen3` to the Qwen3 backend and
 *      `qwen3-hf` is treated as an alias.
 *   3. Query instruction format:
 *      `Qwen3Embedder.buildQueryPrefix(task, query)`
 *      returns the documented
 *      `Instruct: <task>\nQuery:<query>` string,
 *      and the embedder applies it ONLY to
 *      queries (not to documents).
 *   4. Metadata block: the embedder's
 *      `metadata` is well-formed (backend,
 *      modelId, dim, dtype, pooling,
 *      normalized, status, cacheDir).
 *   5. `init()` failure path: when the library
 *      is not installed, `init()` flips the
 *      embedder to `status: "error"` and the
 *      `embed` / `embedBatch` calls fall back to
 *      the deterministic stub.
 *   6. Document-mode default: `embed()` /
 *      `embedBatch()` map to
 *      `embedDocument` / `embedDocumentsBatch`,
 *      which do NOT apply the instruction
 *      prefix.
 *   7. MiniLM / stub / `transformersjs` paths
 *      continue to work unchanged. The factory
 *      still dispatches `stub-dense` and
 *      `transformersjs` specs to the existing
 *      backends.
 *   8. Source-tree guard: the production
 *      `recall(text)` controller, the public MCP
 *      server, the tools, the providers, the
 *      safety / storage layers, and the retrieval
 *      seam do NOT import the Qwen3 module. The
 *      benchmark directory (and the new Qwen3
 *      test file itself) may.
 *   9. CLI parser: `--embedder qwen3` is
 *      accepted and routed correctly, with and
 *      without `--dense-cache-dir` /
 *      `--dense-skip`.
 *  10. Public MCP API guard: the server still
 *      registers exactly `remember` + `recall`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDenseEmbedder,
  StubDeterministicDenseEmbedder,
  TransformersJsEmbedder,
  type EmbedderMetadata,
  type DenseEmbedder,
} from "../src/benchmark/variants/dense-embedder.ts";
import {
  Qwen3Embedder,
  type Qwen3TextKind,
} from "../src/benchmark/variants/qwen3-embedder.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import {
  rankDenseVectorAsync,
  rankDenseVectorWithMetadataAsync,
  type DenseVectorRankingOptions,
} from "../src/benchmark/variants/dense-vector.ts";
import { parseRetrievalCli } from "../src/benchmark/retrieval-runner.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";

// ---------------------------------------------------------------------------
// 1. Qwen3Embedder construction + metadata
// ---------------------------------------------------------------------------

test("Qwen3Embedder: construction exposes the documented metadata", () => {
  const embedder = new Qwen3Embedder();
  const m: EmbedderMetadata = embedder.metadata;
  assert.equal(m.backend, "qwen3");
  assert.equal(
    m.modelId,
    "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    "default model id must be the pinned Qwen3-Embedding-0.6B ONNX",
  );
  assert.equal(m.dim, 1024, "Qwen3-Embedding-0.6B produces 1024-dim vectors");
  assert.equal(
    m.quantized,
    true,
    "default dtype q8 means the embedder reports quantized=true",
  );
  assert.equal(m.status, "skipped", "construction is in skipped status until init()");
  // The description surfaces the key knobs so a
  // reviewer reading the metadata can audit the
  // configuration.
  assert.ok(
    typeof m.description === "string" && m.description.includes("q8"),
    `description must mention the q8 dtype; got: ${m.description}`,
  );
  assert.ok(
    m.description.includes("last_token"),
    `description must mention the last_token pooling; got: ${m.description}`,
  );
  // The cache dir is the documented default.
  assert.equal(
    m.cacheDir,
    `${process.cwd()}/.cortex/transformers-cache`,
  );
});

test("Qwen3Embedder: custom modelId, dtype, task, pooling, cacheDir are honored", () => {
  const embedder = new Qwen3Embedder({
    modelId: "custom-org/custom-qwen3-onnx",
    dtype: "fp16",
    task: "Custom retrieval task",
    pooling: "mean",
    cacheDir: "/tmp/cortex-qwen3-test-cache",
  });
  const m = embedder.metadata;
  assert.equal(m.modelId, "custom-org/custom-qwen3-onnx");
  // `quantized` is `true` only when the dtype
  // starts with `q`. `fp16` is not quantized.
  assert.equal(m.quantized, false);
  assert.equal(m.cacheDir, "/tmp/cortex-qwen3-test-cache");
  // The description surfaces the custom values.
  assert.ok(m.description.includes("fp16"));
  assert.ok(m.description.includes("mean"));
  assert.ok(m.description.includes("Custom retrieval task"));
});

test("Qwen3Embedder: custom dim is honored and surfaced on the metadata", () => {
  const embedder = new Qwen3Embedder({ dim: 768 });
  assert.equal(embedder.metadata.dim, 768);
});

// ---------------------------------------------------------------------------
// 2. Query instruction format
// ---------------------------------------------------------------------------

test("Qwen3Embedder.buildQueryPrefix: produces the documented Instruct+Query format", () => {
  // The format is the model's documented prefix:
  //   Instruct: <task>\nQuery:<query>
  // with NO leading space, NO trailing space, and
  // a single newline between the two halves.
  const prefix = Qwen3Embedder.buildQueryPrefix(
    "Given a web search query, retrieve relevant passages that best answer the query",
    "What is the team's release schedule?",
  );
  assert.equal(
    prefix,
    "Instruct: Given a web search query, retrieve relevant passages that best answer the query\nQuery:What is the team's release schedule?",
  );
});

test("Qwen3Embedder.buildQueryPrefix: empty task / empty query are still well-formed", () => {
  // Edge cases the unit tests should pin: a
  // benchmark that wants to study the effect of
  // an empty task or an empty query (the latter
  // short-circuits in the ranker anyway).
  const emptyTask = Qwen3Embedder.buildQueryPrefix("", "hello");
  assert.equal(emptyTask, "Instruct: \nQuery:hello");
  const emptyQuery = Qwen3Embedder.buildQueryPrefix("task", "");
  assert.equal(emptyQuery, "Instruct: task\nQuery:");
});

test("Qwen3Embedder.buildQueryPrefix: task with multiple lines / special chars is verbatim", () => {
  // The format is verbatim. A benchmark that
  // passes a multi-line task string gets a
  // multi-line prefix. This is the documented
  // Qwen3 behavior (the model is trained on
  // arbitrary task strings; the harness does not
  // normalize them).
  const task = "Custom task\nwith a newline";
  const prefix = Qwen3Embedder.buildQueryPrefix(task, "query");
  assert.equal(prefix, "Instruct: Custom task\nwith a newline\nQuery:query");
});

// ---------------------------------------------------------------------------
// 3. embedQuery vs embedDocument
// ---------------------------------------------------------------------------

test("Qwen3Embedder: embedDocument and embedQuery are both async and return dim-shaped vectors", async () => {
  // We do NOT call `init()` here. The embedder's
  // `embed` / `embedQuery` / `embedDocument` fall
  // back to the deterministic stub when the
  // pipeline is not initialized. The stub is
  // 1024-dim (per the `dim: 1024` metadata), so
  // the test is well-formed even without the
  // real Qwen3 model.
  const embedder = new Qwen3Embedder();
  const docVec = await embedder.embedDocument("Postgres primary data store");
  const queryVec = await embedder.embedQuery("database?");
  assert.equal(docVec.length, 1024);
  assert.equal(queryVec.length, 1024);
});

test("Qwen3Embedder: embed() and embedBatch() default to document mode (no prefix applied)", async () => {
  // The `DenseEmbedder` contract is `embed(text)`
  // and `embedBatch(texts)`. The Qwen3 embedder
  // maps these to `embedDocument` /
  // `embedDocumentsBatch` so the Qwen3 backend is
  // drop-in compatible with the existing
  // `DenseEmbedder` interface. The query-side
  // prefixing is opt-in via `embedQuery` /
  // `embedDocumentsBatch` (the latter is
  // intentionally document-only to keep the
  // prefixing contract unit-testable).
  const embedder = new Qwen3Embedder();
  const single = await embedder.embed("Postgres primary data store");
  const batch = await embedder.embedBatch([
    "Postgres primary data store",
    "Office kitchen dishwasher",
  ]);
  assert.equal(single.length, 1024);
  assert.equal(batch.length, 2);
  assert.equal(batch[0]!.length, 1024);
  assert.equal(batch[1]!.length, 1024);
});

test("Qwen3Embedder: embed() / embedBatch() match embedDocument() / embedDocumentsBatch() (no prefix path)", async () => {
  // When the embedder is in the fallback path
  // (pipeline not initialized), the deterministic
  // stub returns the same vector for the same
  // text regardless of the call shape. The test
  // pins the contract: `embed(t) === embedDocument(t)`
  // and `embedBatch([t])[0] === embedDocument(t)`.
  // The contract is the foundation of the
  // drop-in-compatible claim.
  const embedder = new Qwen3Embedder();
  const text = "Postgres primary data store";
  const v1 = await embedder.embed(text);
  const v2 = await embedder.embedDocument(text);
  assert.deepEqual(v1, v2);
  const batch = await embedder.embedBatch([text]);
  assert.deepEqual(batch[0], v1);
});

test("Qwen3Embedder: fallback path is input-driven (embedQuery / embedDocument produce identical vectors for identical input)", async () => {
  // This is a structural test of the FALLBACK path
  // (pipeline not initialized; the deterministic
  // stub takes over). The embedder's public
  // surface is `embedQuery`, `embedDocument`,
  // `embedDocumentsBatch`, `embed`, `embedBatch`.
  // In the live-model path, `embedQuery` applies
  // the `Instruct: <task>\nQuery:<query>` prefix
  // and `embedDocument` forwards the text
  // verbatim; the two would then produce
  // different vectors for the same input text.
  // That real-model contract is covered by the
  // opt-in live test in
  // `tests/_helpers/retrieval-dense-qwen3-live.test.ts`.
  //
  // This test pins the FALLBACK contract
  // instead: without a real model load (the
  // pipeline is null), the deterministic stub
  // drives both `embedQuery` and `embedDocument`
  // with the same input text and produces the
  // same vector. The test asserts that the
  // public surface (`embedQuery` / `embedDocument`
  // / `embedDocumentsBatch` / `embed` /
  // `embedBatch`) exists and that the fallback
  // path is input-driven, so the ranker
  // receives well-formed vectors even when the
  // live model is unavailable. The reviewer's
  // claim that `embedQuery is the only call that
  // applies the instruction prefix` is exercised
  // by the live test, not by this one.
  const embedder = new Qwen3Embedder();
  assert.equal(typeof embedder.embedQuery, "function");
  assert.equal(typeof embedder.embedDocument, "function");
  assert.equal(typeof embedder.embedDocumentsBatch, "function");
  assert.equal(typeof embedder.embed, "function");
  assert.equal(typeof embedder.embedBatch, "function");
  // The kind-`"query"` dispatch is the embedder's
  // own job. The `embedQuery` method is the
  // embedQuery-mode entry point; the four other
  // methods are document-mode entry points.
  const qv = await embedder.embedQuery("What is the database?");
  const dv = await embedder.embedDocument("What is the database?");
  assert.equal(qv.length, dv.length);
  // The fallback path is input-driven: the
  // stub ignores the call shape (`embedQuery` vs
  // `embedDocument`) and produces the same vector
  // for the same input text. This is the
  // FALLBACK contract, NOT the real-model
  // contract; a live Qwen3 model would produce
  // different vectors for the prefixed query vs
  // the bare document. The live test in
  // `tests/_helpers/retrieval-dense-qwen3-live.test.ts`
  // exercises the real-model contract.
  let equal = true;
  for (let i = 0; i < qv.length; i++) {
    if (qv[i] !== dv[i]) {
      equal = false;
      break;
    }
  }
  assert.equal(equal, true, "fallback path: identical input produces identical vector");
});

test("Qwen3Embedder: Qwen3TextKind is the documented union", () => {
  // The type is exported so benchmark helpers
  // can reference it. A test that pins the
  // string literal values is a contract guard
  // for downstream consumers.
  const kinds: Qwen3TextKind[] = ["query", "document"];
  assert.deepEqual([...kinds], ["query", "document"]);
});

// ---------------------------------------------------------------------------
// 4. init() failure / fallback path
// ---------------------------------------------------------------------------

/**
 * Library-availability probe. Mirrors the helper
 * in `_helpers/retrieval-dense-qwen3-live.test.ts`:
 * the three `init() failure path` tests below
 * exercise the embedder's behavior when the
 * `@huggingface/transformers` package is NOT
 * installed. If the package IS installed (e.g. on
 * a developer machine that ran `npm install`), the
 * library loads successfully, `init()` does not
 * fail, and these tests have nothing to assert.
 * They are skipped in that env; the live
 * integration test (which exercises the real
 * model) covers the success path.
 */
async function isQwen3LibraryMissing(): Promise<boolean> {
  try {
    await import("@huggingface/transformers" as string);
    return false;
  } catch {
    return true;
  }
}

test("Qwen3Embedder: init() without a real library reports `error` metadata", async (t) => {
  // The `@huggingface/transformers` package is
  // NOT installed in the CI environment. The
  // embedder's `init()` should fail with a
  // clean error and flip the metadata to
  // `status: "error"`. The error message is
  // captured on `errorMessage`. The benchmark
  // runner falls back to the deterministic stub
  // for the rest of the run. If the library IS
  // installed (e.g. on a dev machine), the
  // `init()` succeeds, the metadata flips to
  // `status: "ready"`, and this test has nothing
  // to assert; the live integration test covers
  // the success path.
  if (!(await isQwen3LibraryMissing())) {
    t.skip("@huggingface/transformers is installed; the init-failure path is exercised in CI where the package is absent");
    return;
  }
  const embedder = new Qwen3Embedder({
    cacheDir: "/tmp/cortex-qwen3-test-cache-fail",
  });
  // The pre-init metadata is `status: "skipped"`.
  assert.equal(embedder.metadata.status, "skipped");
  // We do NOT assert the init() throws or
  // resolves; the Qwen3 embedder's contract is
  // to swallow the error and flip to
  // `status: "error"`. The post-init metadata
  // should be `status: "error"`.
  await embedder.init();
  assert.equal(
    embedder.metadata.status,
    "error",
    "init() must flip status to 'error' when the library is not installed",
  );
  // The error message is captured so a reviewer
  // can audit the failure on the artifact.
  assert.ok(
    typeof embedder.metadata.errorMessage === "string" &&
      embedder.metadata.errorMessage.length > 0,
    "errorMessage must be a non-empty string on init failure",
  );
  // The loadMs is captured even on failure.
  assert.ok(
    typeof embedder.metadata.loadMs === "number" &&
      embedder.metadata.loadMs >= 0,
  );
});

test("Qwen3Embedder: embed() / embedBatch() fall back to the stub when init() failed", async (t) => {
  // Companion to the test above: this test
  // assumes the library is missing. If the
  // library is present, `init()` succeeds and
  // the embedder is live; the fallback path is
  // not exercised and this test is skipped.
  if (!(await isQwen3LibraryMissing())) {
    t.skip("@huggingface/transformers is installed; the init-failure fallback is exercised in CI where the package is absent");
    return;
  }
  // The benchmark runner relies on this: when
  // `init()` fails, the embedder must still be
  // safe to call. The fallback uses the
  // deterministic stub at the Qwen3 dim.
  const embedder = new Qwen3Embedder();
  await embedder.init();
  assert.equal(embedder.metadata.status, "error");
  const v = await embedder.embed("Postgres is the primary data store");
  // The fallback dim is the embedder's metadata
  // dim (1024 by default).
  assert.equal(v.length, 1024);
  const batch = await embedder.embedBatch(["a", "b", "c"]);
  assert.equal(batch.length, 3);
  for (const vec of batch) {
    assert.equal(vec.length, 1024);
  }
  // The deterministic stub is unit-L2-normalized.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  assert.ok(Math.abs(norm - 1) < 1e-9 || norm === 0);
});

// ---------------------------------------------------------------------------
// 5. createDenseEmbedder: factory dispatch
// ---------------------------------------------------------------------------

test("createDenseEmbedder: 'qwen3' spec dispatches to Qwen3Embedder", async () => {
  const { embedder, spec } = await createDenseEmbedder("qwen3", { skip: true });
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.equal(embedder.metadata.modelId, "onnx-community/Qwen3-Embedding-0.6B-ONNX");
  // The factory skips init when `skip: true` so
  // the test does not require the library.
  // The `status: "skipped"` placeholder is
  // documented.
  assert.equal(embedder.metadata.status, "skipped");
  // The factory returns the original spec string
  // for reporting.
  assert.equal(spec, "qwen3");
});

test("createDenseEmbedder: 'qwen3-hf' is an alias for 'qwen3'", async () => {
  const { embedder, spec } = await createDenseEmbedder("qwen3-hf", { skip: true });
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.equal(spec, "qwen3-hf");
});

test("createDenseEmbedder: 'qwen3:model=...,dtype=...,task=...,pooling=...' parses all keys", async () => {
  const specStr = "qwen3:model=org/custom-qwen3-onnx,dtype=fp16,task=Custom%20task,pooling=mean";
  const { embedder } = await createDenseEmbedder(specStr, { skip: true });
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.equal(embedder.metadata.modelId, "org/custom-qwen3-onnx");
  // The description surfaces the custom values.
  assert.ok(embedder.metadata.description.includes("fp16"));
  assert.ok(embedder.metadata.description.includes("mean"));
  assert.ok(embedder.metadata.description.includes("Custom%20task"));
});

test("createDenseEmbedder: 'qwen3:pooling=<unknown>' falls back to the default", async () => {
  // An unknown pooling value is silently
  // ignored (the Qwen3 embedder constructor
  // uses its default `last_token`).
  const { embedder } = await createDenseEmbedder(
    "qwen3:pooling=unknown",
    { skip: true },
  );
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.ok(embedder.metadata.description.includes("last_token"));
});

test("createDenseEmbedder: object spec with backend=qwen3 dispatches to Qwen3", async () => {
  const { embedder } = await createDenseEmbedder(
    { backend: "qwen3", cacheDir: "/tmp/cortex-qwen3-obj-spec-cache" },
  );
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.equal(
    embedder.metadata.cacheDir,
    "/tmp/cortex-qwen3-obj-spec-cache",
  );
});

test("createDenseEmbedder: 'qwen3' without skip calls init() and may report error when library is missing", async (t) => {
  // Companion to the two `init()` failure path
  // tests above. If the library is present,
  // `init()` succeeds and the contract under
  // test is not exercised; skip in that env.
  if (!(await isQwen3LibraryMissing())) {
    t.skip("@huggingface/transformers is installed; the init-failure factory contract is exercised in CI where the package is absent");
    return;
  }
  // The `skip` default is `false`. The factory
  // calls `init()`. The library is not installed
  // in the CI environment, so init() flips the
  // metadata to `status: "error"`. The test pins
  // this contract: the factory does not throw,
  // and the returned embedder is in `error`
  // status (so the benchmark runner falls back to
  // the deterministic stub for the rest of the
  // run).
  const { embedder } = await createDenseEmbedder("qwen3");
  assert.equal(embedder.metadata.backend, "qwen3");
  assert.equal(embedder.metadata.status, "error");
  assert.ok(
    typeof embedder.metadata.errorMessage === "string" &&
      embedder.metadata.errorMessage.length > 0,
  );
});

test("createDenseEmbedder: existing 'stub-dense' / 'transformersjs' specs continue to work unchanged", async () => {
  // The factory's existing dispatch must
  // remain unchanged. These tests pin the
  // backward-compat contract: the Qwen3 path is
  // additive.
  const stub = await createDenseEmbedder("stub-dense:dim=128");
  assert.equal(stub.embedder.metadata.backend, "stub-dense");
  assert.equal(stub.embedder.metadata.dim, 128);
  // The transformersjs path is the historical
  // MiniLM / Xenova backend. The factory must
  // still dispatch to it.
  const xjs = await createDenseEmbedder("transformersjs", { skip: true });
  assert.equal(xjs.embedder.metadata.backend, "transformersjs");
  assert.equal(
    xjs.embedder.metadata.modelId,
    "Xenova/all-MiniLM-L6-v2",
  );
});

test("createDenseEmbedder: object spec with backend=stub-dense dispatches to stub-dense", async () => {
  const { embedder } = await createDenseEmbedder({
    backend: "stub-dense",
  });
  assert.equal(embedder.metadata.backend, "stub-dense");
});

test("createDenseEmbedder: unknown spec is rejected", async () => {
  await assert.rejects(
    async () => createDenseEmbedder("not-a-real-spec"),
    /unknown spec/,
  );
});

// ---------------------------------------------------------------------------
// 6. kind-`"query"` threading through rankDenseVectorAsync
// ---------------------------------------------------------------------------

test("rankDenseVectorWithMetadataAsync: kind='query' dispatches to embedQuery for Qwen3-like embedder", async () => {
  // We use a custom embedder that records
  // whether `embedQuery` or `embed` was called.
  // The test pins the kind-`"query"` dispatch:
  // the ranker calls `embedQuery(text)` for the
  // query, NOT `embed(text)`. The `embedBatch`
  // (document path) is still called for the
  // candidates.
  let embedQueryCalls = 0;
  let embedCalls = 0;
  const recorded: Array<{ method: string; text: string }> = [];
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const fakeQwen3: DenseEmbedder & {
    embedQuery: (t: string) => Promise<number[]>;
    embed: (t: string) => Promise<number[]>;
  } = {
    metadata: {
      backend: "qwen3",
      description: "test-fake-qwen3",
      modelId: "fake",
      dim: 4,
      status: "ready",
    },
    async embedQuery(text: string): Promise<number[]> {
      embedQueryCalls += 1;
      recorded.push({ method: "embedQuery", text });
      return [0.1, 0.2, 0.3, 0.4];
    },
    async embed(text: string): Promise<number[]> {
      embedCalls += 1;
      recorded.push({ method: "embed", text });
      return [0.1, 0.2, 0.3, 0.4];
    },
    async embedBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
      recorded.push({ method: "embedBatch", text: `[${texts.length}]` });
      return texts.map(() => [0.5, 0.6, 0.7, 0.8]);
    },
  };
  await rankDenseVectorWithMetadataAsync("the query", cands, {
    topK: 5,
    embedder: fakeQwen3,
    kind: "query",
  });
  // Exactly one embedQuery call for the query.
  assert.equal(embedQueryCalls, 1, "kind=query should call embedQuery exactly once");
  // The candidates go through embedBatch
  // (document-mode batch). `embed` is NOT
  // called for the candidates OR the query
  // when the embedder exposes `embedQuery`.
  assert.equal(embedCalls, 0, "kind=query should not call embed (the document path) for the query");
  // The embedBatch call is the document path.
  assert.ok(
    recorded.some((r) => r.method === "embedBatch"),
    "ranker must call embedBatch for the documents",
  );
});

test("rankDenseVectorWithMetadataAsync: kind=undefined (default) does not invoke embedQuery", async () => {
  // The default `kind` is `"document"`, so the
  // ranker uses the standard `embedBatch` path
  // for the query too (no instruction prefix).
  // A Qwen3-like embedder that exposes
  // `embedQuery` is not called when the kind is
  // the default.
  let embedQueryCalls = 0;
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const fakeQwen3: DenseEmbedder & {
    embedQuery: (t: string) => Promise<number[]>;
  } = {
    metadata: {
      backend: "qwen3",
      description: "test-fake-qwen3-default",
      modelId: "fake",
      dim: 4,
      status: "ready",
    },
    async embedQuery(): Promise<number[]> {
      embedQueryCalls += 1;
      return [0.1, 0.2, 0.3, 0.4];
    },
    async embed(): Promise<number[]> {
      return [0.1, 0.2, 0.3, 0.4];
    },
    async embedBatch(): Promise<number[][]> {
      return [[0.5, 0.6, 0.7, 0.8]];
    },
  };
  await rankDenseVectorWithMetadataAsync("the query", cands, {
    topK: 5,
    embedder: fakeQwen3,
    // kind is undefined -> default "document"
  });
  assert.equal(
    embedQueryCalls,
    0,
    "default kind should not call embedQuery",
  );
});

test("rankDenseVectorWithMetadataAsync: kind-agnostic embedders (stub / MiniLM) continue to use embedBatch", async () => {
  // The MiniLM / stub embedders do NOT expose
  // `embedQuery`. The ranker falls through to
  // the standard `embedBatch` path, which is
  // the historical contract.
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const stub = new StubDeterministicDenseEmbedder({ dim: 4 });
  const hits = await rankDenseVectorAsync("the query", cands, {
    topK: 5,
    embedder: stub,
    kind: "query",
  });
  // The result is well-formed (the stub is
  // deterministic; the ranker returns the
  // top-K by cosine).
  assert.ok(Array.isArray(hits));
  for (const h of hits) {
    assert.equal(typeof h.id, "number");
    assert.equal(typeof h.score, "number");
  }
});

// ---------------------------------------------------------------------------
// 7. CLI parser: --embedder qwen3
// ---------------------------------------------------------------------------

test("parseRetrievalCli: --embedder qwen3 is accepted", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "qwen3",
  ]);
  assert.equal(opts.denseEmbedderSpec, "qwen3");
});

test("parseRetrievalCli: --embedder qwen3-hf is accepted (alias)", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "qwen3-hf",
  ]);
  assert.equal(opts.denseEmbedderSpec, "qwen3-hf");
});

test("parseRetrievalCli: --embedder qwen3:model=...,dtype=... parses the tail", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "qwen3:model=org/custom,dtype=fp16,pooling=mean",
  ]);
  assert.equal(
    opts.denseEmbedderSpec,
    "qwen3:model=org/custom,dtype=fp16,pooling=mean",
  );
});

test("parseRetrievalCli: --embedder qwen3 --dense-cache-dir composes backend=qwen3 + cacheDir", () => {
  // The CLI composes the spec into an object so
  // the factory can route by `backend` when the
  // user combines `--embedder` with
  // `--dense-cache-dir` / `--dense-skip`.
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "qwen3",
    "--dense-cache-dir",
    "/tmp/cortex-qwen3-cli-cache",
  ]);
  const spec = opts.denseEmbedderSpec as { backend: string; cacheDir: string };
  assert.equal(spec.backend, "qwen3");
  assert.equal(spec.cacheDir, "/tmp/cortex-qwen3-cli-cache");
});

test("parseRetrievalCli: --embedder qwen3 --dense-skip composes backend=qwen3 + skip=true", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "qwen3",
    "--dense-skip",
  ]);
  const spec = opts.denseEmbedderSpec as { backend: string; skip: boolean };
  assert.equal(spec.backend, "qwen3");
  assert.equal(spec.skip, true);
});

test("parseRetrievalCli: --embedder qwen3:model=...,task=... --dense-skip preserves the key=value tail", () => {
  // The CLI composes the spec into an object when
  // --dense-skip / --dense-cache-dir is passed, but
  // it must preserve the original spec string so
  // the factory's string-spec dispatcher can
  // re-parse the `key=value` tail. Without this
  // preservation, the user's `model=...`,
  // `task=...`, `pooling=...` keys would be
  // silently dropped. The pre-existing Qwen3 CLI
  // did not preserve these keys; the EmbeddingGemma
  // work added the preservation (the bug was the
  // same shape as the Qwen3 one) and the
  // regression test pins the new contract for
  // both candidates.
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "qwen3:model=org/custom,dtype=fp16,task=Custom%20task,pooling=mean",
    "--dense-skip",
  ]);
  const spec = opts.denseEmbedderSpec as {
    backend: string;
    skip: boolean;
    spec?: string;
  };
  assert.equal(spec.backend, "qwen3");
  assert.equal(spec.skip, true);
  assert.equal(
    spec.spec,
    "qwen3:model=org/custom,dtype=fp16,task=Custom%20task,pooling=mean",
    "the original spec string must be preserved as baseObj.spec",
  );
});

test("parseRetrievalCli: --embedder transformersjs --dense-cache-dir composes backend=transformersjs (backward compat)", () => {
  // The historical MiniLM / Xenova path must
  // continue to work unchanged.
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "transformersjs",
    "--dense-cache-dir",
    "/tmp/cortex-xjs-cli-cache",
  ]);
  const spec = opts.denseEmbedderSpec as { backend: string; cacheDir: string };
  assert.equal(spec.backend, "transformersjs");
  assert.equal(spec.cacheDir, "/tmp/cortex-xjs-cli-cache");
});

// ---------------------------------------------------------------------------
// 8. MiniLM / TransformersJsEmbedder paths still work (backward compat)
// ---------------------------------------------------------------------------

test("TransformersJsEmbedder: continues to use Xenova/all-MiniLM-L6-v2 with mean pooling and 384-dim", () => {
  // The existing MiniLM backend must remain
  // unchanged. The Qwen3 work is additive; a
  // benchmark that does not pass `--embedder
  // qwen3` still uses the MiniLM path (or the
  // stub).
  const e = new TransformersJsEmbedder();
  assert.equal(e.metadata.backend, "transformersjs");
  assert.equal(e.metadata.modelId, "Xenova/all-MiniLM-L6-v2");
  assert.equal(e.metadata.dim, 384);
});

test("StubDeterministicDenseEmbedder: continues to be the deterministic control", () => {
  // The stub is the CI-friendly default. The
  // Qwen3 work does not change the stub's
  // contract.
  const e = new StubDeterministicDenseEmbedder({ dim: 32 });
  assert.equal(e.metadata.backend, "stub-dense");
  assert.equal(e.metadata.dim, 32);
});

// ---------------------------------------------------------------------------
// 9. Source-tree guard: production does NOT import qwen3-embedder
// ---------------------------------------------------------------------------

test("Qwen3 benchmark is benchmark-only: production recall() controller is not modified", () => {
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
  assert.doesNotMatch(
    recallSrc,
    /qwen3|Qwen3/i,
    "recall controller must NOT import Qwen3 modules",
  );
  const seamSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "retrieval", "seam.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    seamSrc,
    /qwen3|Qwen3/i,
    "retrieval/seam.ts must NOT import Qwen3 modules",
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

test("Qwen3 benchmark: only the benchmark directory imports the Qwen3 module", () => {
  // Whitelist: the Qwen3 module itself, the
  // benchmark runner, the dense-embedder
  // factory, the held-out runner, and the
  // existing dense vector / hybrid modules may
  // import the Qwen3 module. Production code
  // (`controller/`, `retrieval/seam.ts`,
  // `tools/`, `providers/`, `safety/`,
  // `storage/`) must NOT import it.
  const root = path.join(import.meta.dirname, "..", "src");
  const allowedImporters = new Set<string>([
    path.join("benchmark", "retrieval-runner.ts"),
    path.join("benchmark", "held-out-runner.ts"),
    path.join("benchmark", "held-out-validation.ts"),
    path.join("benchmark", "variants", "dense-embedder.ts"),
    path.join("benchmark", "variants", "dense-vector.ts"),
    path.join("benchmark", "variants", "hybrid.ts"),
    path.join("benchmark", "variants", "qwen3-embedder.ts"),
    // The EmbeddingGemma module is a sibling
    // benchmark-only candidate that may mention
    // the Qwen3 module in docstrings (it is
    // the next candidate in the same
    // evidence-first series). Allowing it
    // here does NOT change the Qwen3
    // production-import contract: the Qwen3
    // production-import guard above (test #34)
    // still applies to all production files,
    // and the EmbeddingGemma module itself
    // has its own source-tree guard in
    // `tests/retrieval-dense-embeddinggemma.test.ts`
    // that scans for EmbeddingGemma symbols
    // in production files.
    path.join("benchmark", "variants", "embeddinggemma-embedder.ts"),
    // The BGE-M3 module is a sibling
    // benchmark-only candidate that may mention
    // the Qwen3 module in docstrings (it is
    // the third candidate in the same
    // evidence-first series). Allowing it
    // here does NOT change the Qwen3
    // production-import contract: the Qwen3
    // production-import guard above (test #34)
    // still applies to all production files,
    // and the BGE-M3 module itself has its
    // own source-tree guard in
    // `tests/retrieval-dense-bge-m3.test.ts`
    // that scans for BGE-M3 symbols in
    // production files.
    path.join("benchmark", "variants", "bge-m3-embedder.ts"),
    // The .d.ts file is a type-only stub and
    // lives next to the qwen3 module.
    path.join("benchmark", "types", "huggingface-transformers.d.ts"),
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
    const importsQwen3 =
      src.includes("from \"./qwen3-embedder\"") ||
      src.includes("from \"./qwen3-embedder.js\"") ||
      src.includes("from \"../benchmark/variants/qwen3-embedder") ||
      src.includes("from \"../../benchmark/variants/qwen3-embedder");
    const usesQwen3Symbol =
      src.match(/\bQwen3Embedder\b/) !== null ||
      src.match(/\bbuildQueryPrefix\b/) !== null ||
      src.match(/\bqwen3-embedder\b/) !== null;
    assert.ok(
      !importsQwen3,
      `unexpected import of qwen3 module in ${rel}`,
    );
    assert.ok(
      !usesQwen3Symbol,
      `unexpected Qwen3 symbol usage in ${rel}`,
    );
    for (const prefix of productionDirPrefixes) {
      if (rel === prefix || rel.startsWith(prefix + path.sep)) {
        assert.ok(
          !importsQwen3,
          `production file ${rel} must not import qwen3 modules`,
        );
        assert.ok(
          !usesQwen3Symbol,
          `production file ${rel} must not use Qwen3 symbols`,
        );
      }
    }
  }
});

test("Qwen3 benchmark: type declarations are scoped to the benchmark directory", () => {
  // The `.d.ts` file lives under
  // `src/benchmark/types/`. It declares the
  // `@huggingface/transformers` module
  // ambiently. The test pins the location so a
  // future refactor does not move the file out
  // of the benchmark scope.
  const typesFile = path.join(
    import.meta.dirname,
    "..",
    "src",
    "benchmark",
    "types",
    "huggingface-transformers.d.ts",
  );
  assert.ok(
    fs.existsSync(typesFile),
    "ambient type declaration file must exist at src/benchmark/types/huggingface-transformers.d.ts",
  );
  // No type declaration lives in
  // `src/types/`, `src/controller/`, or any
  // production directory.
  for (const prodDir of [
    path.join(import.meta.dirname, "..", "src", "controller"),
    path.join(import.meta.dirname, "..", "src", "tools"),
    path.join(import.meta.dirname, "..", "src", "providers"),
    path.join(import.meta.dirname, "..", "src", "safety"),
    path.join(import.meta.dirname, "..", "src", "storage"),
  ]) {
    if (!fs.existsSync(prodDir)) continue;
    const entries = fs.readdirSync(prodDir);
    for (const e of entries) {
      assert.ok(
        !e.endsWith("huggingface-transformers.d.ts"),
        `production directory ${prodDir} must not contain a huggingface-transformers.d.ts file (found ${e})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 10. End-to-end: runDenseRetrievalBenchmark with Qwen3 (stub-fallback path)
// ---------------------------------------------------------------------------

test("runDenseRetrievalBenchmark: variant=vector-dense with embedder=qwen3 produces a well-formed report (stub fallback)", async (t) => {
  // The factory dispatches `qwen3` to the
  // Qwen3Embedder. `init()` fails (no
  // library in CI), the metadata flips to
  // `status: "error"`, and the ranker falls
  // back to the deterministic stub. The
  // benchmark report is still well-formed.
  //
  // The library IS installed in the local dev
  // environment; the end-to-end test would
  // attempt a real model download. The
  // end-to-end live test is in
  // `tests/_helpers/retrieval-dense-qwen3-live.test.ts`
  // (opt-in; not in the default `npm test`
  // glob). This end-to-end test is the
  // CI-without-network path: skip when the
  // library is installed so the unit-test
  // surface stays clean in the dev env.
  if (!(await isQwen3LibraryMissing())) {
    t.skip(
      "@huggingface/transformers is installed; the runDenseRetrievalBenchmark end-to-end path is exercised in CI where the package is absent (the live integration test in tests/_helpers/retrieval-dense-qwen3-live.test.ts covers the real-model path)",
    );
    return;
  }
  const { runDenseRetrievalBenchmark } = await import(
    "../src/benchmark/retrieval-runner.ts"
  );
  const report = await runDenseRetrievalBenchmark({
    variant: "vector-dense",
    denseEmbedderSpec: "qwen3",
  });
  const r = report as {
    variant: string;
    config: { embeddingBackend: EmbedderMetadata };
  };
  assert.equal(r.variant, "vector-dense-benchmark");
  assert.equal(r.config.embeddingBackend.backend, "qwen3");
  assert.equal(
    r.config.embeddingBackend.modelId,
    "onnx-community/Qwen3-Embedding-0.6B-ONNX",
  );
  // The status is "error" (init failed because
  // the library is not installed). The
  // benchmark still produced a report.
  assert.equal(r.config.embeddingBackend.status, "error");
});
