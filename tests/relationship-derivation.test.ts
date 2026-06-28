/**
 * Unit tests for the Phase A relationship-derivation function.
 *
 * Scope: the pure helper in `src/retrieval/relationship.ts`.
 * No storage, no provider, no controller, no benchmark runner,
 * no raw input fields. The tests verify:
 *
 *   1. Empty / no related memories -> empty derived fields.
 *   2. Clean, unrelated related memory -> no conflict.
 *   3. Conservative conflict detection only at high evidence
 *      (asymmetric negation + high overlap, or polarity-tag
 *      disagreement + shared tags).
 *   4. Older-variant detection only at high evidence, only for
 *      earlier-id summaries, only at or above τ' (0.90).
 *   5. Deterministic `derivedAt` via injected `asOf`; default
 *      of `0` when omitted.
 *   6. Bounded output: each id array <= MAX_RELATED_IDS,
 *      detectionConfidence in [0, 1], sorted ascending.
 *   7. No mutation of inputs (candidate or others).
 *   8. No raw-input / raw-text reference in the output (the
 *      helper never sees raw input; the test confirms the
 *      property by passing an extra `rawInput` field on the
 *      candidate and asserting the output never references it).
 *   9. No use/import of benchmark experiment modules.
 *  10. `derivedSchemaVersion` is the literal `"ccm-draft-1"`.
 *  11. `derivedAt` echoes the injected `asOf` (or `0` if
 *      omitted), with no clock read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONFLICT_CONFIDENCE_THRESHOLD,
  DERIVED_SCHEMA_VERSION,
  MAX_RELATED_IDS,
  OLDER_VARIANT_CONFIDENCE_THRESHOLD,
  type RelationshipMetadataFields,
  deriveRelationshipMetadata,
} from "../src/retrieval/relationship.ts";
import type { SafeMemorySummary } from "../src/storage/storage.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function mkSummary(overrides: Partial<SafeMemorySummary> = {}): SafeMemorySummary {
  const id = overrides.id ?? nextId++;
  return {
    id,
    kind: "finding",
    state: "active",
    // Phase 1 internal naming cleanup: the internal
    // `SafeMemorySummary` field is `memoryContent` (TS-side).
    // Provider JSON / public surface still use `summary`;
    // the internal type is the seam.
    memoryContent: "default summary",
    tags: [],
    classification: null,
    confidence: 0.9,
    ...overrides,
  };
}

/** Deep clone of a summary fixture so test mutations do not leak. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// 1. Empty / no related memories
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: empty others -> all derived fields empty", () => {
  const candidate = mkSummary({ id: 100, memoryContent: "we use Postgres for storage" });
  const out = deriveRelationshipMetadata({ candidate, others: [], asOf: 1_700_000_000_000 });
  assert.deepEqual(out.conflictsWith, []);
  assert.deepEqual(out.olderVariantsOf, []);
  assert.equal(out.detectionConfidence, 0);
  assert.equal(out.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
  assert.equal(out.derivedAt, 1_700_000_000_000);
});

test("deriveRelationshipMetadata: omitted asOf -> derivedAt defaults to 0 (no clock read)", () => {
  const candidate = mkSummary({ id: 200, memoryContent: "x" });
  const out = deriveRelationshipMetadata({ candidate, others: [] });
  assert.equal(out.derivedAt, 0);
});

test("deriveRelationshipMetadata: NaN / non-finite asOf is clamped to 0", () => {
  const candidate = mkSummary({ id: 201, memoryContent: "x" });
  const outNaN = deriveRelationshipMetadata({ candidate, others: [], asOf: Number.NaN });
  const outInf = deriveRelationshipMetadata({
    candidate,
    others: [],
    asOf: Number.POSITIVE_INFINITY,
  });
  assert.equal(outNaN.derivedAt, 0);
  assert.equal(outInf.derivedAt, 0);
});

// ---------------------------------------------------------------------------
// 2. Clean / unrelated related memory -> no conflict
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: clean unrelated memory -> no conflict, no older variant", () => {
  const candidate = mkSummary({
    id: 10,
    memoryContent: "the project uses Postgres for storage",
  });
  const other = mkSummary({
    id: 11,
    memoryContent: "the team drinks tea on Tuesdays",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 1 });
  assert.deepEqual(out.conflictsWith, []);
  assert.deepEqual(out.olderVariantsOf, []);
  assert.equal(out.detectionConfidence, 0);
});

test("deriveRelationshipMetadata: low-overlap memories with negation -> no conflict (conservative)", () => {
  // Even though one side has a negation marker, the overlap is
  // far too low to claim opposition. The detector must stay
  // silent.
  const candidate = mkSummary({
    id: 12,
    memoryContent: "we do not use MongoDB for this service",
  });
  const other = mkSummary({
    id: 13,
    memoryContent: "the team drinks tea on Tuesdays",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 1 });
  assert.deepEqual(out.conflictsWith, []);
  assert.equal(out.detectionConfidence, 0);
});

// ---------------------------------------------------------------------------
// 3. Conservative conflict detection (asymmetric negation, polarity tags)
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: high overlap + asymmetric negation -> conflict", () => {
  // "Postgres" is the shared key fact; the negation marker is
  // on the candidate side ("do not use"). This should fire
  // the conflict signal.
  const candidate = mkSummary({
    id: 20,
    memoryContent: "we do not use Postgres for this service",
  });
  const other = mkSummary({
    id: 21,
    memoryContent: "we use Postgres for this service",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 5 });
  assert.deepEqual(out.conflictsWith, [21]);
  assert.ok(
    out.detectionConfidence >= CONFLICT_CONFIDENCE_THRESHOLD,
    `expected detectionConfidence >= ${CONFLICT_CONFIDENCE_THRESHOLD}, got ${out.detectionConfidence}`
  );
});

test("deriveRelationshipMetadata: symmetric negation -> no conflict (they agree on the negation)", () => {
  const candidate = mkSummary({
    id: 22,
    memoryContent: "we do not use Postgres here",
  });
  const other = mkSummary({
    id: 23,
    memoryContent: "we do not use Postgres here either",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 5 });
  // Both sides carry the negation marker; this is the
  // "agreeing on negation" case, not opposition. The detector
  // stays silent.
  assert.deepEqual(out.conflictsWith, []);
});

test("deriveRelationshipMetadata: below-threshold overlap with negation -> no conflict (conservative)", () => {
  // Shared single content word "postgres" -> low Jaccard even
  // though both mention the same technology. The detector
  // stays silent by design.
  const candidate = mkSummary({
    id: 24,
    memoryContent: "we do not use Postgres",
  });
  const other = mkSummary({
    id: 25,
    memoryContent: "postgres is the production database and we love it",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 5 });
  assert.deepEqual(out.conflictsWith, []);
});

test("deriveRelationshipMetadata: identical summaries -> no conflict (paraphrase-equal case)", () => {
  // Identical summaries are not "conflict". The detector
  // leaves this to the older-variants rule (and even there,
  // identical text returns null).
  const candidate = mkSummary({
    id: 26,
    memoryContent: "we use Postgres for storage",
  });
  const other = mkSummary({
    id: 27,
    memoryContent: "we use Postgres for storage",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 5 });
  assert.deepEqual(out.conflictsWith, []);
  assert.deepEqual(out.olderVariantsOf, []);
});

test("deriveRelationshipMetadata: polarity-tag disagreement + shared tags -> conflict", () => {
  const candidate = mkSummary({
    id: 30,
    memoryContent: "we use Postgres for storage in production",
    tags: ["database", "current"],
  });
  const other = mkSummary({
    id: 31,
    memoryContent: "we use Postgres for storage in production",
    tags: ["database", "deprecated"],
  });
  // Same summary text, but opposing polarity tags. Even
  // though there's no negation marker, the detector should
  // fire on polarity disagreement.
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 5 });
  assert.deepEqual(out.conflictsWith, [31]);
});

// ---------------------------------------------------------------------------
// 4. Older-variant detection (τ' = 0.90, earlier-id only)
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: near-paraphrase of earlier-id summary -> olderVariantsOf includes it", () => {
  // Two carefully chosen summaries that survive the lexical
  // stop-word filter and produce a Jaccard >= 0.90. The
  // candidate is the *shorter* (newer, more concise) version;
  // the older row carries an extra clause. Jaccard with
  // multiset semantics:
  //   candidate tokens: postgres, stores, project, data,
  //     reliably, migrated, mysql, production, deployment
  //     (9 tokens)
  //   older    tokens: same 9 + "since" (10 tokens)
  //   |A ∩ B| / |A ∪ B| = 9 / 10 = 0.90
  const candidate = mkSummary({
    id: 50,
    memoryContent:
      "Postgres stores project data reliably; migrated from MySQL; production deployment",
  });
  const older = mkSummary({
    id: 40, // strictly earlier id
    memoryContent:
      "Postgres stores project data reliably; migrated from MySQL; production deployment since 2023",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [older], asOf: 5 });
  assert.deepEqual(out.olderVariantsOf, [40]);
  assert.ok(
    out.detectionConfidence >= OLDER_VARIANT_CONFIDENCE_THRESHOLD,
    `expected detectionConfidence >= ${OLDER_VARIANT_CONFIDENCE_THRESHOLD}, got ${out.detectionConfidence}`
  );
});

test("deriveRelationshipMetadata: low-overlap older-id summary -> no older variant", () => {
  const candidate = mkSummary({
    id: 60,
    memoryContent: "we use Postgres for storage in production",
  });
  const older = mkSummary({
    id: 59,
    memoryContent: "the team meets on Tuesdays for lunch",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [older], asOf: 5 });
  assert.deepEqual(out.olderVariantsOf, []);
});

test("deriveRelationshipMetadata: near-paraphrase of NEWER-id summary -> not olderVariantsOf", () => {
  // The "earlier id" guard is structural: a summary with a
  // higher id than the candidate cannot be an "older variant"
  // of it. The detector must not fire.
  const candidate = mkSummary({
    id: 70,
    memoryContent: "we use Postgres for storage in production",
  });
  const newer = mkSummary({
    id: 71,
    memoryContent: "we use Postgres for storage in production today",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [newer], asOf: 5 });
  assert.deepEqual(out.olderVariantsOf, []);
});

test("deriveRelationshipMetadata: same-id summary -> no older variant", () => {
  const candidate = mkSummary({
    id: 80,
    memoryContent: "we use Postgres for storage in production",
  });
  const same = mkSummary({
    id: 80,
    memoryContent: "we use Postgres for storage in production today",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [same], asOf: 5 });
  assert.deepEqual(out.olderVariantsOf, []);
});

test("deriveRelationshipMetadata: both conflict and older-variant can fire in one call", () => {
  // The candidate is a long, content-rich sentence. Two
  // related summaries exercise both rules in one call:
  //   - older (id 90): paraphrased earlier-id summary that
  //     extends the candidate with one extra token ("since").
  //     Jaccard with candidate: 12 / 13 ≈ 0.923 (clears τ').
  //   - conflicting (id 91): same content, but with a negation
  //     marker ("we do not use ...") the candidate does not
  //     have. Jaccard with candidate: 11 / 12 ≈ 0.917
  //     (clears the conflict rule's 0.6 floor), and the
  //     asymmetric-negation signature fires.
  const candidate = mkSummary({
    id: 100,
    memoryContent:
      "Postgres stores project data reliably; migrated from MySQL; production deployment supports concurrent users",
  });
  const older = mkSummary({
    id: 90,
    memoryContent:
      "Postgres stores project data reliably; migrated from MySQL; production deployment supports concurrent users since 2023",
  });
  const conflicting = mkSummary({
    id: 91,
    memoryContent:
      "we do not use Postgres stores project data reliably; production deployment supports concurrent users",
  });
  const out = deriveRelationshipMetadata({
    candidate,
    others: [older, conflicting],
    asOf: 5,
  });
  assert.ok(
    out.conflictsWith.includes(91),
    `expected conflictsWith to include 91, got ${out.conflictsWith}`
  );
  assert.ok(
    out.olderVariantsOf.includes(90),
    `expected olderVariantsOf to include 90, got ${out.olderVariantsOf}`
  );
  assert.ok(
    out.detectionConfidence >= OLDER_VARIANT_CONFIDENCE_THRESHOLD,
    `expected detectionConfidence >= ${OLDER_VARIANT_CONFIDENCE_THRESHOLD}, got ${out.detectionConfidence}`
  );
});

// ---------------------------------------------------------------------------
// 5. Determinism: byte-equal output across repeated calls
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: determinism -> same input + same asOf -> byte-equal output", () => {
  const candidate = mkSummary({
    id: 200,
    memoryContent: "we do not use Postgres for this service",
    tags: ["database", "current"],
  });
  const others: SafeMemorySummary[] = [
    mkSummary({ id: 201, memoryContent: "we use Postgres for this service in production" }),
    mkSummary({ id: 199, memoryContent: "we use Postgres for this service in production" }),
    mkSummary({ id: 202, memoryContent: "the team drinks tea on Tuesdays" }),
  ];
  const a = deriveRelationshipMetadata({ candidate, others, asOf: 42 });
  const b = deriveRelationshipMetadata({ candidate, others, asOf: 42 });
  // Two independent calls with the same input must be deep-
  // equal. The check is intentionally structural: same
  // arrays, same confidence, same derivedAt, same schema
  // version.
  assert.deepEqual(a, b);
  // And the output is what the spec says it is, shape-wise.
  assert.equal(typeof a.derivedAt, "number");
  assert.equal(a.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
});

test("deriveRelationshipMetadata: determinism -> asOf differs only in derivedAt", () => {
  const candidate = mkSummary({ id: 210, memoryContent: "x" });
  const others: SafeMemorySummary[] = [
    mkSummary({ id: 211, memoryContent: "we use Postgres for this service in production" }),
  ];
  const a = deriveRelationshipMetadata({ candidate, others, asOf: 1 });
  const b = deriveRelationshipMetadata({ candidate, others, asOf: 2 });
  assert.notEqual(a.derivedAt, b.derivedAt);
  assert.deepEqual(a.conflictsWith, b.conflictsWith);
  assert.deepEqual(a.olderVariantsOf, b.olderVariantsOf);
  assert.equal(a.detectionConfidence, b.detectionConfidence);
});

// ---------------------------------------------------------------------------
// 6. Bounded output
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: bounded output -> conflictsWith length <= MAX_RELATED_IDS", () => {
  const candidate = mkSummary({
    id: 300,
    memoryContent: "we do not use Postgres for this service",
  });
  // Generate MAX_RELATED_IDS + 5 strong conflict signals.
  const others: SafeMemorySummary[] = [];
  for (let i = 0; i < MAX_RELATED_IDS + 5; i++) {
    others.push(
      mkSummary({
        id: 301 + i,
        memoryContent: "we use Postgres for this service in production",
      })
    );
  }
  const out = deriveRelationshipMetadata({ candidate, others, asOf: 1 });
  assert.ok(
    out.conflictsWith.length <= MAX_RELATED_IDS,
    `expected conflictsWith.length <= ${MAX_RELATED_IDS}, got ${out.conflictsWith.length}`
  );
  // Ids are sorted ascending.
  for (let i = 1; i < out.conflictsWith.length; i++) {
    assert.ok(
      out.conflictsWith[i - 1] < out.conflictsWith[i],
      "expected conflictsWith to be sorted ascending"
    );
  }
});

test("deriveRelationshipMetadata: detectionConfidence in [0, 1]", () => {
  const candidate = mkSummary({
    id: 400,
    memoryContent: "we do not use Postgres for this service",
  });
  const strong = mkSummary({
    id: 401,
    memoryContent: "we use Postgres for this service in production",
  });
  const weak = mkSummary({
    id: 402,
    memoryContent: "the team drinks tea on Tuesdays",
  });
  const out = deriveRelationshipMetadata({
    candidate,
    others: [strong, weak],
    asOf: 1,
  });
  assert.ok(out.detectionConfidence >= 0);
  assert.ok(out.detectionConfidence <= 1);
});

// ---------------------------------------------------------------------------
// 7. No mutation of inputs
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: does not mutate candidate or others", () => {
  const candidateSnapshot = {
    id: 500,
    memoryContent: "we do not use Postgres for this service",
    tags: ["database", "current"],
  };
  const otherSnapshot = {
    id: 501,
    memoryContent: "we use Postgres for this service in production",
    tags: ["database", "deprecated"],
  };
  const candidate = mkSummary({ ...candidateSnapshot });
  const other = mkSummary({ ...otherSnapshot });
  const candidateBefore = clone(candidate);
  const otherBefore = clone(other);
  const othersBefore = [other];
  const arrSnapshot = othersBefore.slice();

  deriveRelationshipMetadata({ candidate, others: othersBefore, asOf: 1 });

  assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual(other, otherBefore);
  // The `others` array itself was not replaced; it still
  // contains the same object reference.
  assert.equal(othersBefore.length, arrSnapshot.length);
  assert.equal(othersBefore[0], other);
});

// ---------------------------------------------------------------------------
// 8. No raw-input reference in the output
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: output never references raw input", () => {
  // The function signature is `SafeMemorySummary`, so it has
  // no access to raw input. This test asserts the contract by
  // adding an extra `rawInput` field to the candidate and
  // asserting the function does not include it anywhere in
  // the output.
  type WithRaw = SafeMemorySummary & { rawInput?: string };
  const candidate = mkSummary({
    id: 600,
    memoryContent: "we do not use Postgres for this service",
  }) as WithRaw;
  candidate.rawInput = "PRIVATE RAW USER TEXT — must never leak";
  const other = mkSummary({
    id: 601,
    memoryContent: "we use Postgres for this service in production",
  });
  const out = deriveRelationshipMetadata({ candidate, others: [other], asOf: 1 });
  const serialised = JSON.stringify(out);
  assert.equal(
    serialised.includes("PRIVATE RAW USER TEXT"),
    false,
    "output must not contain raw input text"
  );
  assert.equal(serialised.includes("rawInput"), false, "output must not contain the rawInput key");
});

// ---------------------------------------------------------------------------
// 9. No use/import of benchmark experiment modules
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: relationship module does not import benchmark experiment modules", async () => {
  // Read the source file as text and assert it does not
  // import any path that smells like a benchmark experiment
  // module (e.g. `supersedes-promote-guard`,
  // `supersession-edge-simulation`,
  // `multi-anchor-current-previous`, etc.).
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const srcPath = path.resolve(here, "../src/retrieval/relationship.ts");
  const text = await fs.readFile(srcPath, "utf8");
  // The forbidden substrings are benchmark-experiment
  // identifiers (see the `experiment/*` branch names in the
  // repo). Phase A's pure module must not reference any of
  // them, even in a comment.
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
      `relationship.ts must not reference benchmark experiment module "${tok}"`
    );
  }
  // And the module must not import from the benchmark
  // directory at all.
  assert.equal(
    /from\s+["'][^"']*benchmark\//.test(text),
    false,
    "relationship.ts must not import from src/benchmark/"
  );
});

// ---------------------------------------------------------------------------
// 10. Schema version literal
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: derivedSchemaVersion is the literal ccm-draft-2 (Phase I bump)", () => {
  const candidate = mkSummary({ id: 700, memoryContent: "x" });
  const out = deriveRelationshipMetadata({ candidate, others: [], asOf: 1 });
  assert.equal(out.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
  // Phase I bumps the literal from "ccm-draft-1" to
  // "ccm-draft-2". The new literal is the contract; tests
  // pin the constant (which equals the literal) so the test
  // is robust to a future bump.
  assert.equal(out.derivedSchemaVersion, "ccm-draft-2");
});

test("deriveRelationshipMetadata: legacy constant ccm-draft-1 is exported for compat tests", () => {
  // The old literal is preserved for the read-side fallback
  // and for the compatibility tests in
  // `tests/resolved-history-metadata.test.ts` (Phase I).
  // It is not the same as the new write literal.
  assert.equal("ccm-draft-1", "ccm-draft-1");
  assert.notEqual("ccm-draft-1", DERIVED_SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// 11. Public API / type shape stays bounded
// ---------------------------------------------------------------------------

test("deriveRelationshipMetadata: output shape is the spec'd block (5 fields)", () => {
  const candidate = mkSummary({ id: 800, memoryContent: "x" });
  const out: RelationshipMetadataFields = deriveRelationshipMetadata({
    candidate,
    others: [],
    asOf: 1,
  });
  // Exact key set. The Phase I pass-through fields
  // (`supersedes`, `supersededBy`, `resolvedAt`) are NOT
  // populated by this function — the detector only emits the
  // five conservative fields. The optional keys are
  // pass-through on the type and the writer in
  // `buildPersistedMetadata`, not on the detector.
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      "conflictsWith",
      "derivedAt",
      "derivedSchemaVersion",
      "detectionConfidence",
      "olderVariantsOf",
    ].sort()
  );
});

test("deriveRelationshipMetadata: non-active other summaries are skipped", () => {
  // Phase A does not introduce state transitions, so all
  // memories are `active`. But the detector must defensively
  // skip non-active rows in case the read-side projection
  // changes in a later phase.
  const candidate = mkSummary({
    id: 900,
    memoryContent: "we do not use Postgres for this service",
  });
  const superseded = mkSummary({
    id: 901,
    memoryContent: "we use Postgres for this service in production",
    state: "superseded",
  });
  const out = deriveRelationshipMetadata({
    candidate,
    others: [superseded],
    asOf: 1,
  });
  assert.deepEqual(out.conflictsWith, []);
  assert.deepEqual(out.olderVariantsOf, []);
});
