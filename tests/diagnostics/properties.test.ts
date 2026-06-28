/**
 * Property-based tests (fast-check).
 *
 * Hand-written tests cover the happy paths and a small set of
 * hand-picked edge cases. Property tests sweep the input space
 * cheaply: each property is asserted on 30-100 random inputs
 * generated from a fast-check `Arbitrary`, with a fixed seed per
 * test so failures are reproducible.
 *
 * Conventions:
 *   - Production code is unchanged. Only test code is added.
 *   - Each property uses `fc.assert(fc.property(...), { numRuns, seed })`.
 *   - A different `seed` is used per test so a failure in one
 *     property does not shift the input space of the next.
 *   - Storage-using properties share a single handle across all
 *     property runs and only teardown at the end. This keeps the
 *     test runtime bounded (no per-iteration DB creation) while
 *     still verifying the per-iteration invariant.
 *   - Heavy properties (FTS5 round-trip, insert/list round-trip,
 *     storage cleanup) use `numRuns: 30` rather than 100 so the
 *     suite stays inside the existing test budget. Pure / fast
 *     properties use `numRuns: 100`.
 *
 * Properties covered (the 8 most valuable from the dispatch brief):
 *   1. tokenize idempotency           (lexical)
 *   2. rankLexical sort + topK cap    (lexical)
 *   3. FTS5 round-trip                (storage)
 *   4. insert / list round-trip       (storage)
 *   5. REMEMBER_INPUT_SCHEMA strict   (zod)
 *   6. RECALL_INPUT_SCHEMA strict     (zod)
 *   7. mkStorage cleanup invariant    (test-helper)
 *   8. cosineSimilarity bounds        (semantic score)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import fc from "fast-check";

import { mkStorage, rmStorage } from "../_helpers/test-storage.ts";

import { type LexicalCandidate, rankLexical, tokenize } from "../../src/retrieval/lexical.ts";
import { cosineSimilarity } from "../../src/retrieval/semantic/score.ts";
import {
  type MemoryRecordInput,
  insertMemoryRecord,
  listActiveMemorySummaries,
  listActiveMemorySummariesByFts5,
} from "../../src/storage/storage.ts";
import { RECALL_INPUT_SCHEMA } from "../../src/tools/recall.ts";
import { REMEMBER_INPUT_SCHEMA } from "../../src/tools/remember.ts";

// ---------------------------------------------------------------------------
// Local arbitraries
// ---------------------------------------------------------------------------

/** Build a valid `MemoryRecordInput` for a given memory content. */
function makeMemoryInput(memoryContent: string): MemoryRecordInput {
  return {
    kind: "fact",
    state: "active",
    memoryContent,
    providerId: "test",
    modelId: "test",
    confidence: 0.9,
    safetyFlags: [],
    metadata: { tags: ["prop-test"] },
  };
}

/**
 * A `LexicalCandidate` arbitrary. `id` is a non-negative integer
 * (matches the controller's auto-increment ids). `text` is any
 * short string. `tags` is an optional list of short strings.
 *
 * Bounded at maxLength ~200 to keep `rankLexical` work per run
 * sub-millisecond.
 */
const lexicalCandidateArb: fc.Arbitrary<LexicalCandidate> = fc.record({
  id: fc.integer({ min: 0, max: 100_000 }),
  text: fc.string({ minLength: 0, maxLength: 200 }),
  tags: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }), {
    nil: undefined,
  }),
});

/**
 * A query arbitrary with at least one content word (>=3 chars,
 * not in the stopword set, not pure digits). The lexical ranker
 * returns `[]` when the query tokenizes to zero tokens; we want
 * to exercise the sort path, not the empty-input branch, so we
 * guarantee a non-empty tokenized query.
 */
const queryWithContentWordArb = fc.string({ minLength: 5, maxLength: 80 }).filter((s) => {
  const tokens = tokenize(s);
  return tokens.length > 0;
});

/**
 * A `topK` arbitrary. Range [1, 20] keeps results small enough
 * to assert on cheaply.
 */
const topKArb = fc.integer({ min: 1, max: 20 });

/**
 * A random vector (L2-normalized). Used by the cosine bounds
 * property: `cosineSimilarity(a, a)` is exactly 1 only when
 * `||a|| = 1`, so we normalize here.
 *
 * Drawn as `fc.array(fc.float({ min: -1, max: 1, noNaN: true }),
 * { minLength: 1, maxLength: 32 })` then unit-normalized via
 * `||v|| = sqrt(sum(v_i^2))`. We retry when the vector happens
 * to be the zero vector (degenerate norm).
 */
const unitVectorArb = fc
  .array(fc.float({ min: -1, max: 1, noNaN: true }), {
    minLength: 1,
    maxLength: 32,
  })
  .filter((v) => {
    // Skip the zero vector — its norm is 0 and it cannot be
    // normalized into a unit vector.
    let sq = 0;
    for (const x of v) sq += x * x;
    return sq > 1e-12;
  })
  .map((v) => {
    let sq = 0;
    for (const x of v) sq += x * x;
    const norm = Math.sqrt(sq);
    return v.map((x) => x / norm);
  });

// ---------------------------------------------------------------------------
// 1. tokenize idempotency
// ---------------------------------------------------------------------------
//
// `tokenize` is a pure function: calling it twice with the same
// input must produce two deeply-equal arrays. This guards against
// accidental state-leak (caches, counters) inside the tokenizer
// that would manifest only under repeated calls. Reference
// equality (`===`) is too strict — `tokenize` allocates a fresh
// array each call — so we use `assert.deepEqual`.

test("property: tokenize is deterministic across repeated calls", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const a = tokenize(s);
      const b = tokenize(s);
      assert.deepEqual(
        a,
        b,
        `tokenize must be deterministic; got ${JSON.stringify(a)} then ${JSON.stringify(b)}`
      );
      // Belt-and-braces: array shape is stable too.
      assert.equal(Array.isArray(a), true, "tokenize must always return an array");
    }),
    { numRuns: 100, seed: 42 }
  );
});

// ---------------------------------------------------------------------------
// 2. rankLexical sort + topK cap
// ---------------------------------------------------------------------------
//
// `rankLexical` returns at most `topK` candidates, sorted by score
// descending. Ties on score are broken by descending id (the
// d167c1f rule). We assert:
//   (a) `result.length <= topK`,
//   (b) consecutive pairs are non-increasing on score,
//   (c) on equal score, consecutive pairs are non-increasing on id.
//
// Empty results satisfy the property vacuously (no pair to check).

test("property: rankLexical returns sorted-by-score-desc, topK-capped candidates", () => {
  fc.assert(
    fc.property(
      queryWithContentWordArb,
      fc.array(lexicalCandidateArb, { minLength: 0, maxLength: 50 }),
      topKArb,
      (query, candidates, topK) => {
        const result = rankLexical(query, candidates, { topK });
        // (a) topK cap.
        assert.ok(
          result.length <= topK,
          `result.length (${result.length}) must be <= topK (${topK})`
        );
        // (b) + (c) sort invariants.
        for (let i = 1; i < result.length; i++) {
          const prev = result[i - 1]!;
          const curr = result[i]!;
          assert.ok(
            prev.score >= curr.score,
            `score non-increasing violated at ${i}: ${prev.score} < ${curr.score}`
          );
          if (prev.score === curr.score) {
            assert.ok(
              prev.id >= curr.id,
              `tie-break violated at ${i}: score=${prev.score}, ids ${prev.id} then ${curr.id} (must be id desc)`
            );
          }
        }
      }
    ),
    { numRuns: 100, seed: 43 }
  );
});

// ---------------------------------------------------------------------------
// 3. FTS5 round-trip
// ---------------------------------------------------------------------------
//
// Insert a memory with a randomly-generated body and a fixed
// distinctive token (`propfts5`). Query for that token. The
// round-trip property is: the inserted row is in the result.
//
// We share a single DB handle across all 30 property runs to
// keep the test fast (no per-iteration DB creation). Each run
// inserts a fresh row, so the FTS5 index grows monotonically
// and the property still holds (the query returns >= 1 hit
// including the just-inserted row).
//
// The `propfts5` token is a deliberately non-content word
// (>=3 chars, not in the stopword set, not pure digits, not an
// FTS5 operator) so it survives `cleanFts5Query` and matches
// the inserted row exactly.

test("property: FTS5 round-trip — inserted memory is findable by query", () => {
  const { tmp, handle } = mkStorage("curion-prop-fts5-");
  try {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (noise) => {
        // Build a body that includes the distinctive token so
        // the FTS5 index has a reliable hit. The body must
        // be non-empty and the noise is wrapped in punctuation
        // so the tokenizer does not collapse the distinctive
        // token into the noise.
        const memoryContent = `${noise} propfts5curion`;
        const inserted = insertMemoryRecord(handle, makeMemoryInput(memoryContent));
        const hits = listActiveMemorySummariesByFts5(handle, "propfts5curion", {
          limit: 1000,
        });
        assert.ok(
          hits.some((r) => r.id === inserted.id && r.memoryContent === memoryContent),
          `expected FTS5 to return the inserted memory id=${inserted.id}, got ${hits.length} hits`
        );
      }),
      { numRuns: 30, seed: 44 }
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. insert / list round-trip
// ---------------------------------------------------------------------------
//
// Insert a memory with arbitrary content. List active memories.
// The inserted row must appear in the list with matching id and
// content.
//
// Same shared-handle strategy as the FTS5 test. List default
// limit is 200, well above the 30-row budget here.

test("property: insertMemoryRecord + listActiveMemorySummaries round-trip", () => {
  const { tmp, handle } = mkStorage("curion-prop-insert-");
  try {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (memoryContent) => {
        const inserted = insertMemoryRecord(handle, makeMemoryInput(memoryContent));
        const list = listActiveMemorySummaries(handle, {
          limit: 1000,
          orderBy: "asc",
        });
        const found = list.find((r) => r.id === inserted.id);
        assert.ok(
          found,
          `inserted memory id=${inserted.id} must appear in listActiveMemorySummaries`
        );
        assert.equal(found!.memoryContent, memoryContent, `memory content must round-trip exactly`);
      }),
      { numRuns: 30, seed: 45 }
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. REMEMBER_INPUT_SCHEMA: accept / reject (strict mode)
// ---------------------------------------------------------------------------
//
// The schema is `.strict()` and requires `text: string (min 1)`.
// Valid:  { text: "..." } with non-empty string.
// Unknown-key: { text: "...", extra: 1 } must be rejected.
// Missing-key: {} must be rejected (no `text`).
// Empty-text: { text: "" } must be rejected (min length 1).

test("property: REMEMBER_INPUT_SCHEMA accepts valid, rejects unknown and missing", () => {
  // Accept: random non-empty string.
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 100 }), (text) => {
      const r = REMEMBER_INPUT_SCHEMA.safeParse({ text });
      assert.equal(r.success, true, `valid input { text: ${JSON.stringify(text)} } must parse`);
    }),
    { numRuns: 100, seed: 46 }
  );

  // Unknown top-level key must be rejected (strict mode).
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 20 }),
      (text, extra) => {
        const r = REMEMBER_INPUT_SCHEMA.safeParse({ text, [extra]: 1 });
        assert.equal(
          r.success,
          false,
          `strict schema must reject unknown key ${JSON.stringify(extra)}`
        );
      }
    ),
    { numRuns: 50, seed: 47 }
  );

  // Missing `text` must be rejected.
  assert.equal(REMEMBER_INPUT_SCHEMA.safeParse({}).success, false, "empty object must be rejected");
  // Empty `text` must be rejected (min length 1).
  assert.equal(
    REMEMBER_INPUT_SCHEMA.safeParse({ text: "" }).success,
    false,
    "empty text must be rejected (min length 1)"
  );
  // Wrong type for `text` must be rejected.
  assert.equal(
    REMEMBER_INPUT_SCHEMA.safeParse({ text: 42 }).success,
    false,
    "non-string text must be rejected"
  );
});

// ---------------------------------------------------------------------------
// 6. RECALL_INPUT_SCHEMA: accept / reject (strict mode)
// ---------------------------------------------------------------------------
//
// Same shape as REMEMBER_INPUT_SCHEMA: `text: string (min 1)`,
// `.strict()`.

test("property: RECALL_INPUT_SCHEMA accepts valid, rejects unknown and missing", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 100 }), (text) => {
      const r = RECALL_INPUT_SCHEMA.safeParse({ text });
      assert.equal(r.success, true, `valid input { text: ${JSON.stringify(text)} } must parse`);
    }),
    { numRuns: 100, seed: 48 }
  );

  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 20 }),
      (text, extra) => {
        const r = RECALL_INPUT_SCHEMA.safeParse({ text, [extra]: 1 });
        assert.equal(
          r.success,
          false,
          `strict schema must reject unknown key ${JSON.stringify(extra)}`
        );
      }
    ),
    { numRuns: 50, seed: 49 }
  );

  assert.equal(RECALL_INPUT_SCHEMA.safeParse({}).success, false, "empty object must be rejected");
  assert.equal(
    RECALL_INPUT_SCHEMA.safeParse({ text: "" }).success,
    false,
    "empty text must be rejected (min length 1)"
  );
  assert.equal(
    RECALL_INPUT_SCHEMA.safeParse({ text: 42 }).success,
    false,
    "non-string text must be rejected"
  );
});

// ---------------------------------------------------------------------------
// 7. mkStorage cleanup invariant
// ---------------------------------------------------------------------------
//
// `mkStorage(prefix)` creates a directory under `os.tmpdir()`.
// `rmStorage(tmp, handle)` closes the DB and recursively removes
// the directory. The invariant: after `rmStorage`, the temp
// directory MUST be gone (`fs.existsSync(tmp) === false`).
//
// We use a randomized prefix so each run lands in a unique
// directory and a flake in `rmStorage` cannot be masked by a
// previous run's leftovers.

test("property: mkStorage cleanup leaves no leftover directory", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s)),
      (suffix) => {
        const prefix = `curion-prop-cleanup-${suffix}-`;
        const { tmp, handle } = mkStorage(prefix);
        // Sanity: the directory exists right after creation.
        assert.equal(fs.existsSync(tmp), true, `mkStorage must create ${tmp}`);
        rmStorage(tmp, handle);
        assert.equal(fs.existsSync(tmp), false, `rmStorage must remove ${tmp}`);
      }
    ),
    { numRuns: 30, seed: 50 }
  );
});

// ---------------------------------------------------------------------------
// 8. cosineSimilarity bounds (semantic)
// ---------------------------------------------------------------------------
//
// `cosineSimilarity(a, b)` returns the dot product of `a` and
// `b`. Per the module docstring, callers are expected to pass
// L2-normalized vectors so the dot product equals cosine
// similarity. The properties:
//
//   (a) `cosineSimilarity(a, a) === 1` for any non-zero vector
//       `a` (when `a` is L2-normalized to length 1).
//   (b) Symmetry: `cosineSimilarity(a, b) === cosineSimilarity(b, a)`
//       for any pair (regardless of normalization).
//
// Tolerance (a): float dot product of a unit vector with itself
// is `sum(a_i^2)` which is exactly 1 by construction, but
// IEEE-754 rounding in the array map can drift slightly. We
// allow a 1e-9 epsilon.

test("property: cosineSimilarity(a, a) ≈ 1 for L2-normalized a", () => {
  fc.assert(
    fc.property(unitVectorArb, (a) => {
      const s = cosineSimilarity(a, a);
      assert.ok(Math.abs(s - 1) < 1e-9, `cosineSimilarity(a, a) must be 1 within 1e-9, got ${s}`);
    }),
    { numRuns: 100, seed: 51 }
  );
});

test("property: cosineSimilarity is symmetric", () => {
  fc.assert(
    fc.property(unitVectorArb, unitVectorArb, (a, b) => {
      const ab = cosineSimilarity(a, b);
      const ba = cosineSimilarity(b, a);
      // Symmetry is exact (dot product is commutative), so
      // strict equality holds within float precision.
      assert.ok(
        Math.abs(ab - ba) < 1e-12,
        `cosineSimilarity must be symmetric: a·b=${ab}, b·a=${ba}`
      );
      // Range: with both vectors on the unit sphere, the dot
      // product (== cosine) is in [-1, 1].
      assert.ok(
        ab >= -1 - 1e-9 && ab <= 1 + 1e-9,
        `cosineSimilarity on unit vectors must be in [-1, 1], got ${ab}`
      );
    }),
    { numRuns: 100, seed: 52 }
  );
});
