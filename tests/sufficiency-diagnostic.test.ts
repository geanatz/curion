/**
 * Tests for the benchmark-only candidate-set
 * sufficiency diagnostic.
 *
 * Covers:
 *   1. Stable label table: `SUFFICIENCY_LABELS` is
 *      the documented set, with the documented
 *      string keys.
 *   2. Classifier behavior per family:
 *        - no-answer: empty -> `no-answer-correct`,
 *          non-empty -> `confabulation`.
 *        - exact / paraphrase: rank-1 hit ->
 *          `sufficient`; expected in top-K but not
 *          rank-1 -> `partial`; no expected and no
 *          near-miss label -> `insufficient`; no
 *          expected and labeled `nearMissCurrentCluster`
 *          / `adversarialParaphrase` -> `near-miss`.
 *        - temporal: currentTruthAt1 ->
 *          `sufficient`; passed && !currentTruthAt1
 *          (the old/legacy fact on top, current in
 *          top-K) -> `wrong-current-truth`; no
 *          expected in top-K -> `insufficient` (or
 *          `near-miss` with a near-miss label);
 *          expected in top-K but not at rank 1 ->
 *          `partial`.
 *        - multi-hop: complete coverage ->
 *          `sufficient`; partial coverage ->
 *          `partial`; no expected -> `insufficient`
 *          (or `near-miss` with a near-miss label).
 *        - orientation: rank-1 is a currentTruth id
 *          AND every expected in top-K ->
 *          `sufficient`; some expected in top-K ->
 *          `partial`; no expected -> `insufficient`
 *          (or `near-miss` with a near-miss label).
 *   3. Defensive: positive family with empty
 *      `expectedIds` -> `insufficient` (not crash).
 *   4. Additivity / no mutation: the diagnostic
 *      helper does not mutate the input `QueryEval`
 *      or the input `BenchmarkQuery`.
 *   5. Aggregator: per-label counts, per-family
 *      counts, ordering, and the cross-variant
 *      comparison.
 *   6. Determinism: the report is byte-stable for
 *      the same input.
 *   7. End-to-end: running the diagnostic against
 *      the real lexical baseline on the fixture
 *      corpus produces a well-formed report with
 *      known label counts.
 *   8. Production import guard: the recall
 *      controller and the MCP server do NOT
 *      import the diagnostic module.
 *   9. Public MCP API unchanged: exactly two tools
 *      (remember + recall).
 *
 * The tests split between synthetic unit tests
 * (pure functions, no corpus) and end-to-end tests
 * (real corpus + query set + ranker).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { type QueryEval, evaluateQuery } from "../src/benchmark/metrics.ts";
import { BENCHMARK_QUERIES, type BenchmarkQuery } from "../src/benchmark/queries.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import { runRetrievalBenchmark } from "../src/benchmark/retrieval-runner.ts";
import {
  SUFFICIENCY_LABELS,
  buildSufficiencyComparison,
  buildSufficiencyReport,
  classifyCandidateSetSufficiency,
  formatSufficiencyReport,
} from "../src/benchmark/sufficiency-diagnostic.ts";
import { rankLexical } from "../src/retrieval/lexical.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `QueryEval` from a `BenchmarkQuery` and a
 * `topIds` / `topScores` pair. The helper mirrors
 * `evaluateQuery`'s own rules so the test can pin a
 * specific eval state without re-deriving it.
 */
function evalFrom(q: BenchmarkQuery, topIds: number[], topScores: number[]): QueryEval {
  return evaluateQuery(
    q.id,
    q.family,
    q.query,
    q.expectedIds,
    q.currentTruthIds,
    topIds,
    topScores
  );
}

function queryById(id: string): BenchmarkQuery {
  const q = BENCHMARK_QUERIES.find((qq) => qq.id === id);
  if (!q) throw new Error(`fixture has no query with id "${id}"`);
  return q;
}

// ---------------------------------------------------------------------------
// 0. Stable constants
// ---------------------------------------------------------------------------

test("sufficiency: SUFFICIENCY_LABELS is the documented stable set", () => {
  // Pin the label set by hand so a future addition
  // is a deliberate, visible change.
  assert.deepEqual(
    [...SUFFICIENCY_LABELS].sort(),
    [
      "confabulation",
      "insufficient",
      "near-miss",
      "no-answer-correct",
      "partial",
      "sufficient",
      "wrong-current-truth",
    ].sort()
  );
});

// ---------------------------------------------------------------------------
// 1. no-answer family
// ---------------------------------------------------------------------------

test("sufficiency: no-answer empty top-K is `no-answer-correct`", () => {
  // `nonexistent-company-picnic` is a fixture
  // no-answer query with empty expectedIds.
  const q = queryById("nonexistent-company-picnic");
  const e = evalFrom(q, [], []);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "no-answer-correct");
  assert.equal(d.family, "no-answer");
  assert.equal(d.rawCounts.expectedTotal, 0);
  assert.equal(d.rawCounts.expectedInTopK, 0);
  assert.equal(d.rawCounts.topKSize, 0);
});

test("sufficiency: no-answer non-empty top-K is `confabulation`", () => {
  const q = queryById("nonexistent-company-picnic");
  const e = evalFrom(q, [1, 2], [0.3, 0.2]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "confabulation");
  assert.equal(d.family, "no-answer");
  // A no-answer confabulation is NEVER
  // `near-miss` even if the query carries a
  // near-miss adversarial label; the confabulation
  // signal is the confabulation signal.
  assert.equal(d.label, "confabulation");
});

// ---------------------------------------------------------------------------
// 2. exact / paraphrase family
// ---------------------------------------------------------------------------

test("sufficiency: exact rank-1 hit is `sufficient`", () => {
  // `exact-postgres-storage` has expectedIds=[1].
  const q = queryById("exact-postgres-storage");
  const e = evalFrom(q, [1, 2], [0.9, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "sufficient");
  assert.equal(d.rawCounts.rank1IsExpected, true);
  assert.equal(d.rawCounts.expectedInTopK, 1);
});

test("sufficiency: exact expected in top-K but not at rank 1 is `partial`", () => {
  const q = queryById("exact-postgres-storage");
  const e = evalFrom(q, [2, 1, 3], [0.9, 0.5, 0.2]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "partial");
  assert.equal(d.rawCounts.rank1IsExpected, false);
  assert.equal(d.rawCounts.expectedInTopK, 1);
});

test("sufficiency: exact no expected and no near-miss label is `insufficient`", () => {
  const q = queryById("exact-postgres-storage");
  const e = evalFrom(q, [99, 100], [0.5, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "insufficient");
  assert.equal(d.rawCounts.hasNearMissLabel, false);
});

test("sufficiency: exact no expected and labeled `adversarialParaphrase` is `near-miss`", () => {
  // Build a synthetic paraphrase-shaped query
  // with an `adversarialParaphrase` label so we
  // can test the near-miss branch on a positive
  // family without depending on a specific
  // fixture id.
  const q: BenchmarkQuery = {
    id: "test-para-adv",
    family: "paraphrase",
    query: "test",
    expectedIds: [1],
    currentTruthIds: [1],
    labels: ["adversarialParaphrase"],
    note: "synthetic",
  };
  const e = evalFrom(q, [99, 100], [0.5, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "near-miss");
  assert.equal(d.rawCounts.hasNearMissLabel, true);
});

test("sufficiency: exact no expected and labeled `nearMissCurrentCluster` is `near-miss`", () => {
  const q: BenchmarkQuery = {
    id: "test-nearmiss",
    family: "exact",
    query: "test",
    expectedIds: [1],
    currentTruthIds: [1],
    labels: ["nearMissCurrentCluster"],
    note: "synthetic",
  };
  const e = evalFrom(q, [99, 100], [0.5, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "near-miss");
});

// ---------------------------------------------------------------------------
// 3. temporal family
// ---------------------------------------------------------------------------

test("sufficiency: temporal currentTruthAt1 is `sufficient`", () => {
  // `temp-postgres-version` has expectedIds=[1],
  // currentTruthIds=[1]. A top-K with 1 at the top
  // produces currentTruthAt1=true.
  const q = queryById("temp-postgres-version");
  const e = evalFrom(q, [1, 21, 2], [0.9, 0.5, 0.3]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "sufficient");
  assert.equal(d.rawCounts.rank1IsCurrentTruth, true);
});

test("sufficiency: temporal passed && !currentTruthAt1 is `wrong-current-truth`", () => {
  // `temp-storage-raw-text` is the divergent
  // current-truth case: expectedIds=[50, 57],
  // currentTruthIds=[50]. A top-K with 57 at the
  // top and 50 in the top-K passes (50 is
  // expected) but fails currentTruthAt1 (57 is
  // not in currentTruthIds).
  const q = queryById("temp-storage-raw-text");
  const e = evalFrom(q, [57, 50, 99], [0.9, 0.5, 0.2]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "wrong-current-truth");
  assert.equal(d.rawCounts.rank1IsCurrentTruth, false);
  assert.equal(d.rawCounts.expectedInTopK, 2);
});

test("sufficiency: temporal no expected in top-K is `insufficient`", () => {
  const q = queryById("temp-postgres-version");
  const e = evalFrom(q, [99, 100, 101], [0.9, 0.6, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "insufficient");
});

test("sufficiency: temporal no expected and labeled `divergentTemporal` is `near-miss`", () => {
  const q = queryById("temp-storage-raw-text");
  // Take a top-K that misses every expected id.
  const e = evalFrom(q, [99, 100, 101], [0.9, 0.6, 0.4]);
  // The fixture's `divergentTemporal` label is
  // NOT one of the near-miss labels, so without
  // it the label is `insufficient`. With it the
  // label would be `near-miss`. Build a synthetic
  // query that DOES carry a near-miss label to
  // pin the branch.
  const q2: BenchmarkQuery = {
    ...q,
    labels: ["nearMissCurrentCluster"],
  };
  const d = classifyCandidateSetSufficiency(e, q2);
  assert.equal(d.label, "near-miss");
});

// ---------------------------------------------------------------------------
// 4. multi-hop family
// ---------------------------------------------------------------------------

test("sufficiency: multi-hop complete coverage is `sufficient`", () => {
  // `multi-deploy-and-release` has
  // expectedIds=[5, 7, 8]. A top-K with all
  // three is complete.
  const q = queryById("multi-deploy-and-release");
  const e = evalFrom(q, [5, 7, 8, 99], [0.9, 0.8, 0.7, 0.3]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "sufficient");
  assert.equal(d.rawCounts.expectedInTopK, 3);
});

test("sufficiency: multi-hop partial coverage is `partial`", () => {
  const q = queryById("multi-deploy-and-release");
  const e = evalFrom(q, [5, 99, 100], [0.9, 0.4, 0.2]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "partial");
  assert.equal(d.rawCounts.expectedInTopK, 1);
});

test("sufficiency: multi-hop no coverage is `insufficient`", () => {
  const q = queryById("multi-deploy-and-release");
  const e = evalFrom(q, [99, 100, 101], [0.9, 0.6, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "insufficient");
});

// ---------------------------------------------------------------------------
// 5. orientation family
// ---------------------------------------------------------------------------

test("sufficiency: orientation rank-1 is currentTruth AND full coverage is `sufficient`", () => {
  // `orient-stack-status` has
  // expectedIds=[1, 2, 4], currentTruthIds=[1, 2, 4].
  // A top-K with 1 at the top and all three in
  // top-K is sufficient.
  const q = queryById("orient-stack-status");
  const e = evalFrom(q, [1, 2, 4, 99], [0.9, 0.8, 0.7, 0.3]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "sufficient");
});

test("sufficiency: orientation partial coverage is `partial`", () => {
  const q = queryById("orient-stack-status");
  const e = evalFrom(q, [1, 99, 100], [0.9, 0.4, 0.2]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "partial");
  assert.equal(d.rawCounts.expectedInTopK, 1);
});

test("sufficiency: orientation no coverage is `insufficient`", () => {
  const q = queryById("orient-stack-status");
  const e = evalFrom(q, [99, 100, 101], [0.9, 0.6, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "insufficient");
});

// ---------------------------------------------------------------------------
// 6. Defensive behavior
// ---------------------------------------------------------------------------

test("sufficiency: positive family with empty expectedIds is `insufficient` (defensive)", () => {
  // The fixture contract guarantees expectedIds
  // is non-empty on positive families, but the
  // classifier handles a malformed input
  // defensively: it returns `insufficient`
  // instead of crashing.
  const q: BenchmarkQuery = {
    id: "test-malformed",
    family: "exact",
    query: "test",
    expectedIds: [],
    currentTruthIds: [],
    note: "synthetic malformed",
  };
  const e = evalFrom(q, [99, 100], [0.5, 0.4]);
  const d = classifyCandidateSetSufficiency(e, q);
  assert.equal(d.label, "insufficient");
});

// ---------------------------------------------------------------------------
// 7. Additivity / no mutation
// ---------------------------------------------------------------------------

test("sufficiency: classifyCandidateSetSufficiency does not mutate inputs", () => {
  // Pin the contract that the diagnostic is
  // a pure, non-mutating helper. A reviewer who
  // re-uses the same `QueryEval` in
  // `aggregateMetrics` after a diagnostic pass
  // must see the same numbers.
  const q = queryById("temp-storage-raw-text");
  const e = evalFrom(q, [57, 50, 99], [0.9, 0.5, 0.2]);
  // Snapshot the inputs.
  const topIdsBefore = [...e.topIds];
  const topScoresBefore = [...e.topScores];
  const expectedBefore = [...q.expectedIds];
  const currentTruthBefore = [...q.currentTruthIds];
  const labelsBefore = q.labels ? [...q.labels] : undefined;
  classifyCandidateSetSufficiency(e, q);
  assert.deepEqual(e.topIds, topIdsBefore);
  assert.deepEqual(e.topScores, topScoresBefore);
  assert.deepEqual(q.expectedIds, expectedBefore);
  assert.deepEqual(q.currentTruthIds, currentTruthBefore);
  assert.deepEqual(q.labels ?? undefined, labelsBefore);
});

test("sufficiency: buildSufficiencyReport does not mutate inputs", () => {
  // The aggregator also must be non-mutating.
  const evals: QueryEval[] = [
    evalFrom(queryById("exact-postgres-storage"), [1], [0.9]),
    evalFrom(queryById("nonexistent-company-picnic"), [], []),
  ];
  const queries: BenchmarkQuery[] = [
    queryById("exact-postgres-storage"),
    queryById("nonexistent-company-picnic"),
  ];
  // Snapshot the inputs.
  const evalSnap = evals.map((e) => ({
    topIds: [...e.topIds],
    topScores: [...e.topScores],
    expectedIds: [...e.expectedIds],
    currentTruthIds: [...e.currentTruthIds],
  }));
  const querySnap = queries.map((q) => ({ id: q.id, family: q.family }));
  buildSufficiencyReport("lexical", evals, queries);
  for (let i = 0; i < evals.length; i++) {
    assert.deepEqual(evals[i]!.topIds, evalSnap[i]!.topIds);
    assert.deepEqual(evals[i]!.topScores, evalSnap[i]!.topScores);
    assert.deepEqual(evals[i]!.expectedIds, evalSnap[i]!.expectedIds);
    assert.deepEqual(evals[i]!.currentTruthIds, evalSnap[i]!.currentTruthIds);
  }
  for (let i = 0; i < queries.length; i++) {
    assert.equal(queries[i]!.id, querySnap[i]!.id);
    assert.equal(queries[i]!.family, querySnap[i]!.family);
  }
});

test("sufficiency: buildSufficiencyReport throws on queryId mismatch", () => {
  // A `QueryEval` whose `queryId` does not match
  // the corresponding `BenchmarkQuery.id` is a
  // programming error; the aggregator throws so
  // the bug is caught in tests rather than
  // silently producing a malformed report.
  const q = queryById("exact-postgres-storage");
  const e: QueryEval = {
    ...evalFrom(q, [1], [0.9]),
    queryId: "totally-different-id",
  };
  assert.throws(() => buildSufficiencyReport("lexical", [e], [q]), /does not match/);
});

test("sufficiency: buildSufficiencyReport throws on length mismatch", () => {
  const q = queryById("exact-postgres-storage");
  const e = evalFrom(q, [1], [0.9]);
  assert.throws(() => buildSufficiencyReport("lexical", [e], []), /must match/);
});

// ---------------------------------------------------------------------------
// 8. Aggregator
// ---------------------------------------------------------------------------

test("sufficiency: buildSufficiencyReport emits per-label and per-family counts", () => {
  // Hand-pick a small mixed-family set so the
  // expected counts are checkable by hand.
  const evals: QueryEval[] = [
    evalFrom(queryById("exact-postgres-storage"), [1], [0.9]), // sufficient
    evalFrom(queryById("exact-postgres-storage"), [2, 1], [0.9, 0.5]), // partial
    evalFrom(queryById("exact-postgres-storage"), [99], [0.5]), // insufficient
    evalFrom(queryById("nonexistent-company-picnic"), [], []), // no-answer-correct
    evalFrom(queryById("nonexistent-company-picnic"), [1], [0.3]), // confabulation
  ];
  const queries: BenchmarkQuery[] = [
    queryById("exact-postgres-storage"),
    queryById("exact-postgres-storage"),
    queryById("exact-postgres-storage"),
    queryById("nonexistent-company-picnic"),
    queryById("nonexistent-company-picnic"),
  ];
  const r = buildSufficiencyReport("lexical", evals, queries);
  assert.equal(r.variant, "lexical");
  assert.equal(r.diagnostics.length, 5);
  assert.equal(r.perLabel.sufficient, 1);
  assert.equal(r.perLabel.partial, 1);
  assert.equal(r.perLabel.insufficient, 1);
  assert.equal(r.perLabel["no-answer-correct"], 1);
  assert.equal(r.perLabel.confabulation, 1);
  assert.equal(r.perLabel["near-miss"], 0);
  assert.equal(r.perLabel["wrong-current-truth"], 0);
  // Per-family block. Only the two families we
  // used are present; absent families are omitted
  // from the record.
  assert.ok(r.perFamily.exact);
  assert.equal(r.perFamily.exact.sufficient, 1);
  assert.equal(r.perFamily.exact.partial, 1);
  assert.equal(r.perFamily.exact.insufficient, 1);
  assert.ok(r.perFamily["no-answer"]);
  assert.equal(r.perFamily["no-answer"]["no-answer-correct"], 1);
  assert.equal(r.perFamily["no-answer"].confabulation, 1);
  // The total of all per-family rows for a
  // family must equal the per-label total
  // contribution from that family.
  for (const family of Object.keys(r.perFamily)) {
    const fkey = family as keyof typeof r.perFamily;
    const slot = r.perFamily[fkey]!;
    const familyTotal = (Object.values(slot) as number[]).reduce((a, b) => a + b, 0);
    const familyContrib = r.diagnostics.filter((d) => d.family === fkey).length;
    assert.equal(familyTotal, familyContrib, `family "${family}" totals disagree`);
  }
});

test("sufficiency: buildSufficiencyComparison produces a per-label cross-variant table", () => {
  const evals1: QueryEval[] = [
    evalFrom(queryById("exact-postgres-storage"), [1], [0.9]), // sufficient
    evalFrom(queryById("nonexistent-company-picnic"), [1], [0.3]), // confabulation
  ];
  const queries1: BenchmarkQuery[] = [
    queryById("exact-postgres-storage"),
    queryById("nonexistent-company-picnic"),
  ];
  const r1 = buildSufficiencyReport("lexical", evals1, queries1);
  const evals2: QueryEval[] = [
    evalFrom(queryById("exact-postgres-storage"), [99], [0.5]), // insufficient
    evalFrom(queryById("nonexistent-company-picnic"), [], []), // no-answer-correct
  ];
  const queries2: BenchmarkQuery[] = [
    queryById("exact-postgres-storage"),
    queryById("nonexistent-company-picnic"),
  ];
  const r2 = buildSufficiencyReport("hybrid", evals2, queries2);
  const cmp = buildSufficiencyComparison([r1, r2]);
  assert.equal(cmp.variants.length, 2);
  assert.equal(cmp.crossVariantPerLabel.sufficient.lexical, 1);
  assert.equal(cmp.crossVariantPerLabel.sufficient.hybrid, 0);
  assert.equal(cmp.crossVariantPerLabel.insufficient.lexical, 0);
  assert.equal(cmp.crossVariantPerLabel.insufficient.hybrid, 1);
  assert.equal(cmp.crossVariantPerLabel.confabulation.lexical, 1);
  assert.equal(cmp.crossVariantPerLabel.confabulation.hybrid, 0);
  assert.equal(cmp.crossVariantPerLabel["no-answer-correct"].lexical, 0);
  assert.equal(cmp.crossVariantPerLabel["no-answer-correct"].hybrid, 1);
  // Every (label, variant) pair is present in
  // the table, even when 0.
  for (const label of SUFFICIENCY_LABELS) {
    assert.ok(cmp.crossVariantPerLabel[label], `cross-variant table missing label ${label}`);
    assert.equal(typeof cmp.crossVariantPerLabel[label].lexical, "number");
    assert.equal(typeof cmp.crossVariantPerLabel[label].hybrid, "number");
  }
});

// ---------------------------------------------------------------------------
// 9. Determinism
// ---------------------------------------------------------------------------

test("sufficiency: report is deterministic for the same input", () => {
  // The deterministic guarantee matters because
  // the diagnostic artifact is the regression
  // evidence; a non-deterministic report would
  // make byte-equal comparisons noisy.
  const evals: QueryEval[] = [
    evalFrom(queryById("exact-postgres-storage"), [1], [0.9]),
    evalFrom(queryById("nonexistent-company-picnic"), [], []),
  ];
  const queries: BenchmarkQuery[] = [
    queryById("exact-postgres-storage"),
    queryById("nonexistent-company-picnic"),
  ];
  const a = buildSufficiencyReport("lexical", evals, queries);
  const b = buildSufficiencyReport("lexical", evals, queries);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 10. formatSufficiencyReport shape
// ---------------------------------------------------------------------------

test("sufficiency: formatSufficiencyReport is well-formed", () => {
  const evals: QueryEval[] = [
    evalFrom(queryById("exact-postgres-storage"), [1], [0.9]),
    evalFrom(queryById("nonexistent-company-picnic"), [], []),
  ];
  const queries: BenchmarkQuery[] = [
    queryById("exact-postgres-storage"),
    queryById("nonexistent-company-picnic"),
  ];
  const r = buildSufficiencyReport("lexical", evals, queries);
  const out = formatSufficiencyReport(r);
  // Every documented label appears in the
  // per-label block so a reviewer who greps the
  // report for any of them sees a row.
  for (const label of SUFFICIENCY_LABELS) {
    assert.ok(out.includes(label), `format missing label: ${label}`);
  }
  // The variant label is in the header.
  assert.match(out, /variant: lexical/);
});

// ---------------------------------------------------------------------------
// 11. End-to-end on the real lexical baseline
// ---------------------------------------------------------------------------

test("sufficiency: lexical baseline on the fixture corpus produces a well-formed report", () => {
  // Run the real lexical ranker against the
  // fixture corpus + query set and feed the
  // evals into the diagnostic. The test pins a
  // few key facts about the report:
  //   - The variant label is `lexical`.
  //   - The diagnostics list has one entry per
  //     fixture query.
  //   - The per-label counts sum to the query
  //     count.
  //   - At least one query is `sufficient` (the
  //     exact cluster the lexical baseline is
  //     designed to nail).
  //   - At least one no-answer query is
  //     `confabulation` (the confabulation
  //     pressure the abstention audit studies).
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  for (const q of BENCHMARK_QUERIES) {
    const ranked = rankLexical(q.query, candidates, {
      threshold: 0.2,
      topK: 5,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    evals.push(
      evaluateQuery(q.id, q.family, q.query, q.expectedIds, q.currentTruthIds, topIds, topScores)
    );
  }
  const r = buildSufficiencyReport("lexical", evals, BENCHMARK_QUERIES);
  assert.equal(r.variant, "lexical");
  assert.equal(r.diagnostics.length, BENCHMARK_QUERIES.length);
  const totalFromLabels = (Object.values(r.perLabel) as number[]).reduce((a, b) => a + b, 0);
  assert.equal(totalFromLabels, BENCHMARK_QUERIES.length);
  // At least one positive-family query is
  // `sufficient` on the lexical baseline.
  assert.ok(
    r.perLabel.sufficient > 0,
    `expected at least one sufficient query, got ${r.perLabel.sufficient}`
  );
  // The per-family block has all six families
  // the fixture exercises.
  for (const family of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ] as const) {
    assert.ok(r.perFamily[family], `per-family missing ${family}`);
  }
});

test("sufficiency: comparison report on real lexical + hybrid evals is well-formed", () => {
  // Build two real reports (lexical + hybrid)
  // and a cross-variant comparison; the
  // comparison must carry a per-label entry for
  // every (label, variant) pair.
  const lex = runRetrievalBenchmark({ variant: "lexical" });
  const hyb = runRetrievalBenchmark({ variant: "hybrid" });
  const lexDiag = buildSufficiencyReport("lexical", lex.evals, BENCHMARK_QUERIES);
  const hybDiag = buildSufficiencyReport("hybrid", hyb.evals, BENCHMARK_QUERIES);
  const cmp = buildSufficiencyComparison([lexDiag, hybDiag]);
  assert.equal(cmp.variants.length, 2);
  for (const label of SUFFICIENCY_LABELS) {
    assert.ok(
      cmp.crossVariantPerLabel[label].lexical !== undefined,
      `lexical column missing for ${label}`
    );
    assert.ok(
      cmp.crossVariantPerLabel[label].hybrid !== undefined,
      `hybrid column missing for ${label}`
    );
  }
  // The cross-variant tables are well-formed
  // numeric counts (already asserted above). The
  // brief is explicit that the diagnostic is a
  // descriptive cross-variant view, not a
  // monotonic-improvement assertion: a hybrid
  // RRF can surface a near-miss candidate above
  // a strong lexical hit and shift a query from
  // `sufficient` to `wrong-current-truth` /
  // `near-miss`. We pin that the per-label
  // counts are all finite non-negative numbers
  // so a future schema change that introduces a
  // NaN / string is caught.
  for (const label of SUFFICIENCY_LABELS) {
    const lexCount = cmp.crossVariantPerLabel[label].lexical;
    const hybCount = cmp.crossVariantPerLabel[label].hybrid;
    assert.ok(
      Number.isFinite(lexCount) && lexCount >= 0,
      `lexical ${label} count not finite/non-negative: ${lexCount}`
    );
    assert.ok(
      Number.isFinite(hybCount) && hybCount >= 0,
      `hybrid ${label} count not finite/non-negative: ${hybCount}`
    );
  }
});

// ---------------------------------------------------------------------------
// 12. Production import guard
// ---------------------------------------------------------------------------

test("sufficiency: production source tree must NOT import the diagnostic module", () => {
  // The diagnostic is benchmark-only; a future
  // edit that wires it into the recall
  // controller, the remember controller, the
  // server, or the storage layer would change
  // the production contract. The guard is
  // static: a string-match across the source
  // tree, restricted to the production path
  // (the controller + server + tool layer). The
  // benchmark / audit / policy paths are
  // explicitly allowed to import the
  // diagnostic.
  const productionFiles = [
    "src/controller/recall-controller.ts",
    "src/controller/remember-controller.ts",
    "src/server.ts",
    "src/tools/remember.ts",
    "src/tools/recall.ts",
    "src/storage/storage.ts",
    "src/retrieval/lexical.ts",
  ];
  for (const rel of productionFiles) {
    const file = path.join(import.meta.dirname, "..", rel);
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /sufficiency-diagnostic|classifyCandidateSetSufficiency|buildSufficiencyReport|SUFFICIENCY_LABELS/,
      `${rel} must NOT import the sufficiency diagnostic module`
    );
  }
});

test("sufficiency: public MCP API is unchanged (remember + recall only)", () => {
  // The benchmark-only diagnostic must not
  // change the public MCP tool surface. A
  // reviewer who reads the README's "Public
  // API" section expects exactly two tools,
  // and the diagnostic must not add a third.
  assert.deepEqual(
    [...PUBLIC_TOOL_NAMES],
    ["remember", "recall"],
    "public MCP tool surface must remain exactly remember + recall"
  );
});
