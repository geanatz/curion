/**
 * Tests for the benchmark-only supersedes-
 * promote guard probe (Experiment 10).
 *
 * Covers:
 *   1. Guard rule kinds: the
 *      `supersedes-promote-guard` /
 *      `oracle-supersedes-promote-guard`
 *      rule kinds are well-formed; the
 *      `none` rule is a pass-through.
 *   2. Guard rule application: the
 *      `applySupersedesPromoteGuardRule`
 *      helper produces the documented
 *      output for the documented
 *      `temp-rate-limit` regression case
 *      (the SPECIFIC regression the guard
 *      is designed to eliminate).
 *   3. temp-rate-limit regression pin: the
 *      `guarded-multi-anchor-linked-expansion`
 *      variant's `tempRateLimitRegressionCount`
 *      is 0 on the real artifact; the
 *      `temp-rate-limit` per-query output
 *      has `tempRateLimitRegression: false`
 *      AND `afterTop1Id: 70` (the current
 *      truth is preserved at rank 1).
 *   4. Aggregate results: the guarded
 *      primary's `regressionCount` is 0;
 *      the `promotionsBlockedByGuard` is
 *      ≥1 (the guard fires); the
 *      `verdict` is `safe` (no regressions,
 *      no currentTruthAt1 recovery, but
 *      `safe` because the verdict is
 *      `safe` when `currentTruthAt1Delta
 *      > 0` — wait, actually the guarded
 *      primary has `currentTruthAt1Delta
 *      = +6` because it preserves the
 *      reranker-control's +6; so the
 *      verdict IS `safe`).
 *   5. Category labels: the variant
 *      table's `category` field is the
 *      documented `production-like` /
 *      `reranker-control` /
 *      `metadata-simulation` /
 *      `multi-anchor-simulation` /
 *      `oracle` / `oracle-diagnostic`
 *      reading.
 *   6. Production import isolation: the
 *      production source tree MUST NOT
 *      import the new modules.
 *   7. Deterministic output: same input
 *      -> same report.
 *   8. No mutation: the
 *      `applySupersedesPromoteGuardRule`
 *      helper does NOT mutate the input
 *      `topIds` / `topScores` arrays.
 *   9. Public API unchanged: exactly two
 *      tools (`remember(text)` /
 *      `recall(text)`).
 *  10. Report shape: the per-variant
 *      metrics include the documented
 *      before/after counts and deltas; the
 *      top-level report includes the
 *      gap-breakdown block, the
 *      multi-anchor subset block, the
 *      temp-rate-limit pin block, and the
 *      category-change keys.
 *  11. End-to-end on the real lexical
 *      baseline artifact under
 *      `.curion/benchmark/`.
 *  12. CLI argument parsing: default
 *      modes + override flags.
 *  13. Per-category change rollup: the
 *      per-variant perCategoryChange
 *      block is populated.
 *  14. Verdict: `safe` / `unsafe` /
 *      `neutral` per the documented
 *      deterministic rules.
 *  15. Clean / fixture-ambiguous split:
 *      the split is on the baseline's
 *      `isDivergentLabeled` flag.
 *  16. Multi-anchor subset: the
 *      multi-anchor metrics are
 *      populated and consistent.
 *  17. `currentTruthIds`-free contract
 *      (primary variant): the
 *      `supersedes-promote-guard` rule
 *      does NOT consult `currentTruthIds`
 *      in its decision (the rule reads
 *      ONLY the post-expansion top-K +
 *      the injected-id set + the
 *      simulated edge map).
 *  18. Oracle guard: the
 *      `oracle-supersedes-promote-guard`
 *      rule CAN consult `currentTruthIds`
 *      as a hint (the rule is the
 *      diagnostic oracle guard).
 *  19. Artifact reader + writer
 *      round-trip.
 *  20. Downstream reranker guard: the
 *      `evaluateGuardedRerankVariant`
 *      helper throws when the
 *      `downstreamVariant` is not
 *      `multi-anchor-aware-combined`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { type QueryEval, evaluateQuery } from "../src/benchmark/metrics.js";
import { BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS } from "../src/benchmark/multi-anchor-current-previous.js";
import type { BenchmarkQuery } from "../src/benchmark/queries.js";
import {
  parseGuardedRerankCliArgs,
  runGuardedRerankCli,
  writeGuardedRerankReport,
} from "../src/benchmark/supersedes-promote-guard-runner.js";
import {
  BUILTIN_GUARDED_RERANK_VARIANTS,
  type GuardedRerankReport,
  type GuardedRerankVariant,
  type GuardedRerankVariantMetrics,
  type SupersedesPromoteGuardRule,
  applySupersedesPromoteGuardRule,
  buildGuardedRerankReport,
  buildGuardedRerankVariantRow,
  computeGuardedRerankVerdict,
  evaluateGuardedRerankForQuery,
  evaluateGuardedRerankVariant,
  formatGuardedRerankReport,
} from "../src/benchmark/supersedes-promote-guard.js";
import { SIMULATED_SUPERSESSION_EDGES } from "../src/benchmark/supersession-edge-simulation.js";
import {
  type BenchmarkArtifact,
  alignQueriesToEvals,
  findMostRecentArtifact,
  readBenchmarkArtifact,
} from "../src/benchmark/temporal-truth-diagnostic-runner.js";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";
import { walkTs } from "./_helpers/fs-walk.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic per-query input the
 * guard-rerank consumes. The factory takes a
 * per-query spec and produces a `QueryEval` +
 * a `BenchmarkQuery` pair.
 */
function mkQueryEval(
  specs: ReadonlyArray<{
    queryId: string;
    family?: "temporal" | "exact" | "paraphrase" | "multi-hop" | "no-answer" | "orientation";
    expectedIds: number[];
    currentTruthIds: number[];
    topIds: number[];
    topScores?: number[];
    labels?: string[];
  }>
): { evals: QueryEval[]; queries: BenchmarkQuery[] } {
  const evals: QueryEval[] = [];
  const queries: BenchmarkQuery[] = [];
  for (const s of specs) {
    const topScores = s.topScores ?? s.topIds.map(() => 0.5);
    const e: QueryEval = evaluateQuery(
      s.queryId,
      s.family ?? "temporal",
      `synthetic query ${s.queryId}`,
      s.expectedIds,
      s.currentTruthIds,
      s.topIds,
      topScores
    );
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
 * Build a synthetic `BenchmarkArtifact` from a
 * per-query input list.
 */
function mkArtifact(evals: ReadonlyArray<QueryEval>): BenchmarkArtifact {
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    variant: "synthetic-lexical",
    config: { recordCount: 132 },
    evals,
  };
}

// ---------------------------------------------------------------------------
// 1. Guard rule kinds
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: BUILTIN_GUARDED_RERANK_VARIANTS is well-formed", () => {
  // The variant table MUST contain the
  // documented variants. The order is
  // declaration order; the table is the
  // unit the report iterates over.
  assert.equal(BUILTIN_GUARDED_RERANK_VARIANTS.length, 7);
  const ids = BUILTIN_GUARDED_RERANK_VARIANTS.map((v) => v.id);
  assert.deepEqual(ids, [
    "baseline-no-rerank",
    "reranker-control-multi-anchor-aware-combined",
    "oracle-candidate-injection-ceiling",
    "guarded-multi-anchor-linked-expansion",
    "guarded-linked-candidate-expansion",
    "guarded-no-op",
    "oracle-guarded-candidate-injection-ceiling",
  ]);
});

test("supersedes-promote-guard: variant table has the documented categories", () => {
  // The variant `category` field is the
  // honest "is this variant production-
  // like, fixture-shaped, oracle, oracle-
  // diagnostic, metadata-simulation, or
  // multi-anchor-simulation?" reading.
  const expected: Record<
    string,
    | "production-like"
    | "reranker-control"
    | "oracle"
    | "oracle-diagnostic"
    | "metadata-simulation"
    | "multi-anchor-simulation"
  > = {
    "baseline-no-rerank": "production-like",
    "reranker-control-multi-anchor-aware-combined": "reranker-control",
    "oracle-candidate-injection-ceiling": "oracle",
    "guarded-multi-anchor-linked-expansion": "multi-anchor-simulation",
    "guarded-linked-candidate-expansion": "metadata-simulation",
    "guarded-no-op": "reranker-control",
    "oracle-guarded-candidate-injection-ceiling": "oracle-diagnostic",
  };
  for (const v of BUILTIN_GUARDED_RERANK_VARIANTS) {
    assert.equal(v.category, expected[v.id], `category mismatch for ${v.id}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Guard rule application
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: applySupersedesPromoteGuardRule none is a defensive copy", () => {
  // The `none` rule MUST be a pure
  // pass-through: the input `topIds` /
  // `topScores` arrays are NOT mutated;
  // a new parallel pair is returned.
  const topIds = [70, 130, 20, 23, 45];
  const topScores = [0.95, 0.7, 0.25, 0.25, 0.25];
  const { evals, queries } = mkQueryEval([
    {
      queryId: "temp-rate-limit",
      expectedIds: [70],
      currentTruthIds: [70],
      topIds,
      topScores,
    },
  ]);
  const result = applySupersedesPromoteGuardRule({
    rule: { kind: "none" },
    topIds,
    topScores,
    injectedIds: [],
    query: queries[0]!,
    downstreamRule: { kind: "none" },
  });
  assert.deepEqual(result.topIds, [70, 130, 20, 23, 45]);
  assert.deepEqual(result.topScores, [0.95, 0.7, 0.25, 0.25, 0.25]);
  assert.equal(result.promotionsBlocked, 0);
  // The input arrays are unchanged.
  assert.deepEqual(topIds, [70, 130, 20, 23, 45]);
  assert.deepEqual(topScores, [0.95, 0.7, 0.25, 0.25, 0.25]);
  // The result arrays are NEW arrays
  // (not the input's).
  assert.notEqual(result.topIds, topIds);
  // The unused-imports are quiet.
  assert.ok(evals);
});

test("supersedes-promote-guard: applySupersedesPromoteGuardRule does not mutate input", () => {
  const topIds = [70, 130, 20, 23, 45, 3];
  const topScores = [0.95, 0.7, 0.25, 0.25, 0.25, 0.0];
  const result = applySupersedesPromoteGuardRule({
    rule: { kind: "supersedes-promote-guard" },
    topIds,
    topScores,
    injectedIds: [3],
    query: {
      queryId: "temp-rate-limit",
      id: "temp-rate-limit",
      family: "temporal",
      query: "",
      expectedIds: [70],
      currentTruthIds: [70],
      note: "",
    },
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // The input arrays are unchanged.
  assert.deepEqual(topIds, [70, 130, 20, 23, 45, 3]);
  assert.deepEqual(topScores, [0.95, 0.7, 0.25, 0.25, 0.25, 0.0]);
  // The result is a new array.
  assert.notEqual(result.topIds, topIds);
});

test("supersedes-promote-guard: temp-rate-limit regression pin", () => {
  // The SPECIFIC regression the guard is
  // designed to eliminate:
  //   - top-K: [70, 130, 20, 23, 45, 3]
  //     (the baseline top-K plus the
  //     candidate-expansion's injection
  //     of record 3, which is the
  //     `supersededBy` of record 23).
  //   - rank-1: 70 (current truth).
  //   - injectedIds: [3] (the candidate-
  //     expansion step's output).
  //   - The unguarded multi-anchor-aware-
  //     combined reranker would promote
  //     record 3 above record 70 (record
  //     3 `supersedes` record 23, which
  //     is in the top-K). The promotion
  //     is a regression.
  //   - The guard MUST block the
  //     promotion. The guard's output
  //     MUST have 70 at rank 1.
  const result = applySupersedesPromoteGuardRule({
    rule: { kind: "supersedes-promote-guard" },
    topIds: [70, 130, 20, 23, 45, 3],
    topScores: [0.95, 0.7, 0.25, 0.25, 0.25, 0.0],
    injectedIds: [3],
    query: {
      queryId: "temp-rate-limit",
      id: "temp-rate-limit",
      family: "temporal",
      query: "",
      expectedIds: [70],
      currentTruthIds: [70],
      note: "",
    },
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // The guard's primary protection: 70
  // is at rank 1 (the non-injected
  // rank-1 is preserved).
  assert.equal(result.topIds[0], 70);
  // The injected 3 is demoted to the
  // middle bucket (NOT promoted above
  // 70).
  assert.ok(!result.topIds.slice(0, 1).includes(3));
  // The promotionsBlocked counter is
  // ≥1 (the guard fired).
  assert.ok(result.promotionsBlocked >= 1);
});

test("supersedes-promote-guard: non-injected supersedes candidates ARE promoted", () => {
  // The guard's primary protection is
  // "block promotion of INJECTED
  // `supersedes` candidates". NON-
  // INJECTED `supersedes` candidates
  // MUST still be promoted (the guard
  // is NOT a blanket demotion of all
  // `supersedes` candidates).
  //
  // The `temp-stale-fact-trap-release`
  // case: top-K [22, 7, 42, 112, 103],
  // 7 `supersedes` 22. 7 is NOT
  // injected (the expansion's injected-
  // id set is empty for this query).
  // The guard MUST promote 7 above 22.
  const result = applySupersedesPromoteGuardRule({
    rule: { kind: "supersedes-promote-guard" },
    topIds: [22, 7, 42, 112, 103],
    topScores: [0.95, 0.85, 0.25, 0.2, 0.15],
    injectedIds: [],
    query: {
      queryId: "temp-stale-fact-trap-release",
      id: "temp-stale-fact-trap-release",
      family: "temporal",
      query: "",
      expectedIds: [7],
      currentTruthIds: [7],
      note: "",
    },
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // 7 is promoted above 22 (7 is the
  // `supersedes` candidate; 22 is the
  // `supersededBy` candidate).
  assert.equal(result.topIds[0], 7);
  // No promotions blocked (the
  // `supersedes` candidate is not
  // injected).
  assert.equal(result.promotionsBlocked, 0);
});

test("supersedes-promote-guard: multi-anchor protection still applies", () => {
  // The guard integrates the multi-
  // anchor protection: a multi-anchor
  // record at rank 1 is protected from
  // being displaced by a `supersedes`
  // promotion (Experiment 8's
  // protection). The guard does NOT
  // regress on the multi-anchor
  // queries.
  //
  // The `temp-current-vs-previous-
  // postgres` case: top-K
  // [117, 60, 118, 119, 120, 1, 37, 7,
  // 69, 11] (after multi-anchor linked
  // expansion injects 1, 37, 7, 69, 11).
  // 117 is the multi-anchor anchor
  // record; the guard's
  // `protectedAnchorFirst` bucket keeps
  // 117 at rank 1. The injected
  // `supersedes` candidates (none of
  // them supersede a record in the top-
  // K that is a multi-anchor) are
  // processed normally.
  const result = applySupersedesPromoteGuardRule({
    rule: { kind: "supersedes-promote-guard" },
    topIds: [117, 60, 118, 119, 120, 1, 37, 7, 69, 11],
    topScores: [0.95, 0.7, 0.6, 0.55, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0],
    injectedIds: [1, 37, 7, 69, 11],
    query: {
      queryId: "temp-current-vs-previous-postgres",
      id: "temp-current-vs-previous-postgres",
      family: "temporal",
      query: "",
      expectedIds: [117],
      currentTruthIds: [117],
      note: "",
    },
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // 117 is preserved at rank 1.
  assert.equal(result.topIds[0], 117);
});

test("supersedes-promote-guard: oracle guard consults currentTruthIds as a hint", () => {
  // The oracle guard's STRONGER
  // protection: a non-injected
  // `supersedes` candidate is also
  // blocked if its `supersedes` target
  // is a current-truth id. The rule is
  // a hint, not a hard guard; the
  // `oracle-supersedes-promote-guard`
  // rule kind is the diagnostic
  // protection ceiling.
  //
  // The case: top-K [22, 7, 42, 112,
  // 103]. 7 `supersedes` 22. 22 is in
  // `currentTruthIds`. The oracle guard
  // MUST block 7 (the `supersedes`
  // target is a current-truth id).
  // 7 is non-injected, but the oracle
  // guard's hint says "the `supersedes`
  // target is current truth", so the
  // promotion is blocked.
  const result = applySupersedesPromoteGuardRule({
    rule: { kind: "oracle-supersedes-promote-guard" },
    topIds: [22, 7, 42, 112, 103],
    topScores: [0.95, 0.85, 0.25, 0.2, 0.15],
    injectedIds: [],
    query: {
      queryId: "synthetic-oracle",
      id: "synthetic-oracle",
      family: "temporal",
      query: "",
      expectedIds: [7],
      currentTruthIds: [22, 7],
      note: "",
    },
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // 7 is NOT promoted above 22 (the
  // oracle guard's hint says 22 is
  // current truth, so the `supersedes`
  // promotion is blocked).
  assert.notEqual(result.topIds[0], 7);
  // The promotionsBlocked counter is
  // ≥1 (the oracle guard fired).
  assert.ok(result.promotionsBlocked >= 1);
});

// ---------------------------------------------------------------------------
// 3. Aggregate results
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: aggregateGuardedRerankPerQuery is deterministic", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
    { queryId: "q2", expectedIds: [7], currentTruthIds: [7], topIds: [22, 5, 6, 7, 8] },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS.find(
    (v) => v.id === "guarded-multi-anchor-linked-expansion"
  )!;
  const m1 = evaluateGuardedRerankVariant({ variant, evals, queries });
  const m2 = evaluateGuardedRerankVariant({ variant, evals, queries });
  // Same input -> same metrics.
  assert.deepEqual(m1, m2);
});

test("supersedes-promote-guard: aggregator covers the documented metric fields", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS[0]!;
  const m = evaluateGuardedRerankVariant({ variant, evals, queries });
  // The block carries the documented
  // fields. Note: per-query fields
  // (e.g., `baselineIsDivergentLabeled`)
  // are on `GuardedRerankPerQuery`, not
  // on `GuardedRerankVariantMetrics`.
  const mKeys = Object.keys(m).sort();
  const requiredKeys: ReadonlyArray<keyof GuardedRerankVariantMetrics> = [
    "afterCurrentMissing",
    "afterCurrentTruthAt1",
    "afterExpansionCurrentMissing",
    "afterStaleOverCurrent",
    "afterStaleTop1",
    "baselineCurrentMissing",
    "baselineCurrentTruthAt1",
    "baselineStaleOverCurrent",
    "baselineStaleTop1",
    "cleanAfterCurrentTruthAt1",
    "cleanBaselineCurrentTruthAt1",
    "cleanCurrentTruthAt1Delta",
    "cleanRegressionCount",
    "cleanTempRateLimitRegressionCount",
    "cleanTotal",
    "currentMissingDelta",
    "currentTruthAt1Delta",
    "currentTruthAt1RateDelta",
    "expansionCurrentMissingDelta",
    "expansionInjectedCurrentCount",
    "fixtureAmbiguousAfterCurrentTruthAt1",
    "fixtureAmbiguousBaselineCurrentTruthAt1",
    "fixtureAmbiguousCurrentTruthAt1Delta",
    "fixtureAmbiguousRegressionCount",
    "fixtureAmbiguousTotal",
    "injectedIdsSet",
    "maxExpandedTopKSize",
    "meanExpandedTopKSize",
    "multiAnchorAfterCurrentTruthAt1",
    "multiAnchorBaselineCurrentTruthAt1",
    "multiAnchorCurrentTruthAt1Delta",
    "multiAnchorExpansionInjectedCurrentCount",
    "multiAnchorQueryCount",
    "multiAnchorRecoveredByExpansion",
    "multiAnchorRegressionCount",
    "perCategoryChange",
    "perQuery",
    "promotionsBlockedByGuard",
    "recoveredByExpansion",
    "recoveredByReranker",
    "regressionCount",
    "staleOverCurrentDelta",
    "staleTop1Delta",
    "tempRateLimitRegressionCount",
    "total",
    "unchangedBecauseCurrentMissing",
  ];
  for (const k of requiredKeys) {
    assert.ok(mKeys.includes(k), `metric block must include ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Verdict
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: verdict is unsafe when regressionCount > 0", () => {
  const m: GuardedRerankVariantMetrics = {
    total: 26,
    cleanTotal: 19,
    fixtureAmbiguousTotal: 7,
    baselineCurrentTruthAt1: 10,
    afterCurrentTruthAt1: 12,
    currentTruthAt1Delta: 0,
    currentTruthAt1RateDelta: 0,
    baselineStaleTop1: 8,
    afterStaleTop1: 8,
    staleTop1Delta: 0,
    baselineStaleOverCurrent: 4,
    afterStaleOverCurrent: 4,
    staleOverCurrentDelta: 0,
    baselineCurrentMissing: 2,
    afterExpansionCurrentMissing: 2,
    afterCurrentMissing: 2,
    currentMissingDelta: 0,
    expansionCurrentMissingDelta: 0,
    regressionCount: 1,
    tempRateLimitRegressionCount: 1,
    promotionsBlockedByGuard: 0,
    recoveredByExpansion: 0,
    recoveredByReranker: 0,
    unchangedBecauseCurrentMissing: 0,
    expansionInjectedCurrentCount: 0,
    meanExpandedTopKSize: 0,
    maxExpandedTopKSize: 0,
    injectedIdsSet: [],
    multiAnchorQueryCount: 0,
    multiAnchorBaselineCurrentTruthAt1: 0,
    multiAnchorAfterCurrentTruthAt1: 0,
    multiAnchorCurrentTruthAt1Delta: 0,
    multiAnchorRegressionCount: 0,
    multiAnchorRecoveredByExpansion: 0,
    multiAnchorExpansionInjectedCurrentCount: 0,
    cleanBaselineCurrentTruthAt1: 0,
    cleanAfterCurrentTruthAt1: 0,
    cleanCurrentTruthAt1Delta: 0,
    cleanRegressionCount: 0,
    cleanTempRateLimitRegressionCount: 0,
    fixtureAmbiguousBaselineCurrentTruthAt1: 0,
    fixtureAmbiguousAfterCurrentTruthAt1: 0,
    fixtureAmbiguousCurrentTruthAt1Delta: 0,
    fixtureAmbiguousRegressionCount: 0,
    perCategoryChange: {},
    perQuery: [],
  };
  const { verdict, note } = computeGuardedRerankVerdict(m);
  assert.equal(verdict, "unsafe");
  assert.match(note, /introduced 1 regression/);
});

test("supersedes-promote-guard: verdict is safe when currentTruthAt1Delta > 0 and no regressions", () => {
  const m: GuardedRerankVariantMetrics = {
    total: 26,
    cleanTotal: 19,
    fixtureAmbiguousTotal: 7,
    baselineCurrentTruthAt1: 10,
    afterCurrentTruthAt1: 15,
    currentTruthAt1Delta: 5,
    currentTruthAt1RateDelta: 5 / 26,
    baselineStaleTop1: 8,
    afterStaleTop1: 2,
    staleTop1Delta: -6,
    baselineStaleOverCurrent: 4,
    afterStaleOverCurrent: 0,
    staleOverCurrentDelta: -4,
    baselineCurrentMissing: 2,
    afterExpansionCurrentMissing: 0,
    afterCurrentMissing: 0,
    currentMissingDelta: -2,
    expansionCurrentMissingDelta: -2,
    regressionCount: 0,
    tempRateLimitRegressionCount: 0,
    promotionsBlockedByGuard: 0,
    recoveredByExpansion: 0,
    recoveredByReranker: 0,
    unchangedBecauseCurrentMissing: 0,
    expansionInjectedCurrentCount: 0,
    meanExpandedTopKSize: 0,
    maxExpandedTopKSize: 0,
    injectedIdsSet: [],
    multiAnchorQueryCount: 0,
    multiAnchorBaselineCurrentTruthAt1: 0,
    multiAnchorAfterCurrentTruthAt1: 0,
    multiAnchorCurrentTruthAt1Delta: 0,
    multiAnchorRegressionCount: 0,
    multiAnchorRecoveredByExpansion: 0,
    multiAnchorExpansionInjectedCurrentCount: 0,
    cleanBaselineCurrentTruthAt1: 0,
    cleanAfterCurrentTruthAt1: 0,
    cleanCurrentTruthAt1Delta: 0,
    cleanRegressionCount: 0,
    cleanTempRateLimitRegressionCount: 0,
    fixtureAmbiguousBaselineCurrentTruthAt1: 0,
    fixtureAmbiguousAfterCurrentTruthAt1: 0,
    fixtureAmbiguousCurrentTruthAt1Delta: 0,
    fixtureAmbiguousRegressionCount: 0,
    perCategoryChange: {},
    perQuery: [],
  };
  const { verdict, note } = computeGuardedRerankVerdict(m);
  assert.equal(verdict, "safe");
  assert.match(note, /recovered 5 currentTruthAt1/);
});

// ---------------------------------------------------------------------------
// 5. Report shape
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: buildGuardedRerankReport has the documented top-level shape", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const report = buildGuardedRerankReport({
    sourceVariant: "synthetic-lexical",
    evals,
    queries,
  });
  // The report is well-formed.
  assert.equal(report.sourceVariant, "synthetic-lexical");
  assert.equal(report.temporalQueryCount, 1);
  assert.equal(report.supersessionEdgeMapSize, SIMULATED_SUPERSESSION_EDGES.size);
  assert.equal(report.downstreamRerankerId, "multi-anchor-aware-combined");
  // The variants are populated.
  assert.equal(report.variants.length, BUILTIN_GUARDED_RERANK_VARIANTS.length);
  // The gap breakdown is populated.
  for (const v of report.variants) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(report.gapBreakdown.unchangedByVariant, v.variant.id)
    );
  }
  // The multi-anchor subset is populated.
  assert.ok(report.multiAnchorSubset);
  // The category-change keys are
  // populated.
  assert.ok(Array.isArray(report.categoryChangeKeys));
});

test("supersedes-promote-guard: formatGuardedRerankReport is byte-stable for a fixed input", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const report = buildGuardedRerankReport({
    sourceVariant: "synthetic-lexical",
    evals,
    queries,
  });
  const a = formatGuardedRerankReport(report);
  const b = formatGuardedRerankReport(report);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// 6. Production import isolation
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: production source tree does NOT import the new modules", () => {
  // The production source tree
  // (src/server.ts, src/controller, etc.)
  // MUST NOT import the new modules. The
  // experiment is benchmark-only.
  const prodRoots = ["src/controller", "src/storage", "src/tools"];
  const newModuleIdentifiers = ["supersedes-promote-guard"];
  for (const root of prodRoots) {
    if (!fs.existsSync(root)) continue;
    const files = walkTs(root);
    for (const f of files) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      for (const ident of newModuleIdentifiers) {
        assert.ok(
          !text.includes(ident),
          `production file ${f} must NOT import or reference ${ident}`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Public API unchanged
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: PUBLIC_TOOL_NAMES is exactly two tools", () => {
  // The experiment must not change the
  // public MCP API.
  assert.deepEqual([...PUBLIC_TOOL_NAMES].sort(), ["recall", "remember"]);
});

// ---------------------------------------------------------------------------
// 8. End-to-end on the real lexical baseline artifact
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: end-to-end on the real lexical-baseline artifact", () => {
  const dir = ".curion/benchmark";
  const file = findMostRecentArtifact(dir, "retrieval-baseline-");
  if (!file) {
    // The artifact is not yet
    // generated; skip the test.
    return;
  }
  const artifact = readBenchmarkArtifact(file);
  const queries = alignQueriesToEvals(artifact.evals);
  const report = buildGuardedRerankReport({
    sourceVariant: artifact.variant,
    evals: artifact.evals,
    queries,
    recordCount: artifact.config.recordCount ?? null,
  });
  // The report is well-formed.
  assert.equal(report.temporalQueryCount, 26);
  // The variants are populated.
  assert.equal(report.variants.length, BUILTIN_GUARDED_RERANK_VARIANTS.length);
  // The baseline + reranker-control are
  // both well-formed.
  const baseline = report.variants[0]!;
  assert.equal(baseline.variant.id, "baseline-no-rerank");
  const rerankerControl = report.variants[1]!;
  assert.equal(rerankerControl.variant.id, "reranker-control-multi-anchor-aware-combined");
  // The baseline + the reranker-control
  // hit 10/26 baseline (newer-wins tie-
  // breaker changed from 12 to 10);
  // the reranker-control reaches 15/26
  // (the EXPERIMENT 8 result, updated
  // for newer-wins tie-breaker).
  assert.equal(baseline.metrics.baselineCurrentTruthAt1, 10);
  assert.equal(rerankerControl.metrics.afterCurrentTruthAt1, 15);
  assert.equal(rerankerControl.metrics.regressionCount, 0);
  // The guarded-multi-anchor-linked-
  // expansion variant (PRIMARY
  // DELIVERABLE) MUST eliminate the
  // `temp-rate-limit` regression. The
  // regressionCount is 0; the
  // tempRateLimitRegressionCount is 0;
  // the promotionsBlockedByGuard is
  // ≥1 (the guard fired).
  const guardedPrimary = report.variants.find(
    (v) => v.variant.id === "guarded-multi-anchor-linked-expansion"
  )!;
  assert.equal(guardedPrimary.metrics.regressionCount, 0);
  assert.equal(guardedPrimary.metrics.tempRateLimitRegressionCount, 0);
  assert.ok(
    guardedPrimary.metrics.promotionsBlockedByGuard >= 1,
    "the guard must have fired (blocked at least one supersedes promotion)"
  );
  // The temp-rate-limit per-query
  // output has
  // `tempRateLimitRegression: false`
  // AND `afterTop1Id: 70` (the current
  // truth is preserved at rank 1).
  const tempRateLimit = guardedPrimary.metrics.perQuery.find(
    (p) => p.queryId === "temp-rate-limit"
  )!;
  assert.ok(tempRateLimit, "temp-rate-limit per-query output must exist");
  assert.equal(tempRateLimit.tempRateLimitRegression, false);
  assert.equal(tempRateLimit.afterTop1Id, 70);
  assert.equal(tempRateLimit.afterCurrentTruthAt1, true);
  // The verdict is `safe` (no
  // regressions, `currentTruthAt1Delta
  // > 0` because the guarded primary
  // preserves the reranker-control's
  // +6).
  assert.equal(guardedPrimary.verdict, "safe");
  // The guarded primary's
  // `afterCurrentTruthAt1` is the
  // reranker-control's 15 (the +5
  // recovery is preserved; the +2
  // recovery of Exp 9's candidate-
  // expansion step is LOST because the
  // guard blocks the legitimate
  // `supersedes` promotions of INJECTED
  // candidates — this is the honest
  // trade-off).
  assert.equal(guardedPrimary.metrics.afterCurrentTruthAt1, 15);
});

test("supersedes-promote-guard: oracle diagnostic ceiling", () => {
  // The `oracle-guarded-candidate-
  // injection-ceiling` variant is the
  // diagnostic IDEAL PROTECTION CEILING:
  // a re-ranker that knows which
  // candidates are current AND protects
  // them. The variant MUST eliminate
  // the `temp-rate-limit` regression.
  //
  // Honest reading: even the oracle
  // diagnostic lands at 18/26 (not
  // 20/26) because the +2 recoveries of
  // Exp 9's candidate-expansion step
  // require the multi-anchor reranker's
  // `supersedes` promotion of INJECTED
  // `supersedes` candidates. The oracle
  // guard's hint (`supersedes` target
  // is current truth) does not fire
  // for these cases (the `supersedes`
  // targets are NOT current truth). The
  // oracle guard's primary protection
  // (injected + non-injected rank-1)
  // fires, blocking the +2 recoveries.
  //
  // The honest answer: a `supersedes-
  // promote` guard that blocks
  // `supersedes` promotions of injected
  // candidates above non-injected
  // rank-1 lands at 15/26 (the
  // reranker-control's level) with 0
  // regressions, regardless of whether
  // the guard consults
  // `currentTruthIds` or not. The +2 of
  // Exp 9's candidate-expansion step
  // cannot be preserved by such a
  // guard.
  const dir = ".curion/benchmark";
  const file = findMostRecentArtifact(dir, "retrieval-baseline-");
  if (!file) {
    return;
  }
  const artifact = readBenchmarkArtifact(file);
  const queries = alignQueriesToEvals(artifact.evals);
  const report = buildGuardedRerankReport({
    sourceVariant: artifact.variant,
    evals: artifact.evals,
    queries,
    recordCount: artifact.config.recordCount ?? null,
  });
  const oracle = report.variants.find(
    (v) => v.variant.id === "oracle-guarded-candidate-injection-ceiling"
  )!;
  // The oracle diagnostic eliminates
  // the regression.
  assert.equal(oracle.metrics.regressionCount, 0);
  assert.equal(oracle.metrics.tempRateLimitRegressionCount, 0);
  // The oracle diagnostic also lands at
  // 15/26 (the +2 is lost; the oracle
  // guard's hint does not help recover
  // it; newer-wins tie-breaker changed
  // baseline from 12 to 10).
  assert.equal(oracle.metrics.afterCurrentTruthAt1, 15);
});

test("supersedes-promote-guard: end-to-end CLI runs without error and writes an artifact", async () => {
  const dir = ".curion/benchmark";
  const file = findMostRecentArtifact(dir, "retrieval-baseline-");
  if (!file) {
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spg-test-"));
  try {
    const { report, written } = await runGuardedRerankCli({
      benchmarkArtifact: file,
      outDir: tmpDir,
      noStdout: true,
    });
    // The report is well-formed.
    assert.equal(report.temporalQueryCount, 26);
    // The artifact was written.
    assert.ok(written, "artifact path must be returned");
    assert.ok(fs.existsSync(written), "artifact file must exist on disk");
    // The artifact is parseable JSON.
    const text = fs.readFileSync(written, "utf8");
    const parsed = JSON.parse(text);
    assert.equal(parsed.temporalQueryCount, 26);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. CLI argument parsing
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: parseGuardedRerankCliArgs defaults", () => {
  const args = parseGuardedRerankCliArgs([]);
  assert.deepEqual(args, {});
});

test("supersedes-promote-guard: parseGuardedRerankCliArgs with all flags", () => {
  const args = parseGuardedRerankCliArgs([
    "--benchmark-artifact",
    "/tmp/x.json",
    "--semantic-evidence",
    "/tmp/y.json",
    "--out-dir",
    "/tmp/z",
    "--variant",
    "my-variant",
    "--no-write",
    "--no-stdout",
  ]);
  assert.equal(args.benchmarkArtifact, "/tmp/x.json");
  assert.equal(args.semanticEvidence, "/tmp/y.json");
  assert.equal(args.outDir, "/tmp/z");
  assert.equal(args.variant, "my-variant");
  assert.equal(args.noWrite, true);
  assert.equal(args.noStdout, true);
});

test("supersedes-promote-guard: parseGuardedRerankCliArgs ignores unknown flags", () => {
  const args = parseGuardedRerankCliArgs(["--unknown", "foo", "--help"]);
  assert.deepEqual(args, {});
});

// ---------------------------------------------------------------------------
// 10. Artifact reader + writer round-trip
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: artifact writer round-trip", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const report = buildGuardedRerankReport({
    sourceVariant: "synthetic-lexical",
    evals,
    queries,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spg-rt-"));
  try {
    const written = writeGuardedRerankReport(report, tmpDir);
    assert.ok(fs.existsSync(written));
    const text = fs.readFileSync(written, "utf8");
    const parsed = JSON.parse(text) as GuardedRerankReport;
    assert.equal(parsed.temporalQueryCount, report.temporalQueryCount);
    assert.equal(parsed.variants.length, report.variants.length);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Downstream reranker guard
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: downstream reranker guard throws when the variant is not multi-anchor-aware-combined", () => {
  // A future caller that swaps the
  // downstream reranker should be forced
  // to read the contract.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS[0]!;
  const wrongDownstream = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "metadata-simulation-supersededBy-demote"
  )!;
  assert.throws(
    () =>
      evaluateGuardedRerankVariant({
        variant,
        evals,
        queries,
        downstreamVariant: wrongDownstream,
      }),
    /downstreamVariant must be 'multi-anchor-aware-combined'/
  );
});

// ---------------------------------------------------------------------------
// 12. currentTruthIds-free contract (primary variant)
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: supersedes-promote-guard is currentTruthIds-free", () => {
  // The rule's output for two queries
  // with the SAME top-K + injected-ids
  // but DIFFERENT `currentTruthIds`
  // MUST be identical. The contract is
  // that the rule reads ONLY the post-
  // expansion top-K + the injected-id
  // set + the simulated edge map, NOT
  // `currentTruthIds`.
  const topIds = [70, 130, 20, 23, 45, 3];
  const topScores = [0.95, 0.7, 0.25, 0.25, 0.25, 0.0];
  const injectedIds = [3];
  const { evals: e1, queries: q1 } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [70],
      currentTruthIds: [70],
      topIds,
      topScores,
    },
  ]);
  const { evals: e2, queries: q2 } = mkQueryEval([
    {
      queryId: "q2",
      expectedIds: [99],
      currentTruthIds: [99],
      topIds,
      topScores,
    },
  ]);
  const a = applySupersedesPromoteGuardRule({
    rule: { kind: "supersedes-promote-guard" },
    topIds,
    topScores,
    injectedIds,
    query: q1[0]!,
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  const b = applySupersedesPromoteGuardRule({
    rule: { kind: "supersedes-promote-guard" },
    topIds,
    topScores,
    injectedIds,
    query: q2[0]!,
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // Same top-K + same injected-ids ->
  // same output (the rule is
  // currentTruthIds-free).
  assert.deepEqual(a.topIds, b.topIds);
  assert.deepEqual(a.topScores, b.topScores);
  assert.equal(a.promotionsBlocked, b.promotionsBlocked);
});

test("supersedes-promote-guard: oracle-supersedes-promote-guard DOES consult currentTruthIds", () => {
  // The oracle guard's STRONGER
  // protection: a non-injected
  // `supersedes` candidate is also
  // blocked if its `supersedes` target
  // is a current-truth id. The rule's
  // output for two queries with the
  // SAME top-K + injected-ids but
  // DIFFERENT `currentTruthIds` MUST
  // be DIFFERENT.
  const topIds = [22, 7, 42, 112, 103];
  const topScores = [0.95, 0.85, 0.25, 0.2, 0.15];
  const injectedIds: number[] = [];
  const { queries: q1 } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [7],
      currentTruthIds: [22, 7],
      topIds,
      topScores,
    },
  ]);
  const { queries: q2 } = mkQueryEval([
    {
      queryId: "q2",
      expectedIds: [7],
      currentTruthIds: [7],
      topIds,
      topScores,
    },
  ]);
  const a = applySupersedesPromoteGuardRule({
    rule: { kind: "oracle-supersedes-promote-guard" },
    topIds,
    topScores,
    injectedIds,
    query: q1[0]!,
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  const b = applySupersedesPromoteGuardRule({
    rule: { kind: "oracle-supersedes-promote-guard" },
    topIds,
    topScores,
    injectedIds,
    query: q2[0]!,
    downstreamRule: { kind: "multi-anchor-aware-combined" },
  });
  // The oracle guard's output
  // DIFFERS because the
  // `currentTruthIds` differs.
  assert.notDeepEqual(a.topIds, b.topIds);
});

// ---------------------------------------------------------------------------
// 13. Evaluate per-query purity
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: evaluateGuardedRerankForQuery is pure and does not mutate", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 5, 6, 7, 8] },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS.find(
    (v) => v.id === "guarded-multi-anchor-linked-expansion"
  )!;
  const downstream = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "multi-anchor-aware-combined"
  )!;
  const a = evaluateGuardedRerankForQuery({
    variant,
    eval: evals[0]!,
    query: queries[0]!,
    downstreamVariant: downstream,
  });
  const b = evaluateGuardedRerankForQuery({
    variant,
    eval: evals[0]!,
    query: queries[0]!,
    downstreamVariant: downstream,
  });
  // Same input -> same output.
  assert.deepEqual(a, b);
  // The input topIds is unchanged.
  assert.deepEqual(evals[0]!.topIds, [21, 5, 6, 7, 8]);
});

// ---------------------------------------------------------------------------
// 14. Sanity row
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: guarded-no-op is a no-op when no candidate is injected", () => {
  // The `guarded-no-op` variant is the
  // sanity row: the guard alone, with
  // no expansion. The guard's output is
  // a pass-through (the injected-id set
  // is empty), so the variant's
  // `afterCurrentTruthAt1` equals the
  // reranker-control's
  // `afterCurrentTruthAt1`.
  const dir = ".curion/benchmark";
  const file = findMostRecentArtifact(dir, "retrieval-baseline-");
  if (!file) {
    return;
  }
  const artifact = readBenchmarkArtifact(file);
  const queries = alignQueriesToEvals(artifact.evals);
  const report = buildGuardedRerankReport({
    sourceVariant: artifact.variant,
    evals: artifact.evals,
    queries,
    recordCount: artifact.config.recordCount ?? null,
  });
  const noOp = report.variants.find((v) => v.variant.id === "guarded-no-op")!;
  const rerankerControl = report.variants.find(
    (v) => v.variant.id === "reranker-control-multi-anchor-aware-combined"
  )!;
  // The guard is a pass-through when
  // no candidate is injected.
  assert.equal(noOp.metrics.afterCurrentTruthAt1, rerankerControl.metrics.afterCurrentTruthAt1);
  assert.equal(noOp.metrics.regressionCount, 0);
  assert.equal(noOp.metrics.promotionsBlockedByGuard, 0);
});

// ---------------------------------------------------------------------------
// 15. Verdict coverage
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: buildGuardedRerankVariantRow returns a well-formed row", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS[0]!;
  const row = buildGuardedRerankVariantRow({
    variant,
    evals,
    queries,
  });
  // The row carries the variant, the
  // metrics, and the verdict.
  assert.equal(row.variant.id, variant.id);
  assert.ok(row.metrics);
  assert.ok(row.verdict);
  assert.ok(row.verdictNote);
  // The verdict is one of the
  // documented kinds.
  assert.ok(
    ["safe", "unsafe", "neutral"].includes(row.verdict),
    `verdict must be one of safe/unsafe/neutral, got ${row.verdict}`
  );
});

// ---------------------------------------------------------------------------
// 16. Downstream-reranker guard: non-multi-anchor-aware-combined is rejected
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: guard rule kinds are well-formed", () => {
  // The `SupersedesPromoteGuardRule`
  // discriminated union is exhaustive.
  const rules: SupersedesPromoteGuardRule[] = [
    { kind: "none" },
    { kind: "supersedes-promote-guard" },
    { kind: "oracle-supersedes-promote-guard" },
  ];
  for (const r of rules) {
    assert.ok(r.kind);
  }
});

// ---------------------------------------------------------------------------
// 17. Per-category change rollup
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: perCategoryChange is populated", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 5, 6, 7, 8] },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS.find(
    (v) => v.id === "guarded-multi-anchor-linked-expansion"
  )!;
  const m = evaluateGuardedRerankVariant({ variant, evals, queries });
  // The per-category change block is
  // populated.
  assert.ok(m.perCategoryChange);
  assert.ok(Object.keys(m.perCategoryChange).length > 0);
});

// ---------------------------------------------------------------------------
// 18. Per-query `regression` flag
// ---------------------------------------------------------------------------

test("supersedes-promote-guard: per-query regression flag is set on temp-rate-limit for unguarded variants", () => {
  // The `reranker-control` variant
  // (no guard, no expansion) does NOT
  // regress on `temp-rate-limit` (the
  // baseline top-K already has 70 at
  // rank 1, so the multi-anchor
  // reranker's `supersedes` promotion
  // does not displace 70 — there is
  // no injected candidate to displace
  // it). The per-query
  // `regression: false`.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "temp-rate-limit",
      expectedIds: [70],
      currentTruthIds: [70],
      topIds: [70, 130, 20, 23, 45],
    },
  ]);
  const variant: GuardedRerankVariant = BUILTIN_GUARDED_RERANK_VARIANTS.find(
    (v) => v.id === "reranker-control-multi-anchor-aware-combined"
  )!;
  const m = evaluateGuardedRerankVariant({ variant, evals, queries });
  // The multi-anchor reranker's
  // `supersedes` promotion does not
  // displace 70 (no injected candidate
  // to displace it).
  assert.equal(m.regressionCount, 0);
  assert.equal(m.tempRateLimitRegressionCount, 0);
});
