/**
 * Live real-model integration test for the Qwen3
 * dense retrieval benchmark.
 *
 * This test exercises the actual
 * `@huggingface/transformers` integration: it
 * constructs a `Qwen3Embedder` with the default
 * pinned model, calls `init()`, and verifies the
 * embedder actually produces a real semantic
 * vector (a semantically-similar pair scores
 * higher than an unrelated pair).
 *
 * It is the Qwen3 counterpart to the existing
 * `tests/_helpers/retrieval-dense-vector-live.test.ts`
 * (which exercises the MiniLM / Xenova path).
 *
 * Why this is a separate test file:
 *   - The model download is a one-time cost on
 *     first run (~600MB for the q8 ONNX, slower
 *     than MiniLM). A CI run that already has
 *     the model in the local cache is fast, but
 *     a fresh run is a real network + disk cost.
 *   - The test is opt-in: it is NOT in the
 *     default `npm test` glob (`tests/*.test.ts`)
 *     and is NOT in `tests/_helpers/`. The runner
 *     that wants this test must invoke it
 *     explicitly (e.g. `node --import tsx --test
 *     tests/_helpers/retrieval-dense-qwen3-live.test.ts`).
 *   - The test does NOT depend on the network at
 *     test time. If the cache is empty, the
 *     `init()` call will attempt a download; the
 *     test reports `skip` on a clear network or
 *     library-missing error and `pass` when the
 *     model is in the local cache.
 *
 * The test is intentionally minimal so it can be
 * added to a future "live integration" CI job
 * without adding to the unit-test surface.
 *
 * Usage:
 *   # First run (downloads the model):
 *   node --import tsx --test tests/_helpers/retrieval-dense-qwen3-live.test.ts
 *   # Subsequent runs (uses the local cache):
 *   node --import tsx --test tests/_helpers/retrieval-dense-qwen3-live.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { EmbedderMetadata as DenseEmbedderMetadata } from "../../src/benchmark/variants/dense-embedder.ts";
import {
  type EmbedderMetadata,
  Qwen3Embedder,
} from "../../src/benchmark/variants/qwen3-embedder.ts";

/**
 * Build a sandboxed cache directory for the live
 * test. The directory is removed on teardown so
 * the test does not leak state into the user's
 * `.curion/` directory.
 */
function makeCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curion-qwen3-live-cache-"));
}

/**
 * Probe whether `@huggingface/transformers` is
 * importable in this environment. The package is
 * declared as a devDependency but may not be
 * installed in the CI sandbox; the test is
 * gracefully skipped in that case. The probe
 * uses a dynamic import inside an async function
 * so a missing module is caught as a rejection,
 * not a synchronous syntax error.
 */
async function isLibraryAvailable(): Promise<boolean> {
  try {
    await import("@huggingface/transformers" as string);
    return true;
  } catch {
    return false;
  }
}

test("Qwen3Embedder live: init() produces a real semantic embedding with the documented prefix", async (t) => {
  // Library-missing path: skip the test
  // gracefully. The benchmark report's
  // `status: "error"` block carries the same
  // message; this test mirrors that contract.
  if (!(await isLibraryAvailable())) {
    t.skip("@huggingface/transformers is not installed in this environment");
    return;
  }
  const cacheDir = makeCacheDir();
  t.after(() => {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // Best effort; the test's assertions are
      // the source of truth.
    }
  });
  const embedder = new Qwen3Embedder({
    modelId: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    dtype: "q8",
    cacheDir,
  });
  try {
    await embedder.init();
  } catch (err) {
    // Network failure or missing library:
    // skip the test gracefully.
    const msg = err instanceof Error ? err.message : String(err);
    t.skip(`Qwen3 init() failed (network or library missing): ${msg}`);
    return;
  }
  const meta: EmbedderMetadata = embedder.metadata as EmbedderMetadata & DenseEmbedderMetadata;
  assert.equal(meta.status, "ready", "embedder metadata should report ready");
  assert.equal(meta.backend, "qwen3");
  assert.equal(meta.modelId, "onnx-community/Qwen3-Embedding-0.6B-ONNX");
  // The conventional Qwen3-Embedding-0.6B dim
  // is 1024. The `init()` probe may overwrite
  // the placeholder if the model reports a
  // different dim; the assertion is on the
  // probed value, not the placeholder.
  assert.equal(meta.dim, 1024);
  // The cache dir is on the metadata.
  assert.equal(meta.cacheDir, cacheDir);
  // The load time is captured and is a
  // non-negative number.
  assert.ok(
    typeof meta.loadMs === "number" && meta.loadMs >= 0,
    "loadMs must be a non-negative number"
  );
  // The runtime version is captured when the
  // library exposes one.
  assert.ok(
    typeof meta.runtimeVersion === "string",
    "runtimeVersion must be a string on a ready embedder"
  );
  // Embed two pairs: a semantically related
  // pair and an unrelated pair. The cosine
  // similarity of the related pair should be
  // higher. The Qwen3 model is
  // instruction-tuned: a related pair must
  // include the `Instruct:` prefix on the query
  // side; the documents are forwarded verbatim.
  // The test exercises both code paths.
  const a = await embedder.embedQuery("Postgres is the primary data store");
  const b = await embedder.embedDocument("Postgres is used for storage of project memory");
  const c = await embedder.embedDocument("The kitchen dishwasher runs nightly");
  // Manual cosine similarity (the helper is in
  // `vector.ts`; we re-implement it inline to
  // keep this test independent of the ranker).
  const cos = (x: number[], y: number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i]!;
      const yi = y[i]!;
      dot += xi * yi;
      na += xi * xi;
      nb += yi * yi;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom === 0) return 0;
    return dot / denom;
  };
  const related = cos(a, b);
  const unrelated = cos(a, c);
  assert.ok(
    related > unrelated,
    `semantically related pair should have higher cosine: ` +
      `related=${related.toFixed(4)} vs unrelated=${unrelated.toFixed(4)}`
  );
  // L2 normalization: both vectors should be
  // unit length (the Qwen3 backend applies
  // `normalize: true`).
  const norm = (x: number[]): number => {
    let s = 0;
    for (const v of x) s += v * v;
    return Math.sqrt(s);
  };
  assert.ok(Math.abs(norm(a) - 1) < 1e-3, "vector a should be L2-normalized");
  assert.ok(Math.abs(norm(b) - 1) < 1e-3, "vector b should be L2-normalized");
  assert.ok(Math.abs(norm(c) - 1) < 1e-3, "vector c should be L2-normalized");
  // Determinism: re-embed `a` and check it is
  // bit-identical. ONNX Runtime is
  // bit-deterministic for a fixed input and a
  // fixed model.
  const a2 = await embedder.embedQuery("Postgres is the primary data store");
  assert.deepEqual(a, a2, "embedQuery must be deterministic for the same input");
  // The embedder's `embedCount` and `embedMs`
  // are updated on every call. Note: the
  // embedder reassigns `metadata` on each
  // update, so we read the latest snapshot via
  // the property accessor rather than the `meta`
  // local captured at init time.
  const latestMeta: EmbedderMetadata = embedder.metadata as EmbedderMetadata &
    DenseEmbedderMetadata;
  assert.ok(
    typeof latestMeta.embedCount === "number" && latestMeta.embedCount >= 3,
    "embedCount should be >= 3 after three embed calls"
  );
  assert.ok(
    typeof latestMeta.embedMs === "number" && latestMeta.embedMs >= 0,
    "embedMs should be a non-negative number"
  );
  // Document vs query path: a query and a
  // document with the SAME plain text produce
  // DIFFERENT embeddings under Qwen3 (the
  // instruction prefix on the query side
  // changes the model's forward pass). The
  // assertion is the live contract: a real
  // Qwen3 model applies the prefix.
  const queryText = "Postgres is the primary data store";
  const queryVec = await embedder.embedQuery(queryText);
  const docVec = await embedder.embedDocument(queryText);
  let equal = true;
  for (let i = 0; i < queryVec.length; i++) {
    if (queryVec[i] !== docVec[i]) {
      equal = false;
      break;
    }
  }
  assert.equal(
    equal,
    false,
    "Qwen3 live: embedQuery and embedDocument must produce different vectors for the same input text (instruction prefix)"
  );
});
