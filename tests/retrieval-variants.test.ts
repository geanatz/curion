/**
 * Retrieval variant skeleton tests.
 *
 * Verifies the registry contains all five placeholders and each
 * placeholder runs cleanly against a real (empty) storage handle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { allVariants, runAllVariants } from "../src/retrieval/variants.ts";
import { initStorage, type StorageHandle } from "../src/storage/storage.ts";

test("variant registry: five placeholders, stable order", () => {
  const ids = allVariants().map((v) => v.id);
  assert.deepEqual(ids, [
    "fts5",
    "vector",
    "hybrid-rrf",
    "hybrid-rerank",
    "hybrid-entity-temporal",
  ]);
});

test("runAllVariants runs every variant against the same query", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-mcp-v2-retv-"));
  let handle: StorageHandle | null = null;
  try {
    handle = initStorage({ projectRoot: tmp });
    const results = await runAllVariants(handle, { text: "phase1" });
    assert.equal(results.length, 5);
    for (const r of results) {
      assert.equal(typeof r.elapsedMs, "number");
      assert.ok(r.elapsedMs >= 0);
      assert.deepEqual(r.hits, []);
    }
  } finally {
    if (handle) handle.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
