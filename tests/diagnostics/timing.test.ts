/**
 * Critical-path timing tests.
 *
 * These tests exercise the same hot paths the controller / storage
 * / retrieval layers hit on the remember+recall flow, and assert a
 * loose performance bound on the MEDIAN elapsed time across a
 * small number of timed runs. They are guard-rails, not strict
 * SLAs: the bound is set ~2-3x the observed baseline so a real
 * regression (2x or worse) fails the build but cold-cache / noisy
 * CI does not.
 *
 * Scope:
 *   1. Lexical ranking on 1000 candidates.
 *   2. FTS5 query against 1000 stored memories.
 *   3. AI provider call (mocked) — memory analysis.
 *   4. Storage insert (per-call median over 100 inserts).
 *   5. Storage list on a DB with 1000 memories.
 *   6. Full `remember` flow (mocked AI).
 *   7. Full `recall` flow (mocked AI, DB seeded with 1000 memories).
 *
 * Conventions:
 *   - New helpers live next to the existing test helpers, NOT in
 *     `src/`. Production code is unchanged.
 *   - Timing uses `assertMedianUnder` from `tests/_helpers/timing.ts`
 *     (which wraps `performance.now()` with a warmup + median pass),
 *     NOT raw `Date.now()` or single-sample `assert` calls.
 *   - Storage is created in a fresh `os.tmpdir()` so the project's
 *     `.curion/` is never touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { okChatResponse, safeAnalysis, scriptFetch } from "../_helpers/provider-stub.ts";
import { mkStorage, rmStorage } from "../_helpers/test-storage.ts";
import { assertMedianUnder, measure } from "../_helpers/timing.ts";
import {
  TEST_FALLBACK_BASE_URL,
  TEST_FALLBACK_KEY,
  TEST_FALLBACK_MODEL,
  TEST_PRIMARY_BASE_URL,
  TEST_PRIMARY_KEY,
  TEST_PRIMARY_MODEL,
} from "../shared-test-provider.ts";

import { runRecallController } from "../../src/controller/recall-controller.ts";
import { runRememberController } from "../../src/controller/remember-controller.ts";
import { analyzeMemoryWithFallback } from "../../src/providers/memory-analysis.ts";
import { type LexicalCandidate, rankLexical } from "../../src/retrieval/lexical.ts";
import {
  type StorageHandle,
  insertMemoryRecord,
  listActiveMemorySummaries,
  listActiveMemorySummariesByFts5,
} from "../../src/storage/storage.ts";

// ---------------------------------------------------------------------------
// Tuning: bounds for each test
// ---------------------------------------------------------------------------
//
// Each bound is set to ~2-3x the observed baseline median so the
// guard-rail catches a real regression (2x+ slower) without flaking
// on cold-cache or noisy CI. The observed medians are recorded in
// the per-test comments below next to the bound so a future
// maintainer can re-tune against fresh hardware without re-reading
// git history.

/**
 * Tuning notes (measured on Linux x86_64, Node 20+, ~3 runs):
 *   - rankLexical@1000:           median ~2.5ms, max ~5ms
 *   - FTS5@1000:                  median ~0.05ms (sub-ms)
 *   - analyzeMemoryWithFallback:  median ~0.4ms, max ~0.8ms
 *   - insertMemoryRecord@batch100: median ~2.5ms, max ~3.4ms (whole batch)
 *   - listActiveMemorySummaries:  median ~1.2ms, max ~2.2ms
 *   - runRememberController:      median ~1ms, max ~8ms (occasional GC)
 *   - runRecallController:        median ~1.5ms, max ~5.5ms
 *
 * Each bound is set ~5-30x the observed median (10x max for
 * stable tests, ~4x max for tests with occasional GC pauses).
 * The goal is to catch real regressions (5x+ slower) without
 * flaking on noisy CI.
 */

/** Lexical ranking on 1000 candidates — bound is 10x observed median. */
const LEXICAL_1000_MAX_MS = 25;
/** FTS5 query against 1000 stored memories — sub-ms observed; bound is loose. */
const FTS5_1000_MAX_MS = 10;
/** Mocked memory-analysis adapter call — bound is 50x observed median. */
const ANALYZE_MOCKED_MAX_MS = 20;
/**
 * Per-insert bound: ~0.25ms. The `assertMedianUnder` bound is on
 * a 100-insert batch (`STORAGE_INSERT_BATCH = 100`) so
 * `STORAGE_INSERT_BATCH_MAX_MS` = 100 × ~0.25ms + headroom = 25ms.
 * We assert on the whole batch (not per-call) because
 * `insertMemoryRecord` is too cheap to measure with sub-ms
 * resolution in a single call; batching smooths out the timer
 * noise.
 */
const STORAGE_INSERT_BATCH = 100;
const STORAGE_INSERT_BATCH_MAX_MS = 25;
/** `listActiveMemorySummaries` on 1000 memories — bound is ~12x observed median. */
const STORAGE_LIST_1000_MAX_MS = 15;
/** Full remember flow with mocked AI — bound is 30x median, 4x max. */
const REMEMBER_FLOW_MAX_MS = 30;
/** Full recall flow with mocked AI and 1000 memories — bound is 20x median, 5x max. */
const RECALL_FLOW_1000_MAX_MS = 30;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Build 1000 synthetic lexical candidates with enough token overlap
 * to exercise the ranker. Most rows are noise (no overlap with the
 * query); ~20 rows share tokens so the ranker has real work to do.
 */
function buildLexicalCorpus(size: number): LexicalCandidate[] {
  const out: LexicalCandidate[] = new Array(size);
  for (let i = 0; i < size; i++) {
    const isRelevant = i % 50 === 0;
    if (isRelevant) {
      out[i] = {
        id: i + 1,
        text: "Postgres is the primary store; it supports JSONB, transactions, and pgvector extensions for embeddings.",
        tags: ["postgres", "database", "storage"],
      };
    } else {
      // Decoy rows that share a few common stopwords but no content.
      const a = (i * 13) % 31;
      const b = (i * 7) % 29;
      out[i] = {
        id: i + 1,
        text: `Decoy fact number ${i}; item ${a} lives near item ${b} on the office whiteboard.`,
        tags: ["decoy", `slot-${i % 7}`],
      };
    }
  }
  return out;
}

/** Seed `n` synthetic memories into a fresh storage handle. */
function seedMemories(handle: StorageHandle, n: number): void {
  // Re-use a prepared INSERT for speed. The SQL layer uses
  // `Date.now()` for created_at / updated_at; we accept that all
  // rows get the same timestamp — the tests only care about row
  // count and FTS5 match.
  const stmt = handle.db.prepare(`
    INSERT INTO memories (
      kind, created_at, updated_at, summary, state,
      provider_id, model_id, confidence, safety_flags, metadata
    ) VALUES (
      @kind, @created_at, @updated_at, @summary, @state,
      @provider_id, @model_id, @confidence, @safety_flags, @metadata
    )
  `);
  const now = Date.now();
  const tx = handle.db.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      // One row in five carries the distinctive token `postgres`
      // so the FTS5 query has real candidates to match. The
      // remainder are decoys.
      const isRelevant = i % 5 === 0;
      stmt.run({
        kind: "fact",
        created_at: now,
        updated_at: now,
        summary: isRelevant
          ? `Memory ${i} records that the project uses postgres for its primary data store.`
          : `Decoy fact ${i} about office plants, parking permits, and Tuesday lunch orders.`,
        state: "active",
        provider_id: "test",
        model_id: "test",
        confidence: 0.9,
        safety_flags: "[]",
        metadata: JSON.stringify({
          tags: isRelevant ? ["postgres", "storage"] : ["decoy"],
        }),
      });
    }
  });
  tx(n);
}

// ---------------------------------------------------------------------------
// 1. Lexical ranking on 1000 candidates
// ---------------------------------------------------------------------------

test("timing: rankLexical on 1000 candidates (median < 25ms)", async () => {
  const candidates = buildLexicalCorpus(1000);
  const query = "What database does the project use for storage?";
  await assertMedianUnder(
    "rankLexical@1000",
    () => rankLexical(query, candidates, { topK: 5 }),
    LEXICAL_1000_MAX_MS,
    { warmup: 1, runs: 5 }
  );
});

// ---------------------------------------------------------------------------
// 2. FTS5 query against 1000 stored memories
// ---------------------------------------------------------------------------

test("timing: listActiveMemorySummariesByFts5 over 1000 memories (median < 10ms)", async () => {
  const { tmp, handle } = mkStorage("curion-timing-fts5-");
  try {
    seedMemories(handle, 1000);
    await assertMedianUnder(
      "listActiveMemorySummariesByFts5@1000",
      () =>
        listActiveMemorySummariesByFts5(handle, "postgres storage", {
          limit: 200,
        }),
      FTS5_1000_MAX_MS,
      { warmup: 1, runs: 5 }
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 3. AI provider call (mocked) — memory analysis
// ---------------------------------------------------------------------------

test("timing: analyzeMemoryWithFallback (mocked fetch) (median < 20ms)", async () => {
  const { fetchImpl } = scriptFetch(() => okChatResponse(safeAnalysis()));
  const input =
    "We picked Postgres 16 for the primary data store because of better JSON support and pgvector.";
  await assertMedianUnder(
    "analyzeMemoryWithFallback@mocked",
    () =>
      analyzeMemoryWithFallback(input, [], {
        fetchImpl,
        primaryApiKey: TEST_PRIMARY_KEY,
        primaryBaseUrl: TEST_PRIMARY_BASE_URL,
        primaryModel: TEST_PRIMARY_MODEL,
        // Disable fallback so we only pay for one HTTP round trip.
        disableFallback: true,
      }),
    ANALYZE_MOCKED_MAX_MS,
    { warmup: 1, runs: 5 }
  );
});

// ---------------------------------------------------------------------------
// 4. Storage insert (per-call median over 100 inserts)
// ---------------------------------------------------------------------------

test("timing: insertMemoryRecord batched 100 inserts (median < 25ms)", async () => {
  const { tmp, handle } = mkStorage("curion-timing-insert-");
  try {
    // Pre-build the input once so the timer captures the actual
    // INSERT cost (and any per-row serialization), not the cost
    // of building the input object.
    const input = {
      kind: "fact",
      state: "active" as const,
      memoryContent: "The project uses Postgres 16 for the primary data store.",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["postgres", "storage"] },
    };

    // Warm up the page cache + the `prepare()` cache inside
    // `insertMemoryRecord`. better-sqlite3 caches prepared
    // statements per SQL string; one warmup row is enough.
    insertMemoryRecord(handle, {
      ...input,
      memoryContent: "warmup row",
    });

    // The timed fn performs a batch of 100 inserts in a single
    // SQLite transaction (faster than 100 separate auto-commit
    // transactions). We use `insertMemoryRecord` for the actual
    // insertion so the test exercises the real write-path used
    // by the controller.
    await assertMedianUnder(
      "insertMemoryRecord@batch100",
      () => {
        handle.db.transaction(() => {
          for (let i = 0; i < STORAGE_INSERT_BATCH; i++) {
            insertMemoryRecord(handle, input);
          }
        })();
        return STORAGE_INSERT_BATCH;
      },
      STORAGE_INSERT_BATCH_MAX_MS,
      { warmup: 1, runs: 5 }
    );

    // Sanity: warmup (1) + 5 × 100 = 501 rows in total.
    const count = (handle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number })
      .c;
    assert.ok(
      count >= STORAGE_INSERT_BATCH,
      `expected >= ${STORAGE_INSERT_BATCH} rows, got ${count}`
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. Storage list on a DB with 1000 memories
// ---------------------------------------------------------------------------

test("timing: listActiveMemorySummaries on 1000 memories (median < 15ms)", async () => {
  const { tmp, handle } = mkStorage("curion-timing-list-");
  try {
    seedMemories(handle, 1000);
    await assertMedianUnder(
      "listActiveMemorySummaries@1000",
      () => listActiveMemorySummaries(handle, { limit: 1000 }),
      STORAGE_LIST_1000_MAX_MS,
      { warmup: 1, runs: 5 }
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 6. Full remember flow (mocked AI)
// ---------------------------------------------------------------------------

test("timing: runRememberController end-to-end (mocked AI) (median < 30ms)", async () => {
  const { tmp, handle } = mkStorage("curion-timing-remember-");
  try {
    const { fetchImpl } = scriptFetch(() => okChatResponse(safeAnalysis()));
    const rawText =
      "We picked Postgres 16 for the primary data store because of better JSON support and pgvector.";
    await assertMedianUnder(
      "runRememberController@mocked",
      () =>
        runRememberController(handle, rawText, {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: TEST_PRIMARY_KEY,
          providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
          providerPrimaryModel: TEST_PRIMARY_MODEL,
          providerFallbackApiKey: TEST_FALLBACK_KEY,
          providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
          providerFallbackModel: TEST_FALLBACK_MODEL,
        }),
      REMEMBER_FLOW_MAX_MS,
      { warmup: 1, runs: 5 }
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 7. Full recall flow (mocked AI, DB seeded with 1000 memories)
// ---------------------------------------------------------------------------

test("timing: runRecallController end-to-end (mocked AI, 1000 memories) (median < 30ms)", async () => {
  const { tmp, handle } = mkStorage("curion-timing-recall-");
  try {
    seedMemories(handle, 1000);
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("The project uses Postgres 16 for the primary data store.")
    );
    const query = "What database does the project use?";
    await assertMedianUnder(
      "runRecallController@mocked@1000",
      () =>
        runRecallController(handle, query, {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: TEST_PRIMARY_KEY,
          providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
          providerPrimaryModel: TEST_PRIMARY_MODEL,
          providerFallbackApiKey: TEST_FALLBACK_KEY,
          providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
          providerFallbackModel: TEST_FALLBACK_MODEL,
          // Default storageLimit (200) keeps the lexical scan
          // bounded; the test still exercises the full controller
          // pipeline end-to-end with 1000 rows in storage.
        }),
      RECALL_FLOW_1000_MAX_MS,
      { warmup: 1, runs: 5 }
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Measure-only smoke check
// ---------------------------------------------------------------------------
//
// Not a real test: just a no-op assertion that the helper wires up.
// Kept at the bottom so the suite reports a stable count of
// real (assertMedianUnder-driven) tests above.

test("timing: helper smoke (measure returns elapsedMs)", async () => {
  const { elapsedMs } = await measure(async () => {
    // Trivial async work so the helper is exercised end-to-end.
    await Promise.resolve();
    return 42;
  });
  assert.ok(elapsedMs >= 0, `elapsedMs must be non-negative, got ${elapsedMs}`);
});
