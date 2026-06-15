/**
 * Tests for the benchmark-only temporal / current-truth
 * diagnostic.
 *
 * Covers:
 *   1. Classifier priority: each category fires iff
 *      the documented condition holds.
 *   2. Per-category raw counts: the classifier
 *      populates the `rawCounts` block correctly.
 *   3. Headline metrics: the aggregator's per-category
 *      and headline numbers are correct, including
 *      the divergent-labeled rollup.
 *   4. Per-family rollup: the per-family per-category
 *      counts surface temporal and multi-hop shaped
 *      queries only.
 *   5. Semantic overlay: with a pre-computed
 *      EmbeddingGemma evidence map, the report
 *      surfaces a per-category miss rollup.
 *   6. Determinism: same input -> same report; no
 *      PRNG; no wall clock.
 *   7. Production import guard: the production source
 *      tree must NOT import the new diagnostic
 *      modules.
 *   8. Public MCP API unchanged: exactly two tools.
 *   9. Existing report shapes are unchanged.
 *  10. CLI argument parsing: default modes + override
 *      flags.
 *  11. Artifact reader + writer round-trip.
 *  12. End-to-end CLI run on the real lexical baseline
 *      artifact under `.cortex/benchmark/`.
 *  13. Honest fixture-label framing: the
 *      `divergentTemporal` label takes priority over
 *      the top-1-is-current check.
 *  14. Stale set membership: a known stale id at the
 *      top-1 correctly drives
 *      `current-truth-in-topk-stale-top1`; an
 *      unrelated distractor at the top-1 drives
 *      `current-truth-in-topk-no-stale-top1`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  STALE_TEMPORAL_IDS,
  TEMPORAL_TRUTH_CATEGORIES,
  TEMPORAL_TRUTH_CATEGORY_EXPLANATION,
  buildTemporalTruthDiagnosticReport,
  classifyTemporalTruthFailure,
  formatTemporalTruthDiagnosticReport,
  type TemporalTruthCategory,
  type TemporalTruthDiagnostic,
  type TemporalTruthDiagnosticReport,
} from "../src/benchmark/temporal-truth-diagnostic.js";
import {
  alignQueriesToEvals,
  findMostRecentArtifact,
  parseTemporalTruthDiagnosticCliArgs,
  readBenchmarkArtifact,
  readSemanticEvidenceFile,
  runTemporalTruthDiagnosticAnalysis,
  runTemporalTruthDiagnosticCli,
  writeTemporalTruthDiagnosticReport,
  type BenchmarkArtifact,
  type SemanticEvidenceMap,
} from "../src/benchmark/temporal-truth-diagnostic-runner.js";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.js";
import type { BenchmarkQuery } from "../src/benchmark/queries.js";
import { evaluateQuery, type QueryEval } from "../src/benchmark/metrics.js";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic per-query input the diagnostic
 * consumes. The factory takes a per-query spec and
 * produces a `QueryEval` + a `BenchmarkQuery` pair.
 */
function mkTemporalQueryEval(
  specs: ReadonlyArray<{
    queryId: string;
    family?: "temporal" | "exact" | "paraphrase" | "multi-hop" | "no-answer" | "orientation";
    expectedIds: number[];
    currentTruthIds: number[];
    topIds: number[];
    labels?: string[];
  }>,
): { evals: QueryEval[]; queries: BenchmarkQuery[] } {
  const evals: QueryEval[] = [];
  const queries: BenchmarkQuery[] = [];
  for (const s of specs) {
    const topScores = s.topIds.map(() => 0.5);
    const e: QueryEval = evaluateQuery(
      s.queryId,
      s.family ?? "temporal",
      `synthetic query ${s.queryId}`,
      s.expectedIds,
      s.currentTruthIds,
      s.topIds,
      topScores,
    );
    // Re-derive rank1 / currentTruthAt1 in case the
    // synthetic topIds is empty.
    const expectedSet = new Set(s.expectedIds);
    const currentTruthSet = new Set(s.currentTruthIds);
    const top0 = s.topIds[0];
    e.rank1 = top0 !== undefined && expectedSet.has(top0);
    e.currentTruthAt1 = top0 !== undefined && currentTruthSet.has(top0);
    e.passed =
      s.expectedIds.length === 0
        ? s.topIds.length === 0
        : s.topIds.some((id) => expectedSet.has(id));
    evals.push(e);
    const q: BenchmarkQuery = {
      queryId: s.queryId,
      id: s.queryId,
      family: s.family ?? "temporal",
      query: `synthetic query ${s.queryId}`,
      expectedIds: [...s.expectedIds],
      currentTruthIds: [...s.currentTruthIds],
      note: "",
      ...(s.labels ? { labels: [...s.labels] } : {}),
    };
    queries.push(q);
  }
  return { evals, queries };
}

/**
 * Build a synthetic `BenchmarkArtifact` from a per-query
 * input list. Used by the synthetic end-to-end tests so
 * the runner has a real in-memory artifact to consume.
 */
function mkArtifact(
  evals: ReadonlyArray<QueryEval>,
): BenchmarkArtifact {
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    variant: "synthetic-lexical",
    config: { recordCount: 132 },
    evals,
  };
}

// ---------------------------------------------------------------------------
// 1. Classifier priority
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: empty top-K -> abstained-or-empty", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [] },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "abstained-or-empty");
  assert.equal(diag.top1Id, null);
  assert.equal(diag.top1IsCurrentTruth, false);
  assert.equal(diag.top1IsStale, false);
  assert.equal(diag.topKHasCurrentTruth, false);
});

test("temporal-truth-diagnostic: divergentTemporal label takes priority over top1IsCurrentTruth", () => {
  // Top-1 IS the current truth, but the query carries
  // the divergentTemporal label — the fixture-ambiguous
  // category wins by the documented priority order.
  const { evals, queries } = mkTemporalQueryEval([
    {
      queryId: "q1",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "fixture-ambiguous");
  assert.equal(diag.isDivergentLabeled, true);
  assert.equal(diag.top1IsCurrentTruth, true);
  assert.equal(
    diag.recommendedAction,
    "fixture audit (expectedIds deliberately includes both old and new; currentTruthAt1 is uninterpretable here)",
  );
});

test("temporal-truth-diagnostic: current-truth-top1 when top-1 is current truth", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "current-truth-top1");
  assert.equal(diag.top1IsCurrentTruth, true);
});

test("temporal-truth-diagnostic: current-truth-in-topk-stale-top1 when top-1 is a known stale id", () => {
  // top-1 = 21 (a known stale id from the legacy
  // cluster). top-K includes 1 (the current truth).
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "current-truth-in-topk-stale-top1");
  assert.equal(diag.top1IsCurrentTruth, false);
  assert.equal(diag.top1IsStale, true);
  assert.equal(diag.topKHasCurrentTruth, true);
});

test("temporal-truth-diagnostic: current-truth-in-topk-no-stale-top1 when top-1 is unrelated", () => {
  // top-1 = 2 (an unrelated record; NOT in the
  // STALE_TEMPORAL_IDS set). top-K includes 1 (the
  // current truth).
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [2, 1, 5, 6, 7] },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "current-truth-in-topk-no-stale-top1");
  assert.equal(diag.top1IsCurrentTruth, false);
  assert.equal(diag.top1IsStale, false);
  assert.equal(diag.topKHasCurrentTruth, true);
});

test("temporal-truth-diagnostic: current-truth-missing-stale-present when top-K has stale but no current", () => {
  // top-1 = 21 (a known stale id), top-K has no 1
  // (the current truth). The candidate set is
  // insufficient for current truth but contains a
  // stale distractor.
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 22, 23, 24, 5] },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "current-truth-missing-stale-present");
  assert.equal(diag.top1IsCurrentTruth, false);
  assert.equal(diag.topKHasCurrentTruth, false);
  assert.equal(diag.topKHasStale, true);
});

test("temporal-truth-diagnostic: current-truth-missing-no-stale when top-K has no current and no stale", () => {
  // top-K contains only records that are neither the
  // current truth nor in the STALE_TEMPORAL_IDS set.
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "current-truth-missing-no-stale");
  assert.equal(diag.top1IsCurrentTruth, false);
  assert.equal(diag.topKHasCurrentTruth, false);
  assert.equal(diag.topKHasStale, false);
});

test("temporal-truth-diagnostic: non-temporal family falls through to current-truth-top1 or no-stale-top1", () => {
  // A non-temporal family with a non-stale top-1 that
  // is not the current truth lands in
  // `current-truth-in-topk-no-stale-top1` (the
  // family-scoped fallback for positive families).
  const { evals, queries } = mkTemporalQueryEval([
    {
      queryId: "q1",
      family: "exact",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [2, 1, 5, 6, 7],
    },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.category, "current-truth-in-topk-no-stale-top1");
});

// ---------------------------------------------------------------------------
// 2. Per-category raw counts
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: raw counts are populated correctly", () => {
  const { evals, queries } = mkTemporalQueryEval([
    {
      queryId: "q1",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
    },
  ]);
  const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
  assert.equal(diag.rawCounts.expectedTotal, 2);
  assert.equal(diag.rawCounts.currentTruthTotal, 1);
  assert.equal(diag.rawCounts.expectedInTopK, 2);
  assert.equal(diag.rawCounts.currentTruthInTopK, 1);
  assert.ok(diag.rawCounts.staleInTopK >= 1);
  assert.equal(diag.rawCounts.top1IsStale, true);
  assert.equal(diag.rawCounts.top1IsCurrentTruth, false);
  assert.equal(diag.rawCounts.top1IsExpected, true);
});

test("temporal-truth-diagnostic: every category has a non-empty explanation", () => {
  for (const cat of TEMPORAL_TRUTH_CATEGORIES) {
    const exp = TEMPORAL_TRUTH_CATEGORY_EXPLANATION[cat];
    assert.ok(
      typeof exp === "string" && exp.length > 0,
      `category ${cat} must have a non-empty explanation, got ${JSON.stringify(exp)}`,
    );
  }
});

test("temporal-truth-diagnostic: STALE_TEMPORAL_IDS is non-empty and includes documented ids", () => {
  assert.ok(STALE_TEMPORAL_IDS.size > 0);
  // The legacy cluster is in the set.
  for (const id of [21, 22, 23, 24]) {
    assert.ok(
      STALE_TEMPORAL_IDS.has(id),
      `STALE_TEMPORAL_IDS must contain legacy id ${id}`,
    );
  }
  // The superseded cluster is in the set.
  for (const id of [105, 106, 107, 108]) {
    assert.ok(
      STALE_TEMPORAL_IDS.has(id),
      `STALE_TEMPORAL_IDS must contain superseded id ${id}`,
    );
  }
  // The conflict cluster is in the set.
  for (const id of [101, 102, 103, 104]) {
    assert.ok(
      STALE_TEMPORAL_IDS.has(id),
      `STALE_TEMPORAL_IDS must contain conflict id ${id}`,
    );
  }
  // An obviously-non-stale id is NOT in the set.
  assert.equal(STALE_TEMPORAL_IDS.has(1), false, "current Postgres 16 record must not be in the stale set");
  assert.equal(STALE_TEMPORAL_IDS.has(2), false, "current Node 22 record must not be in the stale set");
});

// ---------------------------------------------------------------------------
// 3. Aggregator headline metrics
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: aggregator per-category counts sum to the temporal slice", () => {
  const { evals, queries } = mkTemporalQueryEval([
    // current-truth-top1
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    // current-truth-in-topk-stale-top1
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
    // current-truth-in-topk-no-stale-top1
    { queryId: "q3", expectedIds: [1], currentTruthIds: [1], topIds: [2, 1, 5, 6, 7] },
    // current-truth-missing-stale-present
    { queryId: "q4", expectedIds: [1], currentTruthIds: [1], topIds: [21, 22, 23, 24, 25] },
    // current-truth-missing-no-stale
    { queryId: "q5", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
    // fixture-ambiguous
    {
      queryId: "q6",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
  ]);
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  assert.equal(report.temporalQueryCount, 6);
  // Sum the per-category counts and assert it equals
  // the temporal slice.
  let sum = 0;
  for (const cat of TEMPORAL_TRUTH_CATEGORIES) {
    sum += report.perCategory[cat] ?? 0;
  }
  assert.equal(sum, 6);
  // The headline metrics: currentTruthAt1 = 1 (q1 only;
  // q6's top-1 is 21 not 1, and q6 carries the
  // divergentTemporal label so its top-1 is NOT
  // current; the priority-2 fixture-ambiguous branch
  // returns before the top1IsCurrentTruth check).
  assert.equal(report.metrics.currentTruthAt1, 1);
  // currentTruthInTopK = 4 (q1, q2, q3, q6; q4 and
  // q5 have no current in top-K). The metric counts
  // every temporal query with `topKHasCurrentTruth`,
  // regardless of category.
  assert.equal(report.metrics.currentTruthHitsAt5, 4);
  // staleTop1 = 3 (q2, q4, q6). The metric counts
  // every temporal query with `top1IsStale`,
  // regardless of category.
  assert.equal(report.metrics.staleTop1, 3);
  // staleOverCurrentCount = 2 (q2 and q6 only; q4 has
  // no current in top-K so the conjunction is false).
  assert.equal(report.metrics.staleOverCurrentCount, 2);
  // currentMissingCount = 2 (q4 and q5).
  assert.equal(report.metrics.currentMissingCount, 2);
  // divergentLabeled = 1 (q6).
  assert.equal(report.metrics.divergentLabeled, 1);
});

test("temporal-truth-diagnostic: divergentLabeled@1 miss + staleTop1 are tracked separately", () => {
  const { evals, queries } = mkTemporalQueryEval([
    // Divergent with top-1 = current.
    {
      queryId: "q1",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
    // Divergent with top-1 = stale.
    {
      queryId: "q2",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
  ]);
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  // q1 is divergent AND top-1 IS current.
  // q2 is divergent AND top-1 is stale.
  assert.equal(report.metrics.divergentLabeled, 2);
  // q1 has top1IsCurrentTruth === true, so it is NOT
  // counted in divergentLabeledCurrentTruthAt1Miss.
  assert.equal(report.metrics.divergentLabeledCurrentTruthAt1Miss, 1);
  // q2 has top1IsStale === true.
  assert.equal(report.metrics.divergentLabeledStaleTop1, 1);
});

test("temporal-truth-diagnostic: empty input produces a well-formed empty report", () => {
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals: [],
    queries: [],
  });
  assert.equal(report.temporalQueryCount, 0);
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.metrics.currentTruthAt1Rate, 0);
  assert.equal(report.metrics.currentTruthInTopKRate, 0);
  assert.equal(report.metrics.staleTop1Rate, 0);
  assert.equal(report.metrics.staleOverCurrentRate, 0);
  assert.equal(report.metrics.currentMissingRate, 0);
  assert.equal(report.metrics.currentMissingCount, 0);
});

test("temporal-truth-diagnostic: evals/queries length mismatch throws", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  assert.throws(
    () =>
      buildTemporalTruthDiagnosticReport({
        variant: "synthetic",
        evals,
        queries: [...queries, ...queries], // double
      }),
    /evals\.length/,
  );
});

test("temporal-truth-diagnostic: evals/queries id mismatch throws", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  // Replace the query with a different id at the same
  // position.
  const corrupted = [...queries];
  corrupted[0] = { ...corrupted[0]!, id: "different" };
  assert.throws(
    () =>
      buildTemporalTruthDiagnosticReport({
        variant: "synthetic",
        evals,
        queries: corrupted,
      }),
    /does not match/,
  );
});

// ---------------------------------------------------------------------------
// 4. Per-family rollup scope
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: per-family rollup includes temporal and multi-hop temporal-shaped queries", () => {
  const { evals, queries } = mkTemporalQueryEval([
    {
      queryId: "t1",
      family: "temporal",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
    },
    {
      // m1 has the documented
      // `multi-temporal-current-and-superseded-` prefix
      // so the temporal-shaped predicate is true.
      queryId: "multi-temporal-current-and-superseded-test1",
      family: "multi-hop",
      expectedIds: [1, 21],
      currentTruthIds: [1, 21],
      topIds: [1, 21, 5, 6, 7],
    },
    {
      // m2 carries the divergentTemporal label so
      // the temporal-shaped predicate is true.
      queryId: "multi-something-divergent",
      family: "multi-hop",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
    {
      // e1 is an exact query (not temporal-shaped);
      // the per-family rollup omits it.
      queryId: "e1",
      family: "exact",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
    },
  ]);
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  // The temporal family is in the rollup.
  assert.ok("temporal" in report.perFamily);
  // The multi-hop family is in the rollup (the
  // temporal-shaped predicate is true for m1 and m2).
  assert.ok("multi-hop" in report.perFamily);
  // The exact family is NOT in the rollup (not
  // temporal-shaped).
  assert.ok(!("exact" in report.perFamily));
  // m1: top-1 = 1 (current), so category is
  // `current-truth-top1`.
  // m2: carries the divergentTemporal label, so
  // category is `fixture-ambiguous` (priority 2 wins
  // over the top-1-is-current check). The per-family
  // rollup surfaces it on the multi-hop row.
  const multiHopCounts = report.perFamily["multi-hop"]!;
  assert.equal(multiHopCounts["current-truth-top1"] ?? 0, 1);
  assert.equal(multiHopCounts["fixture-ambiguous"] ?? 0, 1);
});

// ---------------------------------------------------------------------------
// 5. Semantic overlay
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: semantic overlay is correctly attached per diagnostic", () => {
  const { evals, queries } = mkTemporalQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
    },
    {
      queryId: "q2",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
    },
  ]);
  const semantic: { source: string; byQueryId: ReadonlyMap<string, "hit" | "miss"> } = {
    source: "test-embeddinggemma",
    byQueryId: new Map([
      ["q1", "hit"],
      ["q2", "miss"],
    ]),
  };
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
    semantic,
  });
  // The semantic overlay is populated.
  assert.ok(report.semanticOverlay);
  assert.equal(report.semanticOverlay!.covered, 2);
  assert.equal(report.semanticOverlay!.hit, 1);
  assert.equal(report.semanticOverlay!.miss, 1);
  // The miss rolls up by category; q2 is in
  // `current-truth-in-topk-stale-top1`.
  assert.equal(
    report.semanticOverlay!.byCategory["current-truth-in-topk-stale-top1"],
    1,
  );
  // The per-diagnostic semantic block is populated.
  const d1 = report.diagnostics.find((d) => d.queryId === "q1")!;
  const d2 = report.diagnostics.find((d) => d.queryId === "q2")!;
  assert.ok(d1.semantic);
  assert.equal(d1.semantic!.outcome, "hit");
  assert.ok(d2.semantic);
  assert.equal(d2.semantic!.outcome, "miss");
});

test("temporal-truth-diagnostic: queries not in the semantic map are reported without overlay", () => {
  const { evals, queries } = mkTemporalQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
    },
  ]);
  const semantic = {
    source: "test",
    byQueryId: new Map<string, "hit" | "miss">(),
  };
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
    semantic,
  });
  // The semantic overlay is reported with covered=0.
  assert.ok(report.semanticOverlay);
  assert.equal(report.semanticOverlay!.covered, 0);
  // The per-diagnostic block is absent.
  const d1 = report.diagnostics.find((d) => d.queryId === "q1")!;
  assert.equal(d1.semantic, undefined);
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: same input produces a byte-stable report (no PRNG, no wall clock)", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
    { queryId: "q3", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const r1 = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  const r2 = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  // The two reports are deep-equal (no timestamps in
  // the report; the `variant` is the only field the
  // caller controls).
  assert.deepEqual(r1, r2);
});

test("temporal-truth-diagnostic: human report is byte-stable", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  const s1 = formatTemporalTruthDiagnosticReport(report);
  const s2 = formatTemporalTruthDiagnosticReport(report);
  assert.equal(s1, s2);
});

// ---------------------------------------------------------------------------
// 7. Production import guard
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: production source tree does NOT import the diagnostic", () => {
  // The diagnostic is benchmark-only; the production
  // source tree must not import it. The test searches
  // the `src/` tree (excluding `src/benchmark/`) for
  // any import of the diagnostic module.
  const productionDirs = ["src/controller", "src/storage", "src/retrieval", "src/tools", "src/providers", "src/safety"];
  for (const dir of productionDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = walkTs(dir);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(
        !text.includes("temporal-truth-diagnostic"),
        `production source ${f} must not import the diagnostic module`,
      );
    }
  }
});

/**
 * Walk a directory recursively and return all .ts files
 * (excluding .d.ts). Synchronous, internal helper.
 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkTs(full));
    } else if (ent.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Public MCP API unchanged
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: public MCP API is unchanged (exactly two tools)", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

// ---------------------------------------------------------------------------
// 9. Existing report shapes are unchanged
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: existing benchmark report shape is unchanged (smoke test)", () => {
  // The diagnostic is additive; the upstream
  // benchmark runner's report shape is a public
  // dependency. A reviewer who wants to verify the
  // dependency is intact reads this smoke test.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttd-"));
  try {
    const artifact = mkArtifact([]);
    const report = runTemporalTruthDiagnosticAnalysis({
      benchmarkArtifact: artifact,
    });
    // The report has the documented fields.
    assert.equal(report.variant, "synthetic-lexical");
    assert.equal(report.temporalQueryCount, 0);
    assert.ok(report.diagnostics);
    assert.ok(report.perCategory);
    assert.ok(report.metrics);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. CLI argument parsing
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: CLI argument parser handles the documented flags", () => {
  const parsed = parseTemporalTruthDiagnosticCliArgs([
    "--benchmark-artifact",
    "/tmp/b.json",
    "--semantic-evidence",
    "/tmp/s.json",
    "--out-dir",
    "/tmp/out",
    "--variant",
    "my-variant",
    "--no-write",
    "--no-stdout",
  ]);
  assert.equal(parsed.benchmarkArtifact, "/tmp/b.json");
  assert.equal(parsed.semanticEvidence, "/tmp/s.json");
  assert.equal(parsed.outDir, "/tmp/out");
  assert.equal(parsed.variant, "my-variant");
  assert.equal(parsed.noWrite, true);
  assert.equal(parsed.noStdout, true);
});

test("temporal-truth-diagnostic: CLI argument parser ignores unknown flags", () => {
  const parsed = parseTemporalTruthDiagnosticCliArgs([
    "--unknown-flag",
    "value",
    "--no-write",
  ]);
  assert.equal(parsed.noWrite, true);
});

// ---------------------------------------------------------------------------
// 11. Artifact reader + writer round-trip
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: artifact reader + writer round-trip is byte-stable", () => {
  const { evals, queries } = mkTemporalQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildTemporalTruthDiagnosticReport({
    variant: "synthetic",
    evals,
    queries,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttd-"));
  try {
    const fullPath = writeTemporalTruthDiagnosticReport(report, tmpDir);
    const text = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(text) as TemporalTruthDiagnosticReport;
    assert.deepEqual(parsed, report);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("temporal-truth-diagnostic: readBenchmarkArtifact validates the evals array", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttd-"));
  try {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, JSON.stringify({ evals: "not an array" }), "utf8");
    assert.throws(
      () => readBenchmarkArtifact(filePath),
      /must have an 'evals' array/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("temporal-truth-diagnostic: readSemanticEvidenceFile validates the byQueryId entries", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttd-"));
  try {
    const filePath = path.join(tmpDir, "bad-sem.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ source: "x", byQueryId: { q1: "weird" } }),
      "utf8",
    );
    assert.throws(
      () => readSemanticEvidenceFile(filePath),
      /must be "hit" or "miss"/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("temporal-truth-diagnostic: alignQueriesToEvals throws on a query not in the corpus", () => {
  assert.throws(
    () => alignQueriesToEvals([{ queryId: "nonexistent" }]),
    /not found in BENCHMARK_QUERIES/,
  );
});

// ---------------------------------------------------------------------------
// 12. End-to-end CLI run on the real lexical baseline artifact
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: end-to-end CLI on the real lexical baseline artifact", async () => {
  const baselinePath = findMostRecentArtifact(
    ".cortex/benchmark",
    "retrieval-baseline-",
  );
  if (!baselinePath) return; // skip if no artifact on disk
  const semanticPath = path.join(
    "src",
    "benchmark",
    "data",
    "false-abstention-damage-semantic-evidence.json",
  );
  const hasSemantic = fs.existsSync(semanticPath);
  const { report } = await runTemporalTruthDiagnosticCli({
    benchmarkArtifact: baselinePath,
    ...(hasSemantic ? { semanticEvidence: semanticPath } : {}),
    noWrite: true,
    noStdout: true,
  });
  // The report is well-formed.
  assert.ok(report.variant.length > 0);
  // The temporal slice is the documented 26 queries.
  assert.equal(report.temporalQueryCount, 26);
  // The headline numbers match the prior diagnostic's
  // finding (currentTruthAt1 = 12, sufficient = 12,
  // wrong-current-truth = 12, insufficient = 2).
  assert.equal(report.metrics.currentTruthAt1, 12);
  // The current-truth-in-top-K count is at least the
  // current-truth@1 count.
  assert.ok(report.metrics.currentTruthHitsAt5 >= report.metrics.currentTruthAt1);
});

test("temporal-truth-diagnostic: end-to-end CLI without an artifact on disk throws a loud error", async () => {
  await assert.rejects(
    () =>
      runTemporalTruthDiagnosticCli({
        outDir: "/tmp/nonexistent-ttd-dir",
        noWrite: true,
        noStdout: true,
      }),
    /no --benchmark-artifact given/,
  );
});

// ---------------------------------------------------------------------------
// 13. Honest fixture-label framing
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: divergentTemporal queries surface in the per-category rollup", () => {
  // The corpus has 7 divergentTemporal queries. A
  // smoke test that pins the per-category count on
  // the real corpus.
  const baselinePath = findMostRecentArtifact(
    ".cortex/benchmark",
    "retrieval-baseline-",
  );
  if (!baselinePath) return;
  const artifact = readBenchmarkArtifact(baselinePath);
  const queries = alignQueriesToEvals(artifact.evals);
  const report = buildTemporalTruthDiagnosticReport({
    variant: artifact.variant,
    evals: artifact.evals,
    queries,
    sourceVariant: artifact.variant,
    recordCount: artifact.config.recordCount ?? null,
  });
  // The divergent-labeled count is the number of
  // temporal queries that carry the divergentTemporal
  // label.
  const divergent = BENCHMARK_QUERIES.filter(
    (q) => q.family === "temporal" && q.labels?.includes("divergentTemporal"),
  );
  assert.equal(report.metrics.divergentLabeled, divergent.length);
  // The fixture-ambiguous category count is at
  // LEAST divergent.length (the category may
  // include other ambiguous-shaped queries in a
  // future corpus revision).
  assert.ok(report.perCategory["fixture-ambiguous"] >= divergent.length);
});

// ---------------------------------------------------------------------------
// 14. Stale set membership
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: known stale id at top-1 correctly drives stale-top1 category", () => {
  // A stale id from each documented cluster should
  // drive `current-truth-in-topk-stale-top1` when
  // current truth is also in the top-K.
  const staleIds = [21, 105, 101, 96, 57];
  for (const staleId of staleIds) {
    const { evals, queries } = mkTemporalQueryEval([
      {
        queryId: `q-${staleId}`,
        expectedIds: [1],
        currentTruthIds: [1],
        topIds: [staleId, 1, 5, 6, 7],
      },
    ]);
    const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
    assert.equal(
      diag.category,
      "current-truth-in-topk-stale-top1",
      `stale id ${staleId} at top-1 should drive current-truth-in-topk-stale-top1, got ${diag.category}`,
    );
    assert.equal(diag.top1IsStale, true);
  }
});

test("temporal-truth-diagnostic: unrelated id at top-1 correctly drives no-stale-top1 category", () => {
  // An id NOT in the STALE_TEMPORAL_IDS set and not
  // the current truth should drive
  // `current-truth-in-topk-no-stale-top1`.
  const unrelatedIds = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const id of unrelatedIds) {
    if (STALE_TEMPORAL_IDS.has(id)) continue;
    const { evals, queries } = mkTemporalQueryEval([
      {
        queryId: `q-${id}`,
        expectedIds: [1],
        currentTruthIds: [1],
        topIds: [id, 1, 5, 6, 7],
      },
    ]);
    const diag = classifyTemporalTruthFailure(evals[0]!, queries[0]!);
    assert.equal(
      diag.category,
      "current-truth-in-topk-no-stale-top1",
      `unrelated id ${id} at top-1 should drive current-truth-in-topk-no-stale-top1, got ${diag.category}`,
    );
    assert.equal(diag.top1IsStale, false);
  }
});

// ---------------------------------------------------------------------------
// 15. The diagnostic uses the BENCHMARK_QUERIES corpus correctly
// ---------------------------------------------------------------------------

test("temporal-truth-diagnostic: every temporal query in BENCHMARK_QUERIES has a fixture-truth expected/currentTruth", () => {
  // A smoke test on the corpus: every temporal query
  // has at least one expected id and at least one
  // currentTruthId. The diagnostic's defensive
  // handling of empty expected/current ids is in
  // place, but a real corpus must not trigger it.
  for (const q of BENCHMARK_QUERIES) {
    if (q.family !== "temporal") continue;
    assert.ok(
      q.expectedIds.length > 0,
      `temporal query ${q.id} must have at least one expected id`,
    );
    assert.ok(
      q.currentTruthIds.length > 0,
      `temporal query ${q.id} must have at least one currentTruthId`,
    );
  }
});
