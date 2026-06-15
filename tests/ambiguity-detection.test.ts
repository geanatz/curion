/**
 * Unit tests for the Phase C ambiguity detector.
 *
 * Scope: the pure helper in `src/retrieval/ambiguity.ts`.
 * No storage, no provider, no controller, no benchmark
 * runner, no raw input fields. The tests verify:
 *
 *   1. Single candidate -> `{ kind: "none" }` (the detector
 *      is pairwise; a single row cannot be in conflict with
 *      itself).
 *   2. No relationship block, no opposing claims ->
 *      `{ kind: "none" }`.
 *   3. Two candidates with mutual `conflictsWith` in stored
 *      metadata + high `detectionConfidence` -> ambiguous
 *      `conflicting-candidates` signal with bounded ids and
 *      confidence.
 *   4. Below-confidence stored `conflictsWith` -> silent.
 *   5. Two candidates with mutual `olderVariantsOf` in
 *      stored metadata + high confidence -> ambiguous
 *      `older-variant-suspected` signal.
 *   6. Below-confidence stored `olderVariantsOf` -> silent.
 *   7. Asymmetric negation between two top candidates +
 *      answer alignment with the non-negating side ->
 *      ambiguous `conflicting-candidates` signal (the
 *      lexical / safety-net rule for missing/stored blocks).
 *   8. Asymmetric negation without answer alignment -> silent.
 *   9. Determinism: same input + same `asOf` -> byte-equal
 *      output.
 *  10. `asOf` defaults to 0 when omitted (no clock read).
 *  11. Bounded output: `memoryIds` length <= MAX_AMBIGUITY_IDS.
 *  12. No mutation of inputs.
 *  13. No raw-input / raw-text reference in the output.
 *  14. The detector does not import benchmark experiment
 *      modules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import {
  detectAmbiguity,
  AMBIGUITY_CONFIDENCE_THRESHOLD,
  MAX_AMBIGUITY_IDS,
  type SafeMemorySummaryWithRelationship,
} from "../src/retrieval/ambiguity.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function mkCandidate(
  overrides: Partial<SafeMemorySummaryWithRelationship> = {},
): SafeMemorySummaryWithRelationship {
  const id = overrides.id ?? nextId++;
  return {
    id,
    kind: "finding",
    state: "active",
    summary: "default summary",
    tags: [],
    classification: null,
    confidence: 0.9,
    ...overrides,
  };
}

/** Deep clone a fixture so test mutations do not leak. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// 1. Single candidate -> none
// ---------------------------------------------------------------------------

test("detectAmbiguity: single candidate -> kind: 'none'", () => {
  const a = mkCandidate({
    id: 1,
    summary: "we use Postgres for storage",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [2],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  });
  const out = detectAmbiguity({
    topCandidates: [a],
    answer: "Postgres.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 2. No relationship, no opposing claims -> none
// ---------------------------------------------------------------------------

test("detectAmbiguity: two unrelated candidates with no stored block -> none", () => {
  const a = mkCandidate({ id: 1, summary: "we use Postgres for storage" });
  const b = mkCandidate({ id: 2, summary: "the team drinks earl grey tea" });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "Postgres is the primary store.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 3. Stored mutual conflictsWith above threshold -> ambiguous
// ---------------------------------------------------------------------------

test("detectAmbiguity: stored mutual conflictsWith above threshold -> conflicting-candidates", () => {
  // Both rows point at each other in `conflictsWith` and
  // carry a `detectionConfidence` well above τ. The
  // synthesized answer matches only one side. The detector
  // must emit a `conflicting-candidates` signal with both
  // ids and a confidence bounded to the lower of the two
  // stored values.
  const a = mkCandidate({
    id: 10,
    summary: "we use Postgres for this service",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [11],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  });
  const b = mkCandidate({
    id: 11,
    summary: "we use Postgres for this service in production",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [10],
      olderVariantsOf: [],
      detectionConfidence: 0.92,
    },
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "Postgres is the primary store.",
    asOf: 1,
  });
  assert.equal(out.kind, "ambiguous");
  if (out.kind !== "ambiguous") throw new Error("unreachable");
  assert.equal(out.reason, "conflicting-candidates");
  // ids are sorted ascending.
  assert.deepEqual(out.memoryIds, [10, 11]);
  // The point estimate is min(0.95, 0.92) = 0.92.
  assert.ok(
    out.confidence >= AMBIGUITY_CONFIDENCE_THRESHOLD,
    `expected confidence >= ${AMBIGUITY_CONFIDENCE_THRESHOLD}, got ${out.confidence}`,
  );
  assert.ok(out.confidence <= 1, "confidence bounded to [0, 1]");
});

// ---------------------------------------------------------------------------
// 4. Stored mutual conflictsWith below threshold -> silent
// ---------------------------------------------------------------------------

test("detectAmbiguity: stored mutual conflictsWith below threshold -> none", () => {
  // The structural pointer is mutual but both rows carry a
  // low `detectionConfidence` (below τ). The detector stays
  // silent — the stored block is too weak to claim
  // opposition.
  const a = mkCandidate({
    id: 20,
    summary: "we use Postgres for this service",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [21],
      olderVariantsOf: [],
      detectionConfidence: 0.5,
    },
  });
  const b = mkCandidate({
    id: 21,
    summary: "we use Postgres for this service in production",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [20],
      olderVariantsOf: [],
      detectionConfidence: 0.4,
    },
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "Postgres.",
    asOf: 1,
  });
  // The min(0.5, 0.4) = 0.4 is below τ. The lexical
  // safety-net rule may still fire here (asymmetric
  // negation? no, neither side negates). The detector stays
  // silent.
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 5. Stored mutual olderVariantsOf above threshold -> older-variant
// ---------------------------------------------------------------------------

test("detectAmbiguity: stored mutual olderVariantsOf above threshold -> older-variant-suspected", () => {
  const a = mkCandidate({
    id: 30,
    summary: "Postgres stores project data reliably since 2023",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [],
      olderVariantsOf: [31],
      detectionConfidence: 0.95,
    },
  });
  const b = mkCandidate({
    id: 31,
    summary: "Postgres stores project data reliably",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [],
      olderVariantsOf: [30],
      detectionConfidence: 0.93,
    },
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "Postgres is the primary store.",
    asOf: 1,
  });
  assert.equal(out.kind, "ambiguous");
  if (out.kind !== "ambiguous") throw new Error("unreachable");
  assert.equal(out.reason, "older-variant-suspected");
  assert.deepEqual(out.memoryIds, [30, 31]);
  assert.ok(
    out.confidence >= AMBIGUITY_CONFIDENCE_THRESHOLD,
    `expected confidence >= ${AMBIGUITY_CONFIDENCE_THRESHOLD}, got ${out.confidence}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Stored mutual olderVariantsOf below threshold -> silent
// ---------------------------------------------------------------------------

test("detectAmbiguity: stored mutual olderVariantsOf below threshold -> none", () => {
  const a = mkCandidate({
    id: 40,
    summary: "Postgres stores project data reliably since 2023",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [],
      olderVariantsOf: [41],
      detectionConfidence: 0.5,
    },
  });
  const b = mkCandidate({
    id: 41,
    summary: "Postgres stores project data reliably",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [],
      olderVariantsOf: [40],
      detectionConfidence: 0.5,
    },
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "Postgres.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 7. Asymmetric negation + answer alignment (lexical safety-net)
// ---------------------------------------------------------------------------

test("detectAmbiguity: asymmetric negation + answer alignment -> conflicting-candidates", () => {
  // No stored `relationship` block. The detector must
  // still fire when the lexical evidence is strong: the
  // candidate pair shares high overlap, exactly one side
  // negates, and the synthesized answer contains a content
  // token from the *non-negating* side.
  const a = mkCandidate({
    id: 50,
    summary: "we do not use Postgres for this service",
  });
  const b = mkCandidate({
    id: 51,
    summary: "we use Postgres for this service",
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "The team uses Postgres for the service.",
    asOf: 1,
  });
  assert.equal(out.kind, "ambiguous");
  if (out.kind !== "ambiguous") throw new Error("unreachable");
  assert.equal(out.reason, "conflicting-candidates");
  assert.deepEqual(out.memoryIds, [50, 51]);
  assert.ok(
    out.confidence >= AMBIGUITY_CONFIDENCE_THRESHOLD,
    `expected confidence >= ${AMBIGUITY_CONFIDENCE_THRESHOLD}, got ${out.confidence}`,
  );
  assert.ok(out.confidence <= 1);
});

// ---------------------------------------------------------------------------
// 8. Asymmetric negation without answer alignment -> silent
// ---------------------------------------------------------------------------

test("detectAmbiguity: asymmetric negation without answer alignment -> none", () => {
  // The two summaries are an opposing pair, but the
  // synthesized answer does not align with either side (it
  // is a generic statement that contains no content token
  // from the non-negating side). The detector must stay
  // silent: we cannot claim the model took a side.
  const a = mkCandidate({
    id: 60,
    summary: "we do not use Postgres for this service",
  });
  const b = mkCandidate({
    id: 61,
    summary: "we use Postgres for this service",
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "The kitchen dishwasher runs nightly at 11pm.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 9. Determinism: same input + same asOf -> byte-equal output
// ---------------------------------------------------------------------------

test("detectAmbiguity: deterministic for fixed (topCandidates, answer, asOf)", () => {
  const a = mkCandidate({
    id: 70,
    summary: "we do not use Postgres for this service",
  });
  const b = mkCandidate({
    id: 71,
    summary: "we use Postgres for this service",
  });
  const candidates = clone([a, b]);
  const out1 = detectAmbiguity({
    topCandidates: candidates,
    answer: "The team uses Postgres for the service.",
    asOf: 1_700_000_000_000,
  });
  const out2 = detectAmbiguity({
    topCandidates: clone([a, b]),
    answer: "The team uses Postgres for the service.",
    asOf: 1_700_000_000_000,
  });
  assert.deepEqual(out1, out2);
});

// ---------------------------------------------------------------------------
// 10. asOf defaults to 0 (no clock read)
// ---------------------------------------------------------------------------

test("detectAmbiguity: omitted asOf -> asOf in result defaults to 0 (no clock read)", () => {
  const a = mkCandidate({
    id: 80,
    summary: "we use Postgres for storage",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [81],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  });
  const b = mkCandidate({
    id: 81,
    summary: "we use Postgres for storage in production",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [80],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  });
  const out = detectAmbiguity({ topCandidates: [a, b], answer: "Postgres." });
  assert.equal(out.asOf, 0);
});

test("detectAmbiguity: NaN / non-finite asOf is clamped to 0", () => {
  const a = mkCandidate({ id: 90, summary: "x" });
  const b = mkCandidate({ id: 91, summary: "y" });
  const outNaN = detectAmbiguity({
    topCandidates: [a, b],
    answer: "x",
    asOf: Number.NaN,
  });
  const outInf = detectAmbiguity({
    topCandidates: [a, b],
    answer: "x",
    asOf: Number.POSITIVE_INFINITY,
  });
  assert.equal(outNaN.asOf, 0);
  assert.equal(outInf.asOf, 0);
});

// ---------------------------------------------------------------------------
// 11. Bounded output: memoryIds length <= MAX_AMBIGUITY_IDS
// ---------------------------------------------------------------------------

test("detectAmbiguity: emitted memoryIds array is bounded to MAX_AMBIGUITY_IDS", () => {
  // Build a candidate set with one self-conflicting row
  // that points at many ids (some out of range, some in
  // range). The detector must clamp to MAX_AMBIGUITY_IDS
  // and drop non-finite ids.
  const a = mkCandidate({
    id: 100,
    summary: "we use Postgres",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [101, 102, 103, 104, 105, 106, 107, 108],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  });
  // The detector needs a *mutual* pointer. We mark the
  // first three candidates as pointing back at `a`.
  const others: SafeMemorySummaryWithRelationship[] = [
    101, 102, 103, 104, 105, 106, 107, 108,
  ].map((id) =>
    mkCandidate({
      id,
      summary: "we use Postgres",
      relationship: {
        derivedSchemaVersion: "ccm-draft-1",
        derivedAt: 0,
        conflictsWith: id <= 103 ? [100] : [],
        olderVariantsOf: [],
        detectionConfidence: id <= 103 ? 0.95 : 0,
      },
    }),
  );
  const out = detectAmbiguity({
    topCandidates: [a, ...others],
    answer: "Postgres.",
    asOf: 1,
  });
  // The detector finds the first mutual pair (a, 101) and
  // returns it. Bounded output is at most MAX_AMBIGUITY_IDS.
  if (out.kind === "ambiguous") {
    assert.ok(out.memoryIds.length <= MAX_AMBIGUITY_IDS);
    for (const id of out.memoryIds) {
      assert.equal(typeof id, "number");
      assert.ok(Number.isFinite(id) && id > 0);
    }
  } else {
    // If the detector chose the lexical path (no stored
    // block) instead, it must also be silent or bounded.
    assert.equal(out.kind, "none");
  }
});

// ---------------------------------------------------------------------------
// 12. No mutation of inputs
// ---------------------------------------------------------------------------

test("detectAmbiguity: does not mutate inputs", () => {
  const a = mkCandidate({
    id: 200,
    summary: "we do not use Postgres for this service",
  });
  const b = mkCandidate({
    id: 201,
    summary: "we use Postgres for this service",
  });
  const snapA = JSON.parse(JSON.stringify(a)) as unknown;
  const snapB = JSON.parse(JSON.stringify(b)) as unknown;
  detectAmbiguity({
    topCandidates: [a, b],
    answer: "The team uses Postgres for the service.",
    asOf: 1,
  });
  assert.deepEqual(a, snapA);
  assert.deepEqual(b, snapB);
});

// ---------------------------------------------------------------------------
// 13. No raw-input / raw-text reference in output
// ---------------------------------------------------------------------------

test("detectAmbiguity: output never references raw text", () => {
  const a = mkCandidate({
    id: 300,
    summary: "we do not use Postgres for this service",
  });
  const b = mkCandidate({
    id: 301,
    summary: "we use Postgres for this service",
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "The team uses Postgres for the service.",
    asOf: 1,
  });
  const json = JSON.stringify(out);
  // The detector must never carry a `raw` / `text` / `input`
  // / `query` field on the signal.
  for (const forbidden of [
    "raw",
    "text",
    "input",
    "query",
    "answer",
  ]) {
    // `answer` is the call argument; the detector must not
    // echo its content. We check that the raw `answer`
    // string is not in the serialized output.
    if (forbidden === "answer") {
      assert.ok(
        !json.includes("The team uses Postgres"),
        `signal must not include the synthesized answer text`,
      );
    } else {
      assert.equal(
        (out as unknown as Record<string, unknown>)[forbidden],
        undefined,
        `signal must not include a '${forbidden}' field`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 14. The detector does not import benchmark experiment modules
// ---------------------------------------------------------------------------

test("ambiguity detector: does not import benchmark experiment modules", async () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const srcPath = path.resolve(here, "../src/retrieval/ambiguity.ts");
  const text = await fs.readFile(srcPath, "utf8");
  const forbidden = [
    "supersedes-promote-guard",
    "supersession-edge-simulation",
    "multi-anchor-current-previous",
    "temporal-candidate-generation-probe",
    "temporal-ranking-preference",
    "temporal-truth-diagnostic",
    "paraphrase-recovery",
    "false-abstention-damage",
  ];
  for (const tok of forbidden) {
    assert.equal(
      text.includes(tok),
      false,
      `ambiguity.ts must not reference benchmark experiment module "${tok}"`,
    );
  }
  assert.equal(
    /from\s+["'][^"']*benchmark\//.test(text),
    false,
    "ambiguity.ts must not import from src/benchmark/",
  );
});

// ---------------------------------------------------------------------------
// 15. Symmetric negation is not flagged (agreeing on negation)
// ---------------------------------------------------------------------------

test("detectAmbiguity: symmetric negation -> none (both sides agree)", () => {
  // Both sides have a negation marker: this is the
  // "agreeing on negation" case, not opposition. The
  // detector must stay silent.
  const a = mkCandidate({
    id: 400,
    summary: "we do not use Postgres here",
  });
  const b = mkCandidate({
    id: 401,
    summary: "we do not use Postgres here either",
  });
  const out = detectAmbiguity({
    topCandidates: [a, b],
    answer: "Postgres is not used here.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 16. Empty / invalid topCandidates is treated as no candidates
// ---------------------------------------------------------------------------

test("detectAmbiguity: empty topCandidates -> none", () => {
  const out = detectAmbiguity({ topCandidates: [], answer: "anything", asOf: 0 });
  assert.equal(out.kind, "none");
});

test("detectAmbiguity: non-array topCandidates -> none (defensive)", () => {
  // The type system catches this in normal use; the
  // defensive runtime guard exists for `unknown`-typed
  // boundaries.
  const out = detectAmbiguity({
    topCandidates: null as unknown as readonly SafeMemorySummaryWithRelationship[],
    answer: "anything",
    asOf: 0,
  });
  assert.equal(out.kind, "none");
});
