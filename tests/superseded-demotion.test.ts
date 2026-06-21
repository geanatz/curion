/**
 * Regression tests for superseded-memory demotion.
 *
 * Tests the `demoteSupersededMemories` helper and its integration
 * into the recall controller ranking pipeline.
 *
 * Covers:
 *   1. Stale loses to current: when A `supersedes` B and both are
 *      in the candidate list, B is demoted below A.
 *   2. Unrelated ranking order preserved: candidates with no supersession
 *      relationship keep their relative order.
 *   3. Missing references ignored: when A `supersedes` B but B is not
 *      in the candidate list, no demotion occurs.
 *   4. Bidirectional supersession: when A `supersedes` B and also
 *      `supersededBy` C, the correct staleness is determined per-candidate.
 *   5. Multiple supersession edges: multiple independent supersession
 *      chains are handled correctly.
 *   6. Non-mutation: the input array is not modified.
 *   7. Determinism: same input produces same output.
 *   8. Single candidate: no pair possible, no demotion.
 *   9. Empty array: defensive handling.
 *   10. Malformed relationship data: safely ignored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  demoteSupersededMemories,
  DEMOTION_FACTOR,
  type ScoredCandidateWithRelationship,
} from "../src/retrieval/superseded-demotion.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkCandidate(
  id: number,
  score: number,
  relationship?: ScoredCandidateWithRelationship["relationship"],
): ScoredCandidateWithRelationship {
  return relationship === undefined
    ? { id, score }
    : { id, score, relationship };
}

// ---------------------------------------------------------------------------
// 1. Stale loses to current
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: A supersedes B -> B is demoted below A", () => {
  // A (id=10) supersedes B (id=5). Both in candidate list.
  // B should be demoted, A stays.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),   // B is stale
    mkCandidate(10, 0.75, { supersedes: [5] }),   // A is current
    mkCandidate(20, 0.70),                         // unrelated C
  ];
  const result = demoteSupersededMemories(candidates);
  // A (0.75) should rank above C (0.70) above B (0.008).
  assert.equal(result[0]!.id, 10);   // A is first
  assert.equal(result[0]!.score, 0.75);
  assert.equal(result[1]!.id, 20);   // C is second
  assert.equal(result[1]!.score, 0.70);
  assert.equal(result[2]!.id, 5);    // B is last (demoted)
  assert.equal(result[2]!.score, 0.80 * DEMOTION_FACTOR);
});

test("demoteSupersededMemories: supersededBy reference -> stale candidate demoted", () => {
  // Same case but expressed via supersededBy on the stale side.
  const candidates = [
    mkCandidate(10, 0.90, { supersedes: [5] }),   // A is current
    mkCandidate(5, 0.85, { supersededBy: [10] }), // B is stale
    mkCandidate(15, 0.80),                        // unrelated C
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);   // A first
  assert.equal(result[1]!.id, 15);   // C second
  assert.equal(result[2]!.id, 5);    // B last (demoted)
});

test("demoteSupersededMemories: stale with higher raw score is still demoted below current", () => {
  // B has higher raw score than A, but B is stale.
  // B should end up below A after demotion.
  const candidates = [
    mkCandidate(5, 0.95, { supersededBy: [10] }),  // B stale but high score
    mkCandidate(10, 0.75, { supersedes: [5] }),   // A current
    mkCandidate(20, 0.70),                        // unrelated C
  ];
  const result = demoteSupersededMemories(candidates);
  // A (0.75) should be first even though B (0.95) had higher raw score.
  assert.equal(result[0]!.id, 10);   // A first
  assert.equal(result[1]!.id, 20);   // C second
  assert.equal(result[2]!.id, 5);    // B last
  assert.equal(result[2]!.score, 0.95 * DEMOTION_FACTOR);
});

// ---------------------------------------------------------------------------
// 2. Unrelated ranking order preserved
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: unrelated candidates preserve relative order", () => {
  // Three unrelated candidates with scores 0.8, 0.7, 0.6.
  // No demotion should occur.
  const candidates = [
    mkCandidate(1, 0.80),
    mkCandidate(2, 0.70),
    mkCandidate(3, 0.60),
  ];
  const result = demoteSupersededMemories(candidates);
  assert.deepEqual(result.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(result.map((r) => r.score), [0.80, 0.70, 0.60]);
});

test("demoteSupersededMemories: no relationship blocks -> no demotion", () => {
  // All candidates have no relationship metadata.
  const candidates = [
    mkCandidate(100, 0.90),
    mkCandidate(50, 0.80),
    mkCandidate(25, 0.70),
  ];
  const result = demoteSupersededMemories(candidates);
  assert.deepEqual(result.map((r) => r.id), [100, 50, 25]);
});

// ---------------------------------------------------------------------------
// 3. Missing references ignored
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: supersedes target not in candidate list -> no demotion", () => {
  // A supersedes B, but B is not in the candidate list.
  // No demotion should occur.
  const candidates = [
    mkCandidate(10, 0.80, { supersedes: [5, 99] }),  // A supersedes B(5) and C(99), neither present
    mkCandidate(20, 0.70),
  ];
  const result = demoteSupersededMemories(candidates);
  // No demotion; scores unchanged, order by score desc then id desc.
  assert.deepEqual(result.map((r) => ({ id: r.id, score: r.score })), [
    { id: 10, score: 0.80 },
    { id: 20, score: 0.70 },
  ]);
});

test("demoteSupersededMemories: supersededBy referrer not in candidate list -> no demotion", () => {
  // B is superseded by A and C, neither A nor C are in the candidate list.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10, 20] }),  // B stale, but referrers not present
    mkCandidate(30, 0.70),
  ];
  const result = demoteSupersededMemories(candidates);
  // No demotion since no superseding candidate is in the list.
  assert.deepEqual(result.map((r) => ({ id: r.id, score: r.score })), [
    { id: 5, score: 0.80 },
    { id: 30, score: 0.70 },
  ]);
});

// ---------------------------------------------------------------------------
// 4. Bidirectional supersession edges
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: A supersedes B, B supersededBy C -> B and A are not staleness partners", () => {
  // A supersedes B. C supersedes B. A and C are both in the list.
  // B is stale (supersededBy both A and C).
  // A and C are not stale (they supersede something, not superseded).
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10, 20] }),   // B is stale
    mkCandidate(10, 0.75, { supersedes: [5] }),         // A is current
    mkCandidate(20, 0.70, { supersedes: [5] }),        // C is also current
  ];
  const result = demoteSupersededMemories(candidates);
  // A and C stay, B is demoted.
  assert.equal(result[0]!.id, 10);   // A first (0.75)
  assert.equal(result[1]!.id, 20);   // C second (0.70)
  assert.equal(result[2]!.id, 5);    // B last (0.80 * 0.01)
});

// ---------------------------------------------------------------------------
// 5. Multiple supersession edges
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: two independent supersession pairs handled", () => {
  // Pair 1: A1 supersedes B1
  // Pair 2: A2 supersedes B2
  // Both demotions should occur independently.
  const candidates = [
    mkCandidate(5, 0.90, { supersededBy: [10] }),    // B1 stale
    mkCandidate(10, 0.85, { supersedes: [5] }),      // A1 current
    mkCandidate(15, 0.80, { supersededBy: [20] }),   // B2 stale
    mkCandidate(20, 0.75, { supersedes: [15] }),     // A2 current
  ];
  const result = demoteSupersededMemories(candidates);
  // A1 (0.85) > A2 (0.75) > B1 (0.90*0.01) > B2 (0.80*0.01)
  assert.equal(result[0]!.id, 10);   // A1
  assert.equal(result[1]!.id, 20);   // A2
  assert.equal(result[2]!.id, 5);    // B1 demoted
  assert.equal(result[3]!.id, 15);   // B2 demoted
});

test("demoteSupersededMemories: chain supersession A->B->C", () => {
  // A supersedes B. B supersedes C. All three in list.
  // B is stale (supersededBy A). C is stale (supersededBy B).
  // A is current.
  const candidates = [
    mkCandidate(5, 0.70, { supersededBy: [10] }),    // C is stale
    mkCandidate(10, 0.80, { supersedes: [5], supersededBy: [15] }), // B is stale (supersededBy A)
    mkCandidate(15, 0.90, { supersedes: [10] }),    // A is current
  ];
  const result = demoteSupersededMemories(candidates);
  // A (0.90) > B (0.80 * 0.01) > C (0.70 * 0.01)
  assert.equal(result[0]!.id, 15);   // A first
  assert.equal(result[1]!.id, 10);   // B second (demoted)
  assert.equal(result[2]!.id, 5);    // C third (demoted)
});

// ---------------------------------------------------------------------------
// 6. Non-mutation
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: does not mutate the input array", () => {
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),
    mkCandidate(10, 0.75, { supersedes: [5] }),
  ];
  const original = candidates.map((c) => ({ ...c }));
  demoteSupersededMemories(candidates);
  // Input should be unchanged.
  assert.deepEqual(candidates, original);
});

test("demoteSupersededMemories: returns a new array", () => {
  const candidates = [mkCandidate(1, 0.80)];
  const result = demoteSupersededMemories(candidates);
  assert.notEqual(result, candidates);
});

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: same input -> same output", () => {
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),
    mkCandidate(10, 0.75, { supersedes: [5] }),
    mkCandidate(20, 0.70),
  ];
  const a = demoteSupersededMemories(candidates);
  const b = demoteSupersededMemories(candidates);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 8. Single candidate
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: single candidate -> no demotion", () => {
  const candidates = [mkCandidate(5, 0.80, { supersededBy: [10] })];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, 5);
  assert.equal(result[0]!.score, 0.80);
});

test("demoteSupersededMemories: two candidates but no supersession between them", () => {
  const candidates = [
    mkCandidate(1, 0.80),
    mkCandidate(2, 0.70),
  ];
  const result = demoteSupersededMemories(candidates);
  assert.deepEqual(result.map((r) => r.id), [1, 2]);
});

// ---------------------------------------------------------------------------
// 9. Empty array
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: empty array -> empty array", () => {
  const result = demoteSupersededMemories([]);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// 10. Malformed relationship data
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: malformed supersedes (non-number) -> safely ignored", () => {
  // A supersedes [5, "bad", null] - the bad entries are filtered.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),
    // @ts-expect-error — intentionally passing malformed data to test runtime safety
    mkCandidate(10, 0.75, { supersedes: [5, "bad", null, undefined] }),
  ];
  const result = demoteSupersededMemories(candidates);
  // Should not throw; B is demoted.
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 5);
});

test("demoteSupersededMemories: undefined relationship -> treated as no relationship", () => {
  const candidates = [
    { id: 5, score: 0.80 },                              // no relationship
    { id: 10, score: 0.75, relationship: undefined },     // explicitly undefined
    { id: 20, score: 0.70, relationship: { supersedes: [5] } }, // A supersedes B
  ];
  const result = demoteSupersededMemories(candidates as ScoredCandidateWithRelationship[]);
  // 20 supersedes 5, so 5 is demoted to ~0.008.
  // 10 (0.75) > 20 (0.70) > 5 (0.008).
  assert.equal(result[0]!.id, 10);  // 10 has highest score, no relationship
  assert.equal(result[0]!.score, 0.75);
  assert.equal(result[1]!.id, 20);  // 20 has second highest score
  assert.equal(result[1]!.score, 0.70);
  assert.equal(result[2]!.id, 5);   // 5 is demoted to last
  assert.equal(result[2]!.score, 0.80 * DEMOTION_FACTOR);
});

test("demoteSupersededMemories: NaN score -> preserved as-is", () => {
  const candidates = [
    { id: 5, score: NaN },
    { id: 10, score: 0.75 },
  ];
  const result = demoteSupersededMemories(candidates as ScoredCandidateWithRelationship[]);
  assert.ok(Number.isNaN(result[0]!.score));
  assert.equal(result[1]!.score, 0.75);
});

// ---------------------------------------------------------------------------
// 11. Score tie-breaking after demotion
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: demoted candidate loses tie to non-stale candidate", () => {
  // B (stale, 0.80) vs C (non-stale, 0.01). After demotion B=0.008.
  // C should win the tie.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),  // B stale
    mkCandidate(10, 0.75, { supersedes: [5] }),    // A current
    mkCandidate(20, 0.01),                          // C non-stale
  ];
  const result = demoteSupersededMemories(candidates);
  // A (0.75) > C (0.01) > B (0.008)
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 20);
  assert.equal(result[2]!.id, 5);
});

test("demoteSupersededMemories: multiple stale candidates sort by demoted score", () => {
  // B1 (0.95, stale) and B2 (0.90, stale). After demotion: 0.0095 vs 0.009.
  // B1 should still be ahead of B2 after demotion.
  const candidates = [
    mkCandidate(5, 0.95, { supersededBy: [10] }),   // B1 stale
    mkCandidate(15, 0.90, { supersededBy: [20] }),  // B2 stale
    mkCandidate(10, 0.75, { supersedes: [5] }),     // A1 current
    mkCandidate(20, 0.70, { supersedes: [15] }),    // A2 current
  ];
  const result = demoteSupersededMemories(candidates);
  // A1 (0.75) > A2 (0.70) > B1 (0.0095) > B2 (0.009)
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 20);
  assert.equal(result[2]!.id, 5);
  assert.equal(result[3]!.id, 15);
});

// ---------------------------------------------------------------------------
// 12. DEMOTION_FACTOR value
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: DEMOTION_FACTOR is 0.01", () => {
  assert.equal(DEMOTION_FACTOR, 0.01);
});

// ---------------------------------------------------------------------------
// 13. Self-supersession ignored
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: self-supersession (A supersedes A) -> ignored, no crash", () => {
  // A claims to supersede itself. The self-reference should be ignored.
  const candidates = [
    mkCandidate(10, 0.80, { supersedes: [10] }), // self-ref
  ];
  // Must not throw.
  const result = demoteSupersededMemories(candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, 10);
  assert.equal(result[0]!.score, 0.80); // unchanged
});

test("demoteSupersededMemories: self-supersededBy (A supersededBy A) -> ignored, no crash", () => {
  // A claims to be superseded by itself. The self-reference should be ignored.
  const candidates = [
    mkCandidate(10, 0.80, { supersededBy: [10] }), // self-ref
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, 10);
  assert.equal(result[0]!.score, 0.80); // unchanged
});

test("demoteSupersededMemories: self-supersession with other valid supersession", () => {
  // A supersedes both B and itself. The self-ref is treated as a real supersession
  // edge (A supersedes A means A is stale). Both A and B are demoted.
  // After demotion: B=0.008, A=0.0075. B wins (higher demoted score).
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),   // B is superseded by A
    mkCandidate(10, 0.75, { supersedes: [5, 10] }), // A supersedes B AND self
  ];
  const result = demoteSupersededMemories(candidates);
  // Both demoted; B (0.008) > A (0.0075) because score desc.
  assert.equal(result[0]!.id, 5);   // B first: 0.80 * 0.01 = 0.008
  assert.equal(result[0]!.score, 0.80 * DEMOTION_FACTOR);
  assert.equal(result[1]!.id, 10);  // A second: 0.75 * 0.01 = 0.0075
  assert.equal(result[1]!.score, 0.75 * DEMOTION_FACTOR);
});

// ---------------------------------------------------------------------------
// 14. Duplicate edges harmless
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: duplicate supersedes entries -> B demoted once", () => {
  // A supersedes B twice (duplicate in the array). B should be demoted once.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),       // B stale
    mkCandidate(10, 0.75, { supersedes: [5, 5, 5] }),    // A supersedes B (duplicate)
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);   // A first
  assert.equal(result[1]!.id, 5);    // B demoted
  assert.equal(result[1]!.score, 0.80 * DEMOTION_FACTOR);
});

test("demoteSupersededMemories: duplicate supersededBy entries -> B demoted once", () => {
  // B is superseded by A twice. B should be demoted once.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10, 10] }),   // B stale (duplicate)
    mkCandidate(10, 0.75, { supersedes: [5] }),         // A current
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);   // A first
  assert.equal(result[1]!.id, 5);    // B demoted
  assert.equal(result[1]!.score, 0.80 * DEMOTION_FACTOR);
});

test("demoteSupersededMemories: both supersedes and supersededBy duplicate -> correct demotion", () => {
  // Mixed duplicate entries.
  const candidates = [
    mkCandidate(5, 0.90, { supersededBy: [10, 10] }),   // B stale (duplicate)
    mkCandidate(10, 0.75, { supersedes: [5, 5] }),      // A supersedes B (duplicate)
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);   // A first
  assert.equal(result[1]!.id, 5);    // B demoted
  assert.equal(result[1]!.score, 0.90 * DEMOTION_FACTOR);
});

// ---------------------------------------------------------------------------
// 15. Malformed / missing relationship data ignored
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: supersedes with non-finite number -> safely ignored", () => {
  // NaN and Infinity in the supersedes array.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),
    mkCandidate(10, 0.75, { supersedes: [5, NaN, Infinity, -Infinity] }),
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 5);
  assert.equal(result[1]!.score, 0.80 * DEMOTION_FACTOR);
});

test("demoteSupersededMemories: supersededBy with non-finite numbers only -> no demotion", () => {
  // supersededBy contains only non-finite numbers (NaN, Infinity, -Infinity).
  // None are valid superseding ids, so no demotion occurs.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [NaN, Infinity, -Infinity] }),
    mkCandidate(10, 0.75),
  ];
  const result = demoteSupersededMemories(candidates);
  // No demotion; order by score desc (no tie): 0.80 > 0.75.
  assert.equal(result[0]!.id, 5);
  assert.equal(result[0]!.score, 0.80);
  assert.equal(result[1]!.id, 10);
  assert.equal(result[1]!.score, 0.75);
});

test("demoteSupersededMemories: empty supersedes array -> no action", () => {
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),
    mkCandidate(10, 0.75, { supersedes: [] }),
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 5);
});

test("demoteSupersededMemories: empty supersededBy array -> no action", () => {
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [] }),
    mkCandidate(10, 0.75, { supersedes: [5] }),
  ];
  const result = demoteSupersededMemories(candidates);
  // B has empty supersededBy, so it is NOT demoted
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 5);
});

test("demoteSupersededMemories: null in supersedes array -> safely ignored", () => {
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),
    // @ts-expect-error -- intentionally passing null to test runtime safety
    mkCandidate(10, 0.75, { supersedes: [5, null] }),
  ];
  const result = demoteSupersededMemories(candidates);
  assert.equal(result[0]!.id, 10);
  assert.equal(result[1]!.id, 5);
});

// ---------------------------------------------------------------------------
// 16. Unrelated ranking order preserved (additional coverage)
// ---------------------------------------------------------------------------

test("demoteSupersededMemories: unrelated candidates with ties broken by id desc", () => {
  // All unrelated. Ties on score should be broken by id desc.
  const candidates = [
    mkCandidate(1, 0.80),
    mkCandidate(2, 0.80),
    mkCandidate(3, 0.80),
  ];
  const result = demoteSupersededMemories(candidates);
  // id desc -> 3, 2, 1
  assert.deepEqual(result.map((r) => r.id), [3, 2, 1]);
  assert.deepEqual(result.map((r) => r.score), [0.80, 0.80, 0.80]);
});

test("demoteSupersededMemories: supersession does not affect non-stale tie-breaking", () => {
  // A supersedes B. C has same score as A. A and C tie on score; id desc wins.
  const candidates = [
    mkCandidate(5, 0.80, { supersededBy: [10] }),   // B stale
    mkCandidate(10, 0.75, { supersedes: [5] }),     // A current
    mkCandidate(20, 0.75),                           // C unrelated
  ];
  const result = demoteSupersededMemories(candidates);
  // A (0.75) and C (0.75) tie on score; id desc -> C(20) > A(10) > B(0.008)
  assert.equal(result[0]!.id, 20);   // C first (id desc tiebreak)
  assert.equal(result[1]!.id, 10);   // A second
  assert.equal(result[2]!.id, 5);    // B last (demoted)
});
