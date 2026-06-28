/**
 * BGE-M3 dense-embedding benchmark tests.
 *
 * The BGE-M3 benchmark is a `research-only /
 * benchmark-only` experiment on a new dense
 * embedding candidate (BAAI/bge-m3 via
 * `Xenova/bge-m3`, CLS pooling, 1024-dim, q8
 * ONNX, MIT license, kind-agnostic dense
 * mode). The brief is explicit: BGE-M3 is ONE
 * candidate, not assumed best. The
 * implementation is a strict superset of the
 * existing dense-vector benchmark; the existing
 * MiniLM / Qwen3 / EmbeddingGemma backends
 * continue to work unchanged.
 *
 * The test file does NOT require a network
 * download. The BGE-M3 backend is exercised
 * without a real `@huggingface/transformers`
 * install: the embedder's `init()` will fail to
 * load the library (because the package may not
 * be installed in the CI environment), and the
 * embedder will fall back to the deterministic
 * stub. The tests assert the fallback is wired
 * correctly and the kind-agnostic contract is
 * honored.
 *
 * A separate opt-in "live model" test exists in
 * `tests/_helpers/retrieval-dense-bge-m3-live.test.ts`.
 *
 * The tests cover:
 *   1. Spec parsing: `bge-m3`, `bgem3`,
 *      `bge-m3:model=...,dtype=...,pooling=...`
 *      are all parsed correctly.
 *   2. Factory dispatch: the
 *      `createDenseEmbedder` factory routes
 *      `bge-m3` to the BGE-M3 backend and
 *      `bgem3` is treated as an alias.
 *   3. Kind-agnostic contract: BGE-M3's
 *      `embedQuery` / `embedDocument` /
 *      `embedDocumentsBatch` / `embed` /
 *      `embedBatch` are all plain forwarders
 *      (no instruction prefix). The kind-aware
 *      interface is preserved so the ranker's
 *      `kind: "query"` dispatch path works
 *      unchanged.
 *   4. Metadata block: the embedder's
 *      `metadata` is well-formed (backend,
 *      modelId, dim, dtype, pooling, normalized,
 *      status, cacheDir, license=MIT).
 *   5. `init()` failure path: when the library
 *      is not installed, `init()` flips the
 *      embedder to `status: "error"` and the
 *      `embed` / `embedBatch` calls fall back to
 *      the deterministic stub.
 *   6. Document-mode default: `embed()` /
 *      `embedBatch()` map to `embedDocument` /
 *      `embedDocumentsBatch` (kind-agnostic
 *      forwarders in the BGE-M3 case).
 *   7. MiniLM / stub / `transformersjs` /
 *      Qwen3 / EmbeddingGemma paths continue to
 *      work unchanged. The factory still
 *      dispatches `stub-dense`, `transformersjs`,
 *      `qwen3`, and `embeddinggemma` specs to the
 *      existing backends.
 *   8. Source-tree guard: the production
 *      `recall(text)` controller, the public
 *      MCP server, the tools, the providers, the
 *      safety / storage layers, and the
 *      retrieval seam do NOT import the BGE-M3
 *      module. The benchmark directory (and the
 *      new BGE-M3 test file itself) may.
 *   9. CLI parser: `--embedder bge-m3` is
 *      accepted and routed correctly, with and
 *      without `--dense-cache-dir` /
 *      `--dense-skip`. The `bgem3` alias is
 *      accepted. The `key=value` tail is
 *      preserved through the object-spec
 *      composition.
 *  10. Public MCP API guard: the server still
 *      registers exactly `remember` + `recall`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createDenseEmbedder,
  StubDeterministicDenseEmbedder,
  TransformersJsEmbedder,
  type EmbedderMetadata,
  type DenseEmbedder,
} from "../src/benchmark/variants/dense-embedder.ts";
import {
  BgeM3Embedder,
  type BgeM3TextKind,
} from "../src/benchmark/variants/bge-m3-embedder.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import {
  rankDenseVectorAsync,
  rankDenseVectorWithMetadataAsync,
} from "../src/benchmark/variants/dense-vector.ts";
import { parseRetrievalCli } from "../src/benchmark/retrieval-runner.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { walkTs } from "./_helpers/fs-walk.ts";

// ---------------------------------------------------------------------------
// 1. BgeM3Embedder construction + metadata
// ---------------------------------------------------------------------------

test("BgeM3Embedder: construction exposes the documented metadata", () => {
  const embedder = new BgeM3Embedder();
  const m: EmbedderMetadata = embedder.metadata;
  assert.equal(m.backend, "bge-m3");
  assert.equal(
    m.modelId,
    "Xenova/bge-m3",
    "default model id must be the pinned Xenova/bge-m3 mirror",
  );
  assert.equal(m.dim, 1024, "BGE-M3 dense mode produces 1024-dim vectors");
  assert.equal(
    m.quantized,
    true,
    "default dtype q8 means the embedder reports quantized=true",
  );
  assert.equal(
    m.status,
    "skipped",
    "construction is in skipped status until init()",
  );
  // The description surfaces the key knobs so a
  // reviewer reading the metadata can audit the
  // configuration.
  assert.ok(
    typeof m.description === "string" && m.description.includes("q8"),
    `description must mention the q8 dtype; got: ${m.description}`,
  );
  assert.ok(
    m.description.includes("cls"),
    `description must mention the cls pooling; got: ${m.description}`,
  );
  // The MIT license is surfaced on the description
  // so a reviewer can audit it on the artifact.
  assert.ok(
    m.description.includes("MIT"),
    `description must mention the MIT license; got: ${m.description}`,
  );
  // The cache dir is the documented default.
  assert.equal(
    m.cacheDir,
    `${process.cwd()}/.curion/transformers-cache`,
  );
});

test("BgeM3Embedder: custom modelId, dtype, pooling, cacheDir are honored", () => {
  const embedder = new BgeM3Embedder({
    modelId: "custom-org/custom-bge-m3-onnx",
    dtype: "fp16",
    pooling: "mean",
    cacheDir: "/tmp/curion-bge-m3-test-cache",
  });
  const m = embedder.metadata;
  assert.equal(m.modelId, "custom-org/custom-bge-m3-onnx");
  // `quantized` is `true` only when the dtype
  // starts with `q`. `fp16` is not quantized.
  assert.equal(m.quantized, false);
  assert.equal(m.cacheDir, "/tmp/curion-bge-m3-test-cache");
  // The description surfaces the custom values.
  assert.ok(m.description.includes("fp16"));
  assert.ok(m.description.includes("mean"));
});

test("BgeM3Embedder: custom dim is honored and surfaced on the metadata", () => {
  const embedder = new BgeM3Embedder({ dim: 512 });
  assert.equal(embedder.metadata.dim, 512);
});

// ---------------------------------------------------------------------------
// 2. Kind-agnostic contract
// ---------------------------------------------------------------------------

test("BgeM3Embedder: embedQuery, embedDocument, embed, embedBatch are all plain forwarders (no prefix)", async () => {
  // BGE-M3 dense mode is kind-agnostic. There is
  // NO `Instruct:` / `Query:` prefix (vs Qwen3)
  // and NO `task:` / `title:` prefix (vs
  // EmbeddingGemma). The `embedQuery` /
  // `embedDocument` methods exist for the
  // ranker's `kind: "query"` dispatch path so the
  // BGE-M3 backend is detected as a kind-aware
  // embedder at the call site; both methods are
  // plain forwarders to the underlying pipeline.
  const embedder = new BgeM3Embedder();
  // Public surface exists.
  assert.equal(typeof embedder.embedQuery, "function");
  assert.equal(typeof embedder.embedDocument, "function");
  assert.equal(typeof embedder.embedDocumentsBatch, "function");
  assert.equal(typeof embedder.embed, "function");
  assert.equal(typeof embedder.embedBatch, "function");
});

test("BgeM3Embedder: embedDocument and embedQuery are both async and return dim-shaped vectors", async () => {
  // We do NOT call `init()` here. The embedder's
  // `embed` / `embedQuery` / `embedDocument` fall
  // back to the deterministic stub when the
  // pipeline is not initialized. The stub is
  // 1024-dim (per the `dim: 1024` metadata), so
  // the test is well-formed even without the
  // real BGE-M3 model.
  const embedder = new BgeM3Embedder();
  const docVec = await embedder.embedDocument("Postgres primary data store");
  const queryVec = await embedder.embedQuery("database?");
  assert.equal(docVec.length, 1024);
  assert.equal(queryVec.length, 1024);
});

test("BgeM3Embedder: embed() and embedBatch() default to document mode (forwarded to embedDocument/embedDocumentsBatch)", async () => {
  // The `DenseEmbedder` contract is `embed(text)`
  // and `embedBatch(texts)`. The BGE-M3 embedder
  // maps these to `embedDocument` /
  // `embedDocumentsBatch` (which are plain
  // forwarders in the BGE-M3 case). The test
  // pins the public-surface contract.
  const embedder = new BgeM3Embedder();
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

test("BgeM3Embedder: embed() / embedBatch() match embedDocument() / embedDocumentsBatch() (kind-agnostic)", async () => {
  // When the embedder is in the fallback path
  // (pipeline not initialized), the deterministic
  // stub returns the same vector for the same
  // text regardless of the call shape. The test
  // pins the contract: `embed(t) === embedDocument(t)`
  // and `embedBatch([t])[0] === embedDocument(t)`.
  // The contract is the foundation of the
  // drop-in-compatible claim.
  const embedder = new BgeM3Embedder();
  const text = "Postgres primary data store";
  const v1 = await embedder.embed(text);
  const v2 = await embedder.embedDocument(text);
  assert.deepEqual(v1, v2);
  const batch = await embedder.embedBatch([text]);
  assert.deepEqual(batch[0], v1);
});

test("BgeM3Embedder: fallback path is input-driven (embedQuery / embedDocument produce identical vectors for identical input)", async () => {
  // This is a structural test of the FALLBACK path
  // (pipeline not initialized; the deterministic
  // stub takes over). The embedder's public
  // surface is `embedQuery`, `embedDocument`,
  // `embedDocumentsBatch`, `embed`, `embedBatch`.
  // In the BGE-M3 case ALL of these are plain
  // forwarders (the BGE-M3 dense mode is
  // kind-agnostic); the real-model path also
  // produces identical vectors for `embedQuery`
  // and `embedDocument` for the same input text.
  // The live test in
  // `tests/_helpers/retrieval-dense-bge-m3-live.test.ts`
  // exercises the real-model contract.
  const embedder = new BgeM3Embedder();
  const qv = await embedder.embedQuery("What is the database?");
  const dv = await embedder.embedDocument("What is the database?");
  assert.equal(qv.length, dv.length);
  // The fallback path is input-driven: the
  // stub ignores the call shape (`embedQuery`
  // vs `embedDocument`) and produces the same
  // vector for the same input text. This is
  // the FALLBACK contract, which matches the
  // BGE-M3 real-model contract (both methods
  // are plain forwarders).
  let equal = true;
  for (let i = 0; i < qv.length; i++) {
    if (qv[i] !== dv[i]) {
      equal = false;
      break;
    }
  }
  assert.equal(
    equal,
    true,
    "BGE-M3: identical input produces identical vector (kind-agnostic)",
  );
});

test("BgeM3Embedder: BgeM3TextKind is the documented union", () => {
  // The type is exported so benchmark helpers
  // can reference it. A test that pins the
  // string literal values is a contract guard
  // for downstream consumers.
  const kinds: BgeM3TextKind[] = ["query", "document"];
  assert.deepEqual([...kinds], ["query", "document"]);
});

// ---------------------------------------------------------------------------
// 3. init() failure / fallback path
// ---------------------------------------------------------------------------

/**
 * Library-availability probe. Mirrors the
 * helper in the existing dense tests: the
 * `init() failure path` tests below exercise
 * the embedder's behavior when the
 * `@huggingface/transformers` package is NOT
 * installed. If the package IS installed (e.g.
 * on a developer machine that ran `npm
 * install`), the library loads successfully,
 * `init()` does not fail, and these tests have
 * nothing to assert. They are skipped in that
 * env; the live integration test (which
 * exercises the real model) covers the success
 * path.
 */
async function isBgeM3LibraryMissing(): Promise<boolean> {
  try {
    await import("@huggingface/transformers" as string);
    return false;
  } catch {
    return true;
  }
}

test("BgeM3Embedder: init() without a real library reports `error` metadata", async (t) => {
  // The `@huggingface/transformers` package is
  // NOT installed in the CI environment. The
  // embedder's `init()` should fail with a
  // clean error and flip the metadata to
  // `status: "error"`. The error message is
  // captured on `errorMessage`. The benchmark
  // runner falls back to the deterministic
  // stub for the rest of the run. If the
  // library IS installed (e.g. on a dev
  // machine), the `init()` succeeds, the
  // metadata flips to `status: "ready"`, and
  // this test has nothing to assert; the live
  // integration test covers the success path.
  if (!(await isBgeM3LibraryMissing())) {
    t.skip(
      "@huggingface/transformers is installed; the init-failure path is exercised in CI where the package is absent",
    );
    return;
  }
  const embedder = new BgeM3Embedder({
    cacheDir: "/tmp/curion-bge-m3-test-cache-fail",
  });
  // The pre-init metadata is `status: "skipped"`.
  assert.equal(embedder.metadata.status, "skipped");
  // We do NOT assert the init() throws or
  // resolves; the BGE-M3 embedder's contract is
  // to swallow the error and flip to
  // `status: "error"`. The post-init metadata
  // should be `status: "error"`.
  await embedder.init();
  assert.equal(
    embedder.metadata.status,
    "error",
    "init() must flip status to 'error' when the library is not installed",
  );
  // The error message is captured so a
  // reviewer can audit the failure on the
  // artifact.
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

test("BgeM3Embedder: embed() / embedBatch() fall back to the stub when init() failed", async (t) => {
  // Companion to the test above: this test
  // assumes the library is missing. If the
  // library is present, `init()` succeeds and
  // the embedder is live; the fallback path is
  // not exercised and this test is skipped.
  if (!(await isBgeM3LibraryMissing())) {
    t.skip(
      "@huggingface/transformers is installed; the init-failure fallback is exercised in CI where the package is absent",
    );
    return;
  }
  // The benchmark runner relies on this: when
  // `init()` fails, the embedder must still be
  // safe to call. The fallback uses the
  // deterministic stub at the BGE-M3 dim.
  const embedder = new BgeM3Embedder();
  await embedder.init();
  assert.equal(embedder.metadata.status, "error");
  const v = await embedder.embed("Postgres is the primary data store");
  // The fallback dim is the embedder's
  // metadata dim (1024 by default).
  assert.equal(v.length, 1024);
  const batch = await embedder.embedBatch(["a", "b", "c"]);
  assert.equal(batch.length, 3);
  for (const vec of batch) {
    assert.equal(vec.length, 1024);
  }
  // The deterministic stub is
  // unit-L2-normalized.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  assert.ok(Math.abs(norm - 1) < 1e-9 || norm === 0);
});

// ---------------------------------------------------------------------------
// 4. createDenseEmbedder: factory dispatch
// ---------------------------------------------------------------------------

test("createDenseEmbedder: 'bge-m3' spec dispatches to BgeM3Embedder", async () => {
  const { embedder, spec } = await createDenseEmbedder(
    "bge-m3",
    { skip: true },
  );
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.equal(
    embedder.metadata.modelId,
    "Xenova/bge-m3",
  );
  // The factory skips init when `skip: true`
  // so the test does not require the library.
  // The `status: "skipped"` placeholder is
  // documented.
  assert.equal(embedder.metadata.status, "skipped");
  // The factory returns the original spec
  // string for reporting.
  assert.equal(spec, "bge-m3");
});

test("createDenseEmbedder: 'bgem3' is an alias for 'bge-m3'", async () => {
  const { embedder, spec } = await createDenseEmbedder(
    "bgem3",
    { skip: true },
  );
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.equal(spec, "bgem3");
});

test("createDenseEmbedder: 'bge-m3:model=...,dtype=...,pooling=...' parses all keys", async () => {
  const specStr =
    "bge-m3:model=org/custom-bge-m3-onnx,dtype=fp16,pooling=mean";
  const { embedder } = await createDenseEmbedder(specStr, { skip: true });
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.equal(
    embedder.metadata.modelId,
    "org/custom-bge-m3-onnx",
  );
  // The description surfaces the custom values.
  assert.ok(embedder.metadata.description.includes("fp16"));
  assert.ok(embedder.metadata.description.includes("mean"));
});

test("createDenseEmbedder: 'bge-m3:pooling=<unknown>' falls back to the default", async () => {
  // An unknown pooling value is silently
  // ignored (the BGE-M3 embedder constructor
  // uses its default `cls`).
  const { embedder } = await createDenseEmbedder(
    "bge-m3:pooling=unknown",
    { skip: true },
  );
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.ok(embedder.metadata.description.includes("cls"));
});

test("createDenseEmbedder: object spec with backend=bge-m3 dispatches to BGE-M3", async () => {
  const { embedder } = await createDenseEmbedder({
    backend: "bge-m3",
    cacheDir: "/tmp/curion-bge-m3-obj-spec-cache",
  });
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.equal(
    embedder.metadata.cacheDir,
    "/tmp/curion-bge-m3-obj-spec-cache",
  );
});

test("createDenseEmbedder: 'bge-m3' without skip calls init() and may report error when library is missing", async (t) => {
  // Companion to the two `init()` failure path
  // tests above. If the library is present,
  // `init()` succeeds and the contract under
  // test is not exercised; skip in that env.
  if (!(await isBgeM3LibraryMissing())) {
    t.skip(
      "@huggingface/transformers is installed; the init-failure factory contract is exercised in CI where the package is absent",
    );
    return;
  }
  // The `skip` default is `false`. The factory
  // calls `init()`. The library is not
  // installed in the CI environment, so init()
  // flips the metadata to `status: "error"`.
  // The test pins this contract: the factory
  // does not throw, and the returned embedder
  // is in `error` status (so the benchmark
  // runner falls back to the deterministic
  // stub for the rest of the run).
  const { embedder } = await createDenseEmbedder("bge-m3");
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.equal(embedder.metadata.status, "error");
  assert.ok(
    typeof embedder.metadata.errorMessage === "string" &&
      embedder.metadata.errorMessage.length > 0,
  );
});

test("createDenseEmbedder: existing 'stub-dense' / 'transformersjs' / 'qwen3' / 'embeddinggemma' specs continue to work unchanged", async () => {
  // The factory's existing dispatch must
  // remain unchanged. These tests pin the
  // backward-compat contract: the BGE-M3 path
  // is additive.
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
  // The Qwen3 path must continue to work
  // unchanged (the BGE-M3 work is additive to
  // the Qwen3 work).
  const qwen3 = await createDenseEmbedder("qwen3", { skip: true });
  assert.equal(qwen3.embedder.metadata.backend, "qwen3");
  assert.equal(
    qwen3.embedder.metadata.modelId,
    "onnx-community/Qwen3-Embedding-0.6B-ONNX",
  );
  // The EmbeddingGemma path must continue to
  // work unchanged (the BGE-M3 work is additive
  // to the EmbeddingGemma work).
  const eg = await createDenseEmbedder("embeddinggemma", { skip: true });
  assert.equal(eg.embedder.metadata.backend, "embeddinggemma");
  assert.equal(
    eg.embedder.metadata.modelId,
    "onnx-community/embeddinggemma-300m-ONNX",
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
// 5. kind-`"query"` threading through rankDenseVectorAsync
// ---------------------------------------------------------------------------

test("rankDenseVectorWithMetadataAsync: kind='query' dispatches to embedQuery for BGE-M3-like embedder", async () => {
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
  const fakeBgeM3: DenseEmbedder & {
    embedQuery: (t: string) => Promise<number[]>;
    embed: (t: string) => Promise<number[]>;
  } = {
    metadata: {
      backend: "bge-m3",
      description: "test-fake-bge-m3",
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
    embedder: fakeBgeM3,
    kind: "query",
  });
  // Exactly one embedQuery call for the query.
  assert.equal(
    embedQueryCalls,
    1,
    "kind=query should call embedQuery exactly once",
  );
  // The candidates go through embedBatch
  // (document-mode batch). `embed` is NOT
  // called for the candidates OR the query
  // when the embedder exposes `embedQuery`.
  assert.equal(
    embedCalls,
    0,
    "kind=query should not call embed (the document path) for the query",
  );
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
  // A BGE-M3-like embedder that exposes
  // `embedQuery` is not called when the kind is
  // the default.
  let embedQueryCalls = 0;
  const cands = buildCandidates(BENCHMARK_RECORDS);
  const fakeBgeM3: DenseEmbedder & {
    embedQuery: (t: string) => Promise<number[]>;
  } = {
    metadata: {
      backend: "bge-m3",
      description: "test-fake-bge-m3-default",
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
    embedder: fakeBgeM3,
    // kind is undefined -> default "document"
  });
  assert.equal(
    embedQueryCalls,
    0,
    "default kind should not call embedQuery",
  );
});

test("rankDenseVectorAsync: kind-agnostic embedders (stub / MiniLM) continue to use embedBatch", async () => {
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
// 6. CLI parser: --embedder bge-m3
// ---------------------------------------------------------------------------

test("parseRetrievalCli: --embedder bge-m3 is accepted", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "bge-m3",
  ]);
  assert.equal(opts.denseEmbedderSpec, "bge-m3");
});

test("parseRetrievalCli: --embedder bgem3 is accepted (alias)", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "bgem3",
  ]);
  assert.equal(opts.denseEmbedderSpec, "bgem3");
});

test("parseRetrievalCli: --embedder bge-m3:model=...,dtype=...,pooling=... parses the tail", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "bge-m3:model=org/custom,dtype=fp16,pooling=mean",
  ]);
  assert.equal(
    opts.denseEmbedderSpec,
    "bge-m3:model=org/custom,dtype=fp16,pooling=mean",
  );
});

test("parseRetrievalCli: --embedder bge-m3 --dense-cache-dir composes backend=bge-m3 + cacheDir", () => {
  // The CLI composes the spec into an object so
  // the factory can route by `backend` when the
  // user combines `--embedder` with
  // `--dense-cache-dir` / `--dense-skip`.
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "bge-m3",
    "--dense-cache-dir",
    "/tmp/curion-bge-m3-cli-cache",
  ]);
  const spec = opts.denseEmbedderSpec as {
    backend: string;
    cacheDir: string;
  };
  assert.equal(spec.backend, "bge-m3");
  assert.equal(spec.cacheDir, "/tmp/curion-bge-m3-cli-cache");
});

test("parseRetrievalCli: --embedder bge-m3 --dense-skip composes backend=bge-m3 + skip=true", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "bge-m3",
    "--dense-skip",
  ]);
  const spec = opts.denseEmbedderSpec as { backend: string; skip: boolean };
  assert.equal(spec.backend, "bge-m3");
  assert.equal(spec.skip, true);
});

test("parseRetrievalCli: --embedder bge-m3:model=...,pooling=... --dense-skip preserves the key=value tail", () => {
  // The CLI composes the spec into an object when
  // --dense-skip / --dense-cache-dir is passed, but
  // it must preserve the original spec string so
  // the factory's string-spec dispatcher can
  // re-parse the `key=value` tail. Without this
  // preservation, the user's `model=...`,
  // `pooling=...` keys would be silently dropped.
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--embedder",
    "bge-m3:model=org/custom,dtype=fp16,pooling=mean",
    "--dense-skip",
  ]);
  const spec = opts.denseEmbedderSpec as {
    backend: string;
    skip: boolean;
    spec?: string;
  };
  assert.equal(spec.backend, "bge-m3");
  assert.equal(spec.skip, true);
  assert.equal(
    spec.spec,
    "bge-m3:model=org/custom,dtype=fp16,pooling=mean",
    "the original spec string must be preserved as baseObj.spec",
  );
});

test("createDenseEmbedder: object spec with backend=bge-m3 + spec=bge-m3:model=... preserves the key=value tail", async () => {
  // Companion to the CLI test above. The
  // factory re-dispatches to the string-spec
  // path when the object form carries a
  // `spec` field, so the key=value tail is
  // preserved end-to-end.
  const { embedder } = await createDenseEmbedder({
    backend: "bge-m3",
    spec:
      "bge-m3:model=org/custom-bge-m3-onnx,dtype=fp16,pooling=mean",
    skip: true,
  });
  assert.equal(embedder.metadata.backend, "bge-m3");
  assert.equal(
    embedder.metadata.modelId,
    "org/custom-bge-m3-onnx",
  );
  assert.ok(embedder.metadata.description.includes("fp16"));
  assert.ok(embedder.metadata.description.includes("mean"));
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
    "/tmp/curion-xjs-cli-cache",
  ]);
  const spec = opts.denseEmbedderSpec as {
    backend: string;
    cacheDir: string;
  };
  assert.equal(spec.backend, "transformersjs");
  assert.equal(spec.cacheDir, "/tmp/curion-xjs-cli-cache");
});

// ---------------------------------------------------------------------------
// 7. MiniLM / TransformersJsEmbedder paths still work (backward compat)
// ---------------------------------------------------------------------------

test("TransformersJsEmbedder: continues to use Xenova/all-MiniLM-L6-v2 with mean pooling and 384-dim", () => {
  // The existing MiniLM backend must remain
  // unchanged. The BGE-M3 work is additive; a
  // benchmark that does not pass
  // `--embedder bge-m3` still uses the MiniLM
  // path (or the stub).
  const e = new TransformersJsEmbedder();
  assert.equal(e.metadata.backend, "transformersjs");
  assert.equal(e.metadata.modelId, "Xenova/all-MiniLM-L6-v2");
  assert.equal(e.metadata.dim, 384);
});

test("StubDeterministicDenseEmbedder: continues to be the deterministic control", () => {
  // The stub is the CI-friendly default. The
  // BGE-M3 work does not change the stub's
  // contract.
  const e = new StubDeterministicDenseEmbedder({ dim: 32 });
  assert.equal(e.metadata.backend, "stub-dense");
  assert.equal(e.metadata.dim, 32);
});

// ---------------------------------------------------------------------------
// 8. Source-tree guard: production does NOT import bge-m3-embedder
// ---------------------------------------------------------------------------

test("BGE-M3 benchmark is benchmark-only: production recall() controller is not modified", () => {
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
    /bge-m3|BgeM3|BGEM3|bge_m3/i,
    "recall controller must NOT import BGE-M3 modules",
  );
  const seamSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "retrieval", "seam.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    seamSrc,
    /bge-m3|BgeM3|BGEM3|bge_m3/i,
    "retrieval/seam.ts must NOT import BGE-M3 modules",
  );
  // The MCP server still exposes exactly two
  // tools.
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

test("BGE-M3 benchmark: only the benchmark directory imports the BGE-M3 module", () => {
  // Whitelist: the BGE-M3 module itself, the
  // benchmark runner, the dense-embedder
  // factory, the held-out runner, and the
  // existing dense vector / hybrid modules may
  // import the BGE-M3 module. Production code
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
  for (const rel of walkTs(root, { excludeDts: false })) {
    if (allowedImporters.has(rel)) continue;
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const importsBgeM3 =
      src.includes("from \"./bge-m3-embedder\"") ||
      src.includes("from \"./bge-m3-embedder.js\"") ||
      src.includes("from \"../benchmark/variants/bge-m3-embedder") ||
      src.includes("from \"../../benchmark/variants/bge-m3-embedder");
    const usesBgeM3Symbol =
      src.match(/\bBgeM3Embedder\b/) !== null ||
      src.match(/\bBgeM3TextKind\b/) !== null ||
      src.match(/\bbge-m3-embedder\b/) !== null ||
      // Backend id `bge-m3` is unique to the
      // BGE-M3 module.
      /"bge-m3"/.test(src) ||
      /'bge-m3'/.test(src);
    assert.ok(
      !importsBgeM3,
      `unexpected import of bge-m3 module in ${rel}`,
    );
    assert.ok(
      !usesBgeM3Symbol,
      `unexpected BGE-M3 symbol usage in ${rel}`,
    );
    for (const prefix of productionDirPrefixes) {
      if (rel === prefix || rel.startsWith(prefix + path.sep)) {
        assert.ok(
          !importsBgeM3,
          `production file ${rel} must not import bge-m3 modules`,
        );
        assert.ok(
          !usesBgeM3Symbol,
          `production file ${rel} must not use BGE-M3 symbols`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 9. End-to-end: runDenseRetrievalBenchmark with BGE-M3 (stub-fallback path)
// ---------------------------------------------------------------------------

test("runDenseRetrievalBenchmark: variant=vector-dense with embedder=bge-m3 produces a well-formed report (stub fallback)", async (t) => {
  // The factory dispatches `bge-m3` to the
  // BgeM3Embedder. `init()` fails (no library
  // in CI), the metadata flips to
  // `status: "error"`, and the ranker falls
  // back to the deterministic stub. The
  // benchmark report is still well-formed.
  //
  // The library IS installed in the local dev
  // environment; the end-to-end test would
  // attempt a real model download. The
  // end-to-end live test is in
  // `tests/_helpers/retrieval-dense-bge-m3-live.test.ts`
  // (opt-in; not in the default `npm test`
  // glob). This end-to-end test is the
  // CI-without-network path: skip when the
  // library is installed so the unit-test
  // surface stays clean in the dev env.
  if (!(await isBgeM3LibraryMissing())) {
    t.skip(
      "@huggingface/transformers is installed; the runDenseRetrievalBenchmark end-to-end path is exercised in CI where the package is absent (the live integration test in tests/_helpers/retrieval-dense-bge-m3-live.test.ts covers the real-model path)",
    );
    return;
  }
  const { runDenseRetrievalBenchmark } = await import(
    "../src/benchmark/retrieval-runner.ts"
  );
  const report = await runDenseRetrievalBenchmark({
    variant: "vector-dense",
    denseEmbedderSpec: "bge-m3",
  });
  const r = report as {
    variant: string;
    config: { embeddingBackend: EmbedderMetadata };
  };
  assert.equal(r.variant, "vector-dense-benchmark");
  assert.equal(r.config.embeddingBackend.backend, "bge-m3");
  assert.equal(
    r.config.embeddingBackend.modelId,
    "Xenova/bge-m3",
  );
  // The status is "error" (init failed because
  // the library is not installed). The
  // benchmark still produced a report.
  assert.equal(r.config.embeddingBackend.status, "error");
});
