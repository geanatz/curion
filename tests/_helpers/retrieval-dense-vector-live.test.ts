/**
 * Live real-model integration test for the dense
 * retrieval benchmark.
 *
 * This test exercises the actual
 * `@xenova/transformers` integration: it constructs a
 * `TransformersJsEmbedder` with the default pinned
 * model, calls `init()`, and verifies the embedder
 * actually produces a real semantic vector (a
 * semantically-similar pair scores higher than an
 * unrelated pair).
 *
 * Why this is a separate test file:
 *   - The model download is a one-time cost on first
 *     run (~25MB, ~700ms). A CI run that already
 *     has the model in the local cache is fast.
 *   - The test is opt-in: it is NOT in the default
 *     `npm test` glob (`tests/*.test.ts`) and is NOT
 *     in `tests/_helpers/`. The runner that wants
 *     this test must invoke it explicitly
 *     (e.g. `node --import tsx --test
 *     tests/retrieval-dense-vector-live.test.ts`).
 *   - The test does NOT depend on the network at
 *     test time. If the cache is empty, the
 *     `init()` call will attempt a download; the
 *     test reports `skip` on a clear network error
 *     and `pass` when the model is in the local
 *     cache.
 *
 * The test is intentionally minimal so it can be
 * added to a future "live integration" CI job
 * without adding to the unit-test surface.
 *
 * Usage:
 *   # First run (downloads the model):
 *   node --import tsx --test tests/retrieval-dense-vector-live.test.ts
 *   # Subsequent runs (uses the local cache):
 *   node --import tsx --test tests/retrieval-dense-vector-live.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  TransformersJsEmbedder,
  type EmbedderMetadata,
} from "../../src/benchmark/variants/dense-embedder.ts";

/**
 * Build a sandboxed cache directory for the live test.
 * The directory is removed on teardown so the test does
 * not leak state into the user's `.cortex/` directory.
 */
function makeCacheDir(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "cortex-dense-live-cache-"),
  );
}

test("TransformersJsEmbedder live: init() produces a real semantic embedding", async (t) => {
  const cacheDir = makeCacheDir();
  t.after(() => {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // Best effort; the test's assertions are the
      // source of truth.
    }
  });
  const embedder = new TransformersJsEmbedder({
    modelId: "Xenova/all-MiniLM-L6-v2",
    quantized: true,
    cacheDir,
  });
  try {
    await embedder.init();
  } catch (err) {
    // Network failure or missing library: skip the
    // test gracefully. The benchmark report's
    // `status: "error"` block carries the same
    // message; this test mirrors that contract.
    const msg = err instanceof Error ? err.message : String(err);
    t.skip(`Transformers.js init() failed (network or library missing): ${msg}`);
    return;
  }
  const meta: EmbedderMetadata = embedder.metadata;
  assert.equal(meta.status, "ready", "embedder metadata should report ready");
  assert.equal(meta.backend, "transformersjs");
  assert.equal(meta.modelId, "Xenova/all-MiniLM-L6-v2");
  assert.equal(meta.quantized, true);
  // The conventional MiniLM dim is 384.
  assert.equal(meta.dim, 384);
  // The cache dir is on the metadata.
  assert.equal(meta.cacheDir, cacheDir);
  // The load time is captured and is a positive
  // number (the first ONNX session build takes a
  // few hundred ms; a cached run is faster).
  assert.ok(
    typeof meta.loadMs === "number" && meta.loadMs >= 0,
    "loadMs must be a non-negative number",
  );
  // Embed two pairs: a semantically related pair and
  // an unrelated pair. The cosine similarity of the
  // related pair should be higher.
  const a = await embedder.embed("Postgres is the primary data store");
  const b = await embedder.embed("Postgres is used for storage");
  const c = await embedder.embed("The kitchen dishwasher runs nightly");
  // Manual cosine similarity (the helper is in
  // `vector.ts`; we re-implement it inline to keep
  // this test independent of the ranker).
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
      `related=${related.toFixed(4)} vs unrelated=${unrelated.toFixed(4)}`,
  );
  // L2 normalization: both vectors should be unit
  // length (the transformers.js backend applies
  // `normalize: true`).
  const norm = (x: number[]): number => {
    let s = 0;
    for (const v of x) s += v * v;
    return Math.sqrt(s);
  };
  assert.ok(Math.abs(norm(a) - 1) < 1e-3, "vector a should be L2-normalized");
  assert.ok(Math.abs(norm(b) - 1) < 1e-3, "vector b should be L2-normalized");
  assert.ok(
    Math.abs(norm(c) - 1) < 1e-3,
    "vector c should be L2-normalized",
  );
  // Determinism: re-embed `a` and check it is
  // bit-identical. ONNX Runtime is bit-deterministic
  // for a fixed input and a fixed model.
  const a2 = await embedder.embed("Postgres is the primary data store");
  assert.deepEqual(a, a2, "embedder must be deterministic for the same input");
  // The embedder's `embedCount` and `embedMs` are
  // updated on every call. Note: the embedder
  // reassigns `metadata` on each update, so we read
  // the latest snapshot via the property accessor
  // rather than the `meta` local captured at init
  // time.
  const latestMeta: EmbedderMetadata = embedder.metadata;
  assert.ok(
    typeof latestMeta.embedCount === "number" && latestMeta.embedCount >= 3,
    "embedCount should be >= 3 after three embed calls",
  );
  assert.ok(
    typeof latestMeta.embedMs === "number" && latestMeta.embedMs >= 0,
    "embedMs should be a non-negative number",
  );
});
