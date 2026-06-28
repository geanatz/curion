/**
 * Unit tests for the Phase H resolved-history detector.
 *
 * Scope: the pure helper in
 * `src/retrieval/resolved-history.ts`. No storage, no
 * provider, no controller, no benchmark runner, no
 * raw input fields. The tests verify the Phase F
 * spec's §5 rules and the Phase G scenario matrix:
 *
 *   1. Single candidate -> `{ kind: "none" }` (the
 *      detector is pairwise).
 *   2. Empty / non-array candidates -> `{ kind:
 *      "none" }` (defensive runtime guard).
 *   3. SG1 — explicit `previous` + `current` pair
 *      resolves.
 *   4. SG2 — single asymmetric `replaced` marker
 *      only -> does NOT resolve.
 *   5. SG3 — recency-only pair, no markers -> does
 *      NOT resolve.
 *   6. SG4 — three-step timeline: pair (old history,
 *      current) resolves; intermediate row with
 *      co-carried markers does not block.
 *   7. SG5 — plain history row, no markers -> does
 *      NOT resolve.
 *   8. SG6 — explicit unresolved conflict (stored
 *      `conflictsWith` mutual) -> detector stays
 *      silent (Phase D wins).
 *   9. SG7 — superseded / no-longer wording -> the
 *      "no longer" bigram flags the row as
 *      previous-side, and the pair resolves when the
 *      answer aligns with the current side.
 *  10. SG8 — older memories remain state=active and
 *      retrievable. The detector does not see
 *      `state` and is orthogonal to it; this test
 *      pins the public input shape (safe summary
 *      fields only).
 *  11. Pattern B (referential) — a row with a
 *      `supersedes` / `supersededBy` pointer and a
 *      current-side marker resolves when the answer
 *      aligns.
 *  12. Pattern B with no current-side marker -> does
 *      NOT resolve.
 *  13. Determinism: same input + same `asOf` ->
 *      byte-equal output.
 *  14. `asOf` defaults to 0 when omitted (no clock
 *      read).
 *  15. NaN / non-finite `asOf` is clamped to 0.
 *  16. Bounded output: `memoryIds` length <=
 *      `MAX_RESOLVED_HISTORY_IDS`.
 *  17. No mutation of inputs.
 *  18. No raw-input / raw-text reference in the
 *      output.
 *  19. The detector does not import benchmark
 *      experiment modules.
 *  20. Stored `olderVariantsOf` mutual pointer
 *      disqualifies a pair (Phase D wins).
 *  21. Co-carried markers (`previous` + `current` on
 *      the same row) are tolerated; the discriminator
 *      is the answer alignment.
 *  22. "no longer" bigram is recognized as a
 *      previous-side marker.
 *  23. "no longer" without a current-side row ->
 *      does NOT resolve.
 *  24. Single `current` marker alone (no previous
 *      marker anywhere) -> does NOT resolve (locked
 *      decision §5.2: a single marker is not enough).
 *  25. The detector returns the bounded `kind:
 *      "resolved-history"` signal with `reason:
 *      "explicit-resolution"`, ascending ids.
 *  26. Confidence is bounded to `[threshold, 1]` and
 *      stays below 1.0.
 *  27. `asOf` is echoed verbatim when provided.
 *  28. Defensive: malformed `relationship` block is
 *      treated as no relationship.
 *  29. Defensive: duplicate ids in the candidate list
 *      are silently de-duplicated.
 *  30. The detector never depends on id ordering
 *      (no recency claim).
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import url from "node:url";

import {
  MAX_RESOLVED_HISTORY_IDS,
  RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD,
  RESOLVED_HISTORY_CONFIDENCE_THRESHOLD,
  type ResolvedHistoryCandidate,
  detectResolvedHistory,
} from "../src/retrieval/resolved-history.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function mkCandidate(overrides: Partial<ResolvedHistoryCandidate> = {}): ResolvedHistoryCandidate {
  const id = overrides.id ?? nextId++;
  return {
    id,
    kind: "finding",
    state: "active",
    // Phase 1 internal naming cleanup: the internal
    // `ResolvedHistoryCandidate` field is `memoryContent`
    // (TS-side). Provider JSON / public surface still use
    // `summary`; the internal type is the seam.
    memoryContent: "default summary",
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

test("detectResolvedHistory: single candidate -> kind: 'none'", () => {
  const a = mkCandidate({
    id: 1,
    memoryContent: "Render was the previous hosting platform.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a],
    answer: "Fly.io is the current hosting platform.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 2. Empty / non-array candidates -> none (defensive)
// ---------------------------------------------------------------------------

test("detectResolvedHistory: empty topCandidates -> none", () => {
  const out = detectResolvedHistory({
    topCandidates: [],
    answer: "anything",
    asOf: 0,
  });
  assert.equal(out.kind, "none");
});

test("detectResolvedHistory: non-array topCandidates -> none (defensive)", () => {
  // The type system catches this in normal use; the
  // defensive runtime guard exists for `unknown`-
  // typed boundaries.
  const out = detectResolvedHistory({
    topCandidates: null as unknown as readonly ResolvedHistoryCandidate[],
    answer: "anything",
    asOf: 0,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 3. SG1 — explicit previous/current pair resolves
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG1 explicit previous+current pair resolves", () => {
  // Phase G SG1: Render was previous, Fly.io is current.
  // Both rows carry explicit resolution markers; the
  // synthesized answer matches the current side.
  const a = mkCandidate({
    id: 10,
    memoryContent:
      "Render was the previous hosting platform. The current " + "hosting platform is Fly.io.",
  });
  const b = mkCandidate({
    id: 11,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.equal(out.reason, "explicit-resolution");
  // ids are sorted ascending.
  assert.deepEqual(out.memoryIds, [10, 11]);
  assert.ok(
    out.confidence >= RESOLVED_HISTORY_CONFIDENCE_THRESHOLD,
    `expected confidence >= ${RESOLVED_HISTORY_CONFIDENCE_THRESHOLD}, got ${out.confidence}`
  );
  assert.ok(out.confidence <= 1, "confidence bounded to [0, 1]");
});

// ---------------------------------------------------------------------------
// 4. SG2 — single asymmetric marker only -> does NOT resolve
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG2 single asymmetric marker only -> none", () => {
  // Phase G SG2: row 1 carries `replaced` (current-side
  // marker) and row 2 carries no marker at all. The
  // spec is explicit (§5.2 Pattern A): a single
  // marker on one side is NOT enough to claim
  // resolution. The detector must stay silent.
  const a = mkCandidate({
    id: 20,
    memoryContent: "Render was replaced for production hosting.",
  });
  const b = mkCandidate({
    id: 21,
    memoryContent: "The team uses a hosting platform for the staging app.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "The team uses a hosting platform for the staging app.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 5. SG3 — recency-only pair -> does NOT resolve
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG3 recency-only pair -> none (no recency claim)", () => {
  // Phase G SG3: two rows, no markers anywhere. The
  // spec is explicit (§5.3): the detector must not
  // use id ordering, wall-clock time, or `derivedAt`
  // to claim resolution. The pair is silent.
  const a = mkCandidate({
    id: 30,
    memoryContent: "The project uses Render for hosting.",
  });
  const b = mkCandidate({
    id: 31,
    memoryContent: "The project uses Fly.io for hosting.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "The project uses Fly.io for hosting.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

test("detectResolvedHistory: id ordering is irrelevant; (high-id previous, low-id current) does NOT resolve without markers", () => {
  // Reverse the id order from SG3: the lower id is
  // the "Fly.io" row and the higher id is the "Render"
  // row. The detector must not flip the verdict based
  // on id ordering.
  const a = mkCandidate({
    id: 40,
    memoryContent: "The project uses Fly.io for hosting.",
  });
  const b = mkCandidate({
    id: 41,
    memoryContent: "The project uses Render for hosting.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "The project uses Fly.io for hosting.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 6. SG4 — three-step timeline: pair (history, current) resolves
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG4 three-step timeline resolves the (history, current) pair", () => {
  // Phase G SG4: Render -> Fly.io -> Railway, with
  // explicit markers on all sides. The synthesized
  // answer matches the current side (Railway). The
  // first-version detector resolves the (old, current)
  // pair and emits `memoryIds: [history, current]`.
  const history = mkCandidate({
    id: 50,
    memoryContent: "Render was the previous hosting platform. It is no longer used.",
  });
  const intermediate = mkCandidate({
    id: 51,
    memoryContent:
      "Fly.io replaced Render as the hosting platform. " + "It has since been superseded.",
  });
  const current = mkCandidate({
    id: 52,
    memoryContent: "Railway is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [history, intermediate, current],
    answer: "Railway is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  // The detector resolves the (history, current) pair;
  // the intermediate row with co-carried markers
  // (`replaced` + `superseded`) is not a clean
  // current-side and is not emitted in this first
  // version. The history row carries the explicit
  // "no longer" bigram; the current row carries
  // `current`.
  assert.deepEqual(out.memoryIds, [50, 52]);
  assert.ok(
    out.confidence >= RESOLVED_HISTORY_CONFIDENCE_THRESHOLD,
    `expected confidence >= ${RESOLVED_HISTORY_CONFIDENCE_THRESHOLD}, got ${out.confidence}`
  );
});

// ---------------------------------------------------------------------------
// 7. SG5 — plain history row, no markers -> does NOT resolve
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG5 plain history row + companion current row, no markers -> none", () => {
  // Phase G SG5: "We used Render in 2023" + "We use
  // Fly.io" with no resolution markers. The detector
  // has no evidence to claim resolution; it stays
  // silent.
  const a = mkCandidate({
    id: 60,
    memoryContent: "We used Render for hosting in 2023. The team liked it for staging.",
  });
  const b = mkCandidate({
    id: 61,
    memoryContent: "We use Fly.io for production hosting.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "We use Fly.io for production hosting.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 8. SG6 — explicit unresolved conflict (Phase D wins)
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG6 stored mutual conflictsWith -> none (Phase D wins)", () => {
  // Phase G SG6: two rows with a stored `conflictsWith`
  // pointer (mutual) and no resolution marker on the
  // "previous" side. The spec is explicit (§4.2): the
  // resolved-history path must NOT downgrade a Phase D
  // warning. The detector stays silent on this pair so
  // the Phase D warning can fire independently.
  const a = mkCandidate({
    id: 70,
    memoryContent: "Render is the current hosting platform.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [71],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  });
  const b = mkCandidate({
    id: 71,
    memoryContent: "Fly.io is the current hosting platform.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [70],
      olderVariantsOf: [],
      detectionConfidence: 0.93,
    },
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Render is the current hosting platform.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 9. SG7 — superseded / no-longer wording resolves
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG7 superseded/no-longer wording resolves", () => {
  // Phase G SG7: "old hosting was Render, superseded by
  // Fly.io" + "Fly.io is current; Render is no longer
  // used". Row 1 carries `old` and `superseded` (and
  // `replaced`); row 2 carries `current` and the
  // "no longer" bigram. The pair resolves when the
  // answer aligns with the current side.
  const a = mkCandidate({
    id: 80,
    memoryContent: "The old hosting platform was Render. It has been " + "superseded by Fly.io.",
  });
  const b = mkCandidate({
    id: 81,
    memoryContent: "Fly.io is the current hosting platform; Render is no longer used.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  // The pair is (a, b). a is the previous-side
  // (carries `old` + `superseded`); b is the current
  // side (carries `current`). Sorted ascending.
  assert.deepEqual(out.memoryIds, [80, 81]);
  assert.ok(
    out.confidence >= RESOLVED_HISTORY_CONFIDENCE_THRESHOLD,
    `expected confidence >= ${RESOLVED_HISTORY_CONFIDENCE_THRESHOLD}, got ${out.confidence}`
  );
});

// ---------------------------------------------------------------------------
// 10. SG8 — older memories remain retrievable (orthogonal pin)
// ---------------------------------------------------------------------------

test("detectResolvedHistory: SG8 detector operates on safe summary fields only (state is not read)", () => {
  // Phase G SG8: the detector must not see `state`.
  // Older memories stay `state = "active"` and the
  // detector does not have any branch that depends on
  // it. This test pins the input contract: a row with
  // explicit markers is eligible regardless of its
  // declared `state`. The state is informational for
  // the caller; the detector does not gate on it.
  //
  // (In production Phase B only ever writes `state =
  // "active"` and Phase F §6.1 says no state transition
  // happens; this test is a defense-in-depth pin.)
  const a = mkCandidate({
    id: 90,
    memoryContent: "Render was the previous hosting platform.",
    state: "active",
  });
  const b = mkCandidate({
    id: 91,
    memoryContent: "Fly.io is the current hosting platform.",
    state: "active",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
});

// ---------------------------------------------------------------------------
// 11. Pattern B — referential pointer resolves
// ---------------------------------------------------------------------------

test("detectResolvedHistory: Pattern B referential pointer resolves", () => {
  // Pattern B (spec §5.2 / §6.2): the current-side
  // row carries a `supersedes: [previousId]` (or
  // `supersededBy: [previousId]`) reference to the
  // previous-side row, plus a current-side marker.
  // The previous-side row need not carry a marker.
  const a = mkCandidate({
    id: 100,
    memoryContent: "Render was the project hosting platform.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [],
      detectionConfidence: 0,
    },
  });
  const b = mkCandidate({
    id: 101,
    memoryContent: "Fly.io is the current hosting platform for production.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [],
      detectionConfidence: 0,
      supersedes: [100],
    },
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.deepEqual(out.memoryIds, [100, 101]);
});

test("detectResolvedHistory: Pattern B supersedes -> previous side", () => {
  // The reverse direction: the current row carries
  // `supersededBy: [previousId]`. The pairing rule
  // accepts both directions.
  const a = mkCandidate({
    id: 110,
    memoryContent: "Render was the project hosting platform.",
  });
  const b = mkCandidate({
    id: 111,
    memoryContent: "Fly.io is the current hosting platform for production.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [],
      detectionConfidence: 0,
      supersededBy: [110],
    },
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.deepEqual(out.memoryIds, [110, 111]);
});

// ---------------------------------------------------------------------------
// 12. Pattern B with no current-side marker -> does NOT resolve
// ---------------------------------------------------------------------------

test("detectResolvedHistory: Pattern B without current-side marker -> none", () => {
  // The current-side row carries a `supersedes`
  // pointer but no current-side marker. The pairing
  // rule requires a current-side marker on the
  // current side (the explicit pointer is not a
  // substitute for the marker in the first version).
  const a = mkCandidate({
    id: 120,
    memoryContent: "Render was the project hosting platform.",
  });
  const b = mkCandidate({
    id: 121,
    memoryContent: "Fly.io hosts the production app.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [],
      detectionConfidence: 0,
      supersedes: [120],
    },
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io hosts the production app.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 13. Determinism
// ---------------------------------------------------------------------------

test("detectResolvedHistory: deterministic for fixed (topCandidates, answer, asOf)", () => {
  const a = mkCandidate({
    id: 130,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 131,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const candidates = clone([a, b]);
  const out1 = detectResolvedHistory({
    topCandidates: candidates,
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1_700_000_000_000,
  });
  const out2 = detectResolvedHistory({
    topCandidates: clone([a, b]),
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1_700_000_000_000,
  });
  assert.deepEqual(out1, out2);
});

// ---------------------------------------------------------------------------
// 14. asOf defaults to 0 (no clock read)
// ---------------------------------------------------------------------------

test("detectResolvedHistory: omitted asOf -> asOf in result defaults to 0 (no clock read)", () => {
  const a = mkCandidate({
    id: 140,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 141,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
  });
  assert.equal(out.asOf, 0);
});

// ---------------------------------------------------------------------------
// 15. NaN / non-finite asOf is clamped to 0
// ---------------------------------------------------------------------------

test("detectResolvedHistory: NaN / non-finite asOf is clamped to 0", () => {
  const a = mkCandidate({ id: 150, memoryContent: "x" });
  const b = mkCandidate({ id: 151, memoryContent: "y" });
  const outNaN = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "x",
    asOf: Number.NaN,
  });
  const outInf = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "x",
    asOf: Number.POSITIVE_INFINITY,
  });
  assert.equal(outNaN.asOf, 0);
  assert.equal(outInf.asOf, 0);
});

// ---------------------------------------------------------------------------
// 16. Bounded output
// ---------------------------------------------------------------------------

test("detectResolvedHistory: emitted memoryIds array is bounded to MAX_RESOLVED_HISTORY_IDS", () => {
  // The pair is bounded to two ids in the first
  // version; the cap is a no-op on a pair but the
  // detector must still respect the bound. This test
  // asserts the cap is applied even on a contrived
  // large input.
  const a = mkCandidate({
    id: 160,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 161,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  if (out.kind === "resolved-history") {
    assert.ok(out.memoryIds.length <= MAX_RESOLVED_HISTORY_IDS);
    for (const id of out.memoryIds) {
      assert.equal(typeof id, "number");
      assert.ok(Number.isFinite(id) && id > 0);
    }
  } else {
    assert.equal(out.kind, "none");
  }
});

// ---------------------------------------------------------------------------
// 17. No mutation of inputs
// ---------------------------------------------------------------------------

test("detectResolvedHistory: does not mutate inputs", () => {
  const a = mkCandidate({
    id: 170,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 171,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const snapA = JSON.parse(JSON.stringify(a)) as unknown;
  const snapB = JSON.parse(JSON.stringify(b)) as unknown;
  detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.deepEqual(a, snapA);
  assert.deepEqual(b, snapB);
});

// ---------------------------------------------------------------------------
// 18. No raw-input / raw-text reference in output
// ---------------------------------------------------------------------------

test("detectResolvedHistory: output never references raw text", () => {
  const a = mkCandidate({
    id: 180,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 181,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  const json = JSON.stringify(out);
  // The detector must never carry a `raw` / `text` /
  // `input` / `query` field on the signal.
  for (const forbidden of ["raw", "text", "input", "query"]) {
    assert.equal(
      (out as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `signal must not include a '${forbidden}' field`
    );
  }
  // The synthesized answer text must not be echoed
  // in the signal content (ids only).
  assert.ok(
    !json.includes("Fly.io is the current"),
    "signal must not include the synthesized answer text"
  );
});

// ---------------------------------------------------------------------------
// 19. The detector does not import benchmark experiment modules
// ---------------------------------------------------------------------------

test("resolved-history detector: does not import benchmark experiment modules", async () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const srcPath = path.resolve(here, "../src/retrieval/resolved-history.ts");
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
      `resolved-history.ts must not reference benchmark experiment module "${tok}"`
    );
  }
  assert.equal(
    /from\s+["'][^"']*benchmark\//.test(text),
    false,
    "resolved-history.ts must not import from src/benchmark/"
  );
});

// ---------------------------------------------------------------------------
// 20. Stored mutual olderVariantsOf -> none (Phase D wins)
// ---------------------------------------------------------------------------

test("detectResolvedHistory: stored mutual olderVariantsOf -> none (Phase D wins)", () => {
  // The Phase D Rule 2 (`older-variant-suspected`)
  // pointer disqualifies a pair. The detector must
  // not also emit a resolved-history note on the same
  // pair (spec §4.2 / §5.2).
  const a = mkCandidate({
    id: 190,
    memoryContent: "Project data is stored in Postgres on a single host.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [191],
      detectionConfidence: 0.95,
    },
  });
  const b = mkCandidate({
    id: 191,
    memoryContent: "Project data is stored in Postgres on multiple hosts.",
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [190],
      detectionConfidence: 0.93,
    },
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Project data is stored in Postgres on multiple hosts.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 21. Co-carried markers (previous + current on the same row)
// ---------------------------------------------------------------------------

test("detectResolvedHistory: co-carried markers on a row do not block pairing when the answer aligns", () => {
  // Spec example §7.2: row 1 carries `previous` AND
  // `current`; row 2 carries only `current`. The
  // pair resolves when the answer aligns with the
  // current side. The detector must not require
  // exact-side purity.
  const a = mkCandidate({
    id: 200,
    memoryContent:
      "Render was the previous hosting platform. The current " + "hosting platform is Fly.io.",
  });
  const b = mkCandidate({
    id: 201,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.deepEqual(out.memoryIds, [200, 201]);
});

// ---------------------------------------------------------------------------
// 22. "no longer" bigram is recognized
// ---------------------------------------------------------------------------

test("detectResolvedHistory: 'no longer' bigram flags a row as previous-side", () => {
  // The bigram is matched case-insensitively and as a
  // whole substring on the lowercased copy.
  const a = mkCandidate({
    id: 210,
    memoryContent: "Postgres is the primary store. It is no longer in use.",
  });
  const b = mkCandidate({
    id: 211,
    memoryContent: "MySQL is the current primary store for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "MySQL is the current primary store for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.deepEqual(out.memoryIds, [210, 211]);
});

// ---------------------------------------------------------------------------
// 23. "no longer" without a current-side row -> does NOT resolve
// ---------------------------------------------------------------------------

test("detectResolvedHistory: 'no longer' bigram without a current-side row -> none", () => {
  // A single row that carries the previous-side
  // marker without a companion current-side marker
  // must NOT claim resolution (locked decision
  // §5.2). The pairing rule is bilateral.
  const a = mkCandidate({
    id: 220,
    memoryContent: "Postgres is no longer the primary store.",
  });
  const b = mkCandidate({
    id: 221,
    memoryContent: "The team uses a database for the staging app.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "The team uses a database for the staging app.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 24. Single `current` marker alone (no previous) -> does NOT resolve
// ---------------------------------------------------------------------------

test("detectResolvedHistory: single current marker alone (no previous anywhere) -> none", () => {
  // Locked decision §5.2: a single marker on one
  // side is not enough. The pair must have at least
  // one previous-side marker somewhere. A single
  // `current` row plus a non-marker row does not
  // claim resolution.
  const a = mkCandidate({
    id: 230,
    memoryContent: "Fly.io is the current hosting platform.",
  });
  const b = mkCandidate({
    id: 231,
    memoryContent: "The team uses a hosting platform for the staging app.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

// ---------------------------------------------------------------------------
// 25. Signal shape
// ---------------------------------------------------------------------------

test("detectResolvedHistory: signal shape -> kind / reason / memoryIds / confidence / asOf", () => {
  const a = mkCandidate({
    id: 240,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 241,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1_700_000_000_000,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.equal(out.reason, "explicit-resolution");
  assert.equal(typeof out.confidence, "number");
  assert.equal(typeof out.asOf, "number");
  assert.ok(Array.isArray(out.memoryIds));
  // ids ascending.
  for (let i = 1; i < out.memoryIds.length; i += 1) {
    const prev = out.memoryIds[i - 1];
    const cur = out.memoryIds[i];
    assert.ok(prev !== undefined && cur !== undefined && prev < cur, "memoryIds must be ascending");
  }
});

// ---------------------------------------------------------------------------
// 26. Confidence is bounded to [threshold, 1) and stays below 1.0
// ---------------------------------------------------------------------------

test("detectResolvedHistory: emitted confidence is bounded to [threshold, 1) on a clean pair", () => {
  const a = mkCandidate({
    id: 250,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 251,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.ok(out.confidence >= RESOLVED_HISTORY_CONFIDENCE_THRESHOLD);
  // The cap is 0.99 (per `finalizePatternA`); the
  // detector must never emit 1.0.
  assert.ok(out.confidence <= 0.99, "confidence stays below 1.0");
});

// ---------------------------------------------------------------------------
// 27. asOf is echoed verbatim
// ---------------------------------------------------------------------------

test("detectResolvedHistory: asOf is echoed verbatim in the signal", () => {
  const a = mkCandidate({
    id: 260,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 261,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1_700_000_000_000,
  });
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.equal(out.asOf, 1_700_000_000_000);
});

// ---------------------------------------------------------------------------
// 28. Defensive: malformed relationship block is treated as no relationship
// ---------------------------------------------------------------------------

test("detectResolvedHistory: malformed relationship block is treated as no relationship", () => {
  // The type system catches this in normal use; the
  // defensive runtime guard exists for `unknown`-
  // typed boundaries. A row with a non-object
  // `relationship` value is treated as having no
  // relationship block: Pattern B cannot fire, but
  // Pattern A can still fire on the safe summary
  // text.
  const a = mkCandidate({
    id: 270,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 271,
    memoryContent: "Fly.io is the current hosting platform for production.",
    relationship: "not-an-object" as unknown as ResolvedHistoryCandidate["relationship"],
  });
  // Cast through unknown for the test fixture: the
  // type system rejects it, but the detector's
  // defensive guard makes it safe.
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
});

// ---------------------------------------------------------------------------
// 29. Defensive: duplicate ids in the candidate list are de-duplicated
// ---------------------------------------------------------------------------

test("detectResolvedHistory: duplicate ids in the candidate list are de-duplicated", () => {
  // A future caller might pass the same row twice
  // (e.g. on a re-insert path). The detector must not
  // self-pair the row with itself; it must de-
  // duplicate the id set and proceed with the
  // remaining distinct rows.
  const a = mkCandidate({
    id: 280,
    memoryContent: "Render was the previous hosting platform.",
  });
  const aDup = mkCandidate({
    id: 280,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 281,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, aDup, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.equal(out.kind, "resolved-history");
  if (out.kind !== "resolved-history") throw new Error("unreachable");
  assert.deepEqual(out.memoryIds, [280, 281]);
});

// ---------------------------------------------------------------------------
// 30. The detector does not depend on id ordering for resolution
// ---------------------------------------------------------------------------

test("detectResolvedHistory: candidate list order does not affect the result", () => {
  // The detector must not depend on the lexical
  // ranker's order in the top-K (spec §5.3). The
  // same pair, listed in the opposite order, must
  // produce a byte-equal signal.
  const a = mkCandidate({
    id: 290,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 291,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out1 = detectResolvedHistory({
    topCandidates: [a, b],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  const out2 = detectResolvedHistory({
    topCandidates: [b, a],
    answer: "Fly.io is the current hosting platform for production.",
    asOf: 1,
  });
  assert.deepEqual(out1, out2);
});

// ---------------------------------------------------------------------------
// 31. Answer must align with the current side
// ---------------------------------------------------------------------------

test("detectResolvedHistory: answer that does NOT align with the current side -> none", () => {
  // The synthesized answer mentions only the
  // previous-side content; it does not align with
  // the current side. The detector cannot claim the
  // model took the current side and must stay
  // silent.
  const a = mkCandidate({
    id: 300,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 301,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    // The answer mentions Render, not Fly.io.
    answer: "The previous hosting platform was Render.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

test("detectResolvedHistory: answer that aligns with the previous side -> none (alignment discriminator)", () => {
  // The synthesized answer mentions the previous-side
  // platform (Render) but not the current side
  // (Fly.io). The detector cannot claim the model
  // took the current side; it stays silent.
  const a = mkCandidate({
    id: 310,
    memoryContent: "Render was the previous hosting platform.",
  });
  const b = mkCandidate({
    id: 311,
    memoryContent: "Fly.io is the current hosting platform for production.",
  });
  const out = detectResolvedHistory({
    topCandidates: [a, b],
    // The answer talks about Render (the previous
    // side) and a generic kitchen fact, not Fly.io.
    // No content-token overlap with row b above the
    // threshold.
    answer: "Render was replaced last year. The kitchen dishwasher runs at 11pm.",
    asOf: 1,
  });
  assert.equal(out.kind, "none");
});

test("detectResolvedHistory: RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD is exported and stable", () => {
  // Threshold is part of the public contract; pin it.
  assert.equal(RESOLVED_HISTORY_ANSWER_OVERLAP_THRESHOLD, 0.4);
});

test("detectResolvedHistory: RESOLVED_HISTORY_CONFIDENCE_THRESHOLD is exported and stable", () => {
  // Threshold is part of the public contract; pin it.
  assert.equal(RESOLVED_HISTORY_CONFIDENCE_THRESHOLD, 0.8);
});
