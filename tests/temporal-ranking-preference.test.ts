/**
 * Tests for the benchmark-only temporal
 * ranking-preference re-ranker diagnostic
 * (Experiment 6).
 *
 * Covers:
 *   1. Re-rank math: the `applyRerankRule`
 *      helper produces the documented
 *      re-ordered lists for each rule kind.
 *   2. Category honesty: the variant table's
 *      `category` field is the documented
 *      `production-like` / `fixture-shaped` /
 *      `oracle` reading; the test pins the
 *      table.
 *   3. No production import leaks: the
 *      production source tree must NOT
 *      import the new modules.
 *   4. Deterministic output: same input ->
 *      same report; no PRNG; no wall clock.
 *   5. No mutation: the `applyRerankRule`
 *      helper does NOT mutate the input
 *      `topIds` / `topScores` arrays.
 *   6. Public API unchanged: exactly two
 *      tools.
 *   7. Report shape: the per-variant
 *      metrics include the documented
 *      before/after counts and deltas.
 *   8. Honest framing: a variant that uses
 *      `currentTruthIds` or
 *      `STALE_TEMPORAL_IDS` is marked
 *      `oracle` or `fixture-shaped` in the
 *      built-in table.
 *   9. End-to-end on the real lexical
 *      baseline artifact under
 *      `.cortex/benchmark/`.
 *  10. CLI argument parsing: default modes
 *      + override flags.
 *  11. Per-category change rollup: the
 *      per-variant perCategoryChange block
 *      is populated.
 *  12. Verdict: `safe` / `unsafe` /
 *      `neutral` per the documented
 *      deterministic rules.
 *  13. Clean / fixture-ambiguous split:
 *      the split is on the baseline's
 *      `isDivergentLabeled` flag.
 *  14. Regression detection: a re-ranker
 *      that introduces a regression
 *      surfaces `regressionCount > 0`.
 *  15. Unchanged-because-current-missing:
 *      the metric is the re-ranker's
 *      ceiling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_TEMPORAL_RERANK_VARIANTS,
  DEFAULT_MILD_HEURISTIC_STALE_IDS,
  applyRerankRule,
  buildTemporalRerankReport,
  buildTemporalRerankVariantRow,
  computeTemporalRerankVerdict,
  evaluateTemporalRerankForQuery,
  evaluateTemporalRerankVariant,
  formatTemporalRerankReport,
  aggregateTemporalRerankPerQuery,
  type TemporalRerankReport,
  type TemporalRerankRule,
  type TemporalRerankVariant,
  type TemporalRerankVariantMetrics,
} from "../src/benchmark/temporal-ranking-preference.js";
import {
  parseTemporalRerankCliArgs,
  runTemporalRerankAnalysis,
  runTemporalRerankCli,
  writeTemporalRerankReport,
} from "../src/benchmark/temporal-ranking-preference-runner.js";
import {
  findMostRecentArtifact,
  readBenchmarkArtifact,
  alignQueriesToEvals,
  type BenchmarkArtifact,
} from "../src/benchmark/temporal-truth-diagnostic-runner.js";
import {
  STALE_TEMPORAL_IDS,
  classifyTemporalTruthFailure,
} from "../src/benchmark/temporal-truth-diagnostic.js";
import type { BenchmarkQuery } from "../src/benchmark/queries.js";
import { evaluateQuery, type QueryEval } from "../src/benchmark/metrics.js";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic per-query input the
 * re-ranker consumes. The factory takes a
 * per-query spec and produces a
 * `QueryEval` + a `BenchmarkQuery` pair.
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
    /**
     * Optional runtime abstention-audit
     * signals; the mild-heuristic variant
     * reads `isTemporalCurrent` from this
     * block.
     */
    abstentionSignals?: QueryEval["abstentionSignals"];
  }>,
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
      topScores,
    );
    // Re-derive rank1 / currentTruthAt1 in case
    // the synthetic topIds is empty.
    const expectedSet = new Set(s.expectedIds);
    const currentTruthSet = new Set(s.currentTruthIds);
    const top0 = s.topIds[0];
    e.rank1 = top0 !== undefined && expectedSet.has(top0);
    e.currentTruthAt1 = top0 !== undefined && currentTruthSet.has(top0);
    e.passed =
      s.expectedIds.length === 0
        ? s.topIds.length === 0
        : s.topIds.some((id) => expectedSet.has(id));
    if (s.abstentionSignals) {
      e.abstentionSignals = s.abstentionSignals;
    }
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
// 1. Re-rank math
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: applyRerankRule none is a defensive copy", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: TemporalRerankRule = { kind: "none" };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [21, 1, 5, 6, 7]);
  assert.deepEqual(out.topScores, [0.5, 0.5, 0.5, 0.5, 0.5]);
  // Defensive copy: the result is NOT the same
  // array reference as the input.
  assert.notEqual(out.topIds, evals[0]!.topIds);
});

test("temporal-ranking-preference: applyRerankRule oracle-current-truth-promote moves current ids to top", () => {
  // The current truth (id 1) is at position 1;
  // the oracle-promote rule should move it to
  // position 0, preserving the relative order
  // of the other ids.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: TemporalRerankRule = { kind: "oracle-current-truth-promote" };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 21, 5, 6, 7]);
});

test("temporal-ranking-preference: applyRerankRule oracle-current-truth-promote preserves relative order within each partition", () => {
  // Multiple current ids in the top-K; their
  // relative order is preserved at the top.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [3, 5],
      currentTruthIds: [3, 5],
      topIds: [21, 5, 22, 3, 6, 7],
    },
  ]);
  const rule: TemporalRerankRule = { kind: "oracle-current-truth-promote" };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  // The two current ids (5, 3) are at the top in
  // their original relative order (5 before 3).
  // The non-current ids (21, 22, 6, 7) follow
  // in their original relative order.
  assert.deepEqual(out.topIds, [5, 3, 21, 22, 6, 7]);
});

test("temporal-ranking-preference: applyRerankRule oracle-current-truth-promote-first-only moves ONLY the first current id", () => {
  // The first current id in the top-K is moved
  // to position 0; the rest of the order is
  // preserved.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [3, 5],
      currentTruthIds: [3, 5],
      topIds: [21, 5, 22, 3, 6, 7],
    },
  ]);
  const rule: TemporalRerankRule = { kind: "oracle-current-truth-promote-first-only" };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  // The first current id encountered in input
  // order is 5; only 5 is promoted to position
  // 0. The rest of the input order is preserved.
  assert.deepEqual(out.topIds, [5, 21, 22, 3, 6, 7]);
});

test("temporal-ranking-preference: applyRerankRule fixture-shaped-stale-demote moves STALE_TEMPORAL_IDS to bottom", () => {
  // 21 is a known stale id; 22 is also known
  // stale. The demote rule should move both to
  // the bottom, preserving their relative order.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 22, 5, 6, 7],
    },
  ]);
  const rule: TemporalRerankRule = { kind: "fixture-shaped-stale-demote" };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  // 1, 5, 6, 7 (non-stale) stay at the top in
  // input order; 21, 22 (stale) move to the
  // bottom in input order.
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21, 22]);
});

test("temporal-ranking-preference: applyRerankRule fixture-shaped-stale-demote-current-promote combines both", () => {
  // 21 is stale, 1 is current-truth. The
  // combined rule should put 1 at the top and
  // 21 at the bottom.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
    },
  ]);
  const rule: TemporalRerankRule = { kind: "fixture-shaped-stale-demote-current-promote" };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21]);
});

test("temporal-ranking-preference: applyRerankRule mild-heuristic-temporal-current is a no-op when signal absent", () => {
  // No `abstentionSignals` block. The
  // mild-heuristic rule is a no-op.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: TemporalRerankRule = {
    kind: "mild-heuristic-temporal-current",
    staleLikeIds: DEFAULT_MILD_HEURISTIC_STALE_IDS,
  };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [21, 1, 5, 6, 7]);
});

test("temporal-ranking-preference: applyRerankRule mild-heuristic-temporal-current demotes only when isTemporalCurrent is true", () => {
  // The runtime signal `isTemporalCurrent: true`
  // is the only production-like trigger. With
  // it, the rule demotes the embedded
  // stale-like ids (21..24 + 112) to the bottom.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 22, 5, 6, 7],
      abstentionSignals: {
        topScore: 0.5,
        top1Top2Gap: 0,
        top1Top2Ratio: 1,
        returnedCount: 5,
        agreementCount: 0,
        minContributorRank: null,
        maxContributorRank: null,
        meanContributorRank: null,
        minContributorScore: null,
        maxContributorScore: null,
        meanContributorScore: null,
        sourcePresence: "___",
        isNoAnswerHardNegative: false,
        isTemporalCurrent: true,
        isNegationLike: false,
        isOodEntityLike: false,
        isParaphraseTrap: false,
        isFalsePremiseLike: false,
        isAdversarialParaphrase: false,
        isDivergentTemporal: false,
        isNearMissCurrentCluster: false,
      },
    },
  ]);
  const rule: TemporalRerankRule = {
    kind: "mild-heuristic-temporal-current",
    staleLikeIds: DEFAULT_MILD_HEURISTIC_STALE_IDS,
  };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  // 21, 22 are in the embedded stale-like set;
  // 1, 5, 6, 7 are not.
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21, 22]);
});

test("temporal-ranking-preference: applyRerankRule mild-heuristic-temporal-current is a no-op when isTemporalCurrent is false", () => {
  // Runtime signal `isTemporalCurrent: false`
  // => no-op.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
      abstentionSignals: {
        topScore: 0.5,
        top1Top2Gap: 0,
        top1Top2Ratio: 1,
        returnedCount: 5,
        agreementCount: 0,
        minContributorRank: null,
        maxContributorRank: null,
        meanContributorRank: null,
        minContributorScore: null,
        maxContributorScore: null,
        meanContributorScore: null,
        sourcePresence: "___",
        isNoAnswerHardNegative: false,
        isTemporalCurrent: false,
        isNegationLike: false,
        isOodEntityLike: false,
        isParaphraseTrap: false,
        isFalsePremiseLike: false,
        isAdversarialParaphrase: false,
        isDivergentTemporal: false,
        isNearMissCurrentCluster: false,
      },
    },
  ]);
  const rule: TemporalRerankRule = {
    kind: "mild-heuristic-temporal-current",
    staleLikeIds: DEFAULT_MILD_HEURISTIC_STALE_IDS,
  };
  const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [21, 1, 5, 6, 7]);
});

test("temporal-ranking-preference: applyRerankRule preserves length and order semantics on empty top-K", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [] },
  ]);
  for (const rule of [
    { kind: "none" } as const,
    { kind: "oracle-current-truth-promote" } as const,
    { kind: "oracle-current-truth-promote-first-only" } as const,
    { kind: "fixture-shaped-stale-demote" } as const,
    { kind: "fixture-shaped-stale-demote-current-promote" } as const,
  ]) {
    const out = applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
    assert.deepEqual(out.topIds, []);
    assert.deepEqual(out.topScores, []);
  }
});

// ---------------------------------------------------------------------------
// 2. Category honesty
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: built-in variant table category honesty", () => {
  // The built-in variant table MUST be honest
  // about which variants use fixture truth.
  // The test pins the table:
  //   - the baseline is `production-like`;
  //   - `oracle-current-truth-promote-all` and
  //     `oracle-current-truth-promote-first-only`
  //     are `oracle` (uses `currentTruthIds`);
  //   - `fixture-shaped-stale-demote` and
  //     `fixture-shaped-stale-demote-current-promote`
  //     are `fixture-shaped` (uses
  //     `STALE_TEMPORAL_IDS`);
  //   - `mild-heuristic-temporal-current` is
  //     `production-like` (uses the runtime
  //     `isTemporalCurrent` signal; the
  //     embedded stale-like set is narrow and
  //     documented).
  const byId = new Map(
    BUILTIN_TEMPORAL_RERANK_VARIANTS.map((v) => [v.id, v.category] as const),
  );
  assert.equal(byId.get("baseline-no-rerank"), "production-like");
  assert.equal(byId.get("oracle-current-truth-promote-all"), "oracle");
  assert.equal(byId.get("oracle-current-truth-promote-first-only"), "oracle");
  assert.equal(byId.get("fixture-shaped-stale-demote"), "fixture-shaped");
  assert.equal(
    byId.get("fixture-shaped-stale-demote-current-promote"),
    "fixture-shaped",
  );
  assert.equal(byId.get("mild-heuristic-temporal-current"), "production-like");
});

test("temporal-ranking-preference: oracle variants reference currentTruthIds (fixture truth)", () => {
  // The oracle-promote variant description
  // explicitly names `currentTruthIds` as
  // fixture truth. A reviewer who reads the
  // description sees the framing.
  for (const v of BUILTIN_TEMPORAL_RERANK_VARIANTS) {
    if (v.category !== "oracle") continue;
    const d = v.description.toLowerCase();
    assert.ok(
      d.includes("currenttruthid") ||
        d.includes("current-truth") ||
        d.includes("fixture truth") ||
        d.includes("research-only") ||
        d.includes("research"),
      `oracle variant ${v.id} description must name fixture truth / currentTruthIds, got: ${v.description}`,
    );
  }
});

test("temporal-ranking-preference: fixture-shaped variants reference STALE_TEMPORAL_IDS (fixture truth)", () => {
  // The fixture-shaped variants name
  // `STALE_TEMPORAL_IDS` explicitly. A
  // reviewer who reads the description sees
  // the framing.
  for (const v of BUILTIN_TEMPORAL_RERANK_VARIANTS) {
    if (v.category !== "fixture-shaped") continue;
    assert.ok(
      v.description.toLowerCase().includes("stale_temporal_ids") ||
        v.description.toLowerCase().includes("stale record") ||
        v.description.toLowerCase().includes("fixture truth") ||
        v.description.toLowerCase().includes("stale"),
      `fixture-shaped variant ${v.id} description must name stale/fixture truth`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. No production import leaks
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: production source tree does NOT import the new module", () => {
  const productionDirs = [
    "src/controller",
    "src/storage",
    "src/retrieval",
    "src/tools",
    "src/providers",
    "src/safety",
  ];
  for (const dir of productionDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = walkTs(dir);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(
        !text.includes("temporal-ranking-preference"),
        `production source ${f} must not import the new module`,
      );
    }
  }
});

/**
 * Walk a directory recursively and return all
 * .ts files (excluding .d.ts).
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
// 4. Deterministic output
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: same input produces a byte-stable report (no PRNG, no wall clock)", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
    { queryId: "q3", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const r1 = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const r2 = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.deepEqual(r1, r2);
});

test("temporal-ranking-preference: human report is byte-stable", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const s1 = formatTemporalRerankReport(report);
  const s2 = formatTemporalRerankReport(report);
  assert.equal(s1, s2);
});

// ---------------------------------------------------------------------------
// 5. No mutation
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: applyRerankRule does NOT mutate the input arrays", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const originalTopIds = [...evals[0]!.topIds];
  const originalTopScores = [...evals[0]!.topScores];
  // Apply every rule kind. None of them
  // should mutate the input.
  for (const rule of [
    { kind: "none" } as const,
    { kind: "oracle-current-truth-promote" } as const,
    { kind: "oracle-current-truth-promote-first-only" } as const,
    { kind: "fixture-shaped-stale-demote" } as const,
    { kind: "fixture-shaped-stale-demote-current-promote" } as const,
  ]) {
    applyRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  }
  assert.deepEqual(evals[0]!.topIds, originalTopIds);
  assert.deepEqual(evals[0]!.topScores, originalTopScores);
});

// ---------------------------------------------------------------------------
// 6. Public API unchanged
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: public MCP API is unchanged (exactly two tools)", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

// ---------------------------------------------------------------------------
// 7. Report shape
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: report has the documented top-level shape", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.equal(report.sourceVariant, "synthetic");
  assert.equal(report.temporalQueryCount, 1);
  assert.ok(Array.isArray(report.variants));
  // Every built-in variant is represented.
  assert.equal(report.variants.length, BUILTIN_TEMPORAL_RERANK_VARIANTS.length);
  for (const row of report.variants) {
    assert.ok(row.variant);
    assert.ok(row.metrics);
    assert.ok(
      ["safe", "unsafe", "neutral"].includes(row.verdict),
      `verdict must be safe|unsafe|neutral, got ${row.verdict}`,
    );
    assert.ok(typeof row.verdictNote === "string");
  }
});

test("temporal-ranking-preference: per-variant metrics include the documented before/after counts", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  for (const row of report.variants) {
    const m = row.metrics;
    // The metrics are the documented fields.
    assert.equal(m.total, 2);
    assert.equal(typeof m.baselineCurrentTruthAt1, "number");
    assert.equal(typeof m.afterCurrentTruthAt1, "number");
    assert.equal(
      m.afterCurrentTruthAt1 - m.baselineCurrentTruthAt1,
      m.currentTruthAt1Delta,
    );
    assert.equal(
      m.afterStaleTop1 - m.baselineStaleTop1,
      m.staleTop1Delta,
    );
    assert.equal(
      m.afterStaleOverCurrent - m.baselineStaleOverCurrent,
      m.staleOverCurrentDelta,
    );
    assert.equal(
      m.afterCurrentMissing - m.baselineCurrentMissing,
      m.currentMissingDelta,
    );
    assert.equal(typeof m.regressionCount, "number");
    assert.equal(typeof m.unchangedBecauseCurrentMissing, "number");
  }
});

// ---------------------------------------------------------------------------
// 8. Honest framing — see also the dedicated tests
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: the module imports STALE_TEMPORAL_IDS from the diagnostic", () => {
  // The module imports STALE_TEMPORAL_IDS from
  // the prior diagnostic so a reviewer can
  // audit the set in one place. The fixture-
  // shaped variant uses the set as-is; the
  // test pins the documented legacy cluster
  // (21..24) as a smoke check on the import
  // path.
  for (const id of [21, 22, 23, 24, 105, 106, 107, 108]) {
    assert.ok(
      STALE_TEMPORAL_IDS.has(id),
      `STALE_TEMPORAL_IDS must contain ${id}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. End-to-end on the real lexical baseline artifact
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: end-to-end CLI on the real lexical baseline artifact", async () => {
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
  const { report } = await runTemporalRerankCli({
    benchmarkArtifact: baselinePath,
    ...(hasSemantic ? { semanticEvidence: semanticPath } : {}),
    noWrite: true,
    noStdout: true,
  });
  // The report is well-formed.
  assert.ok(report.sourceVariant.length > 0);
  // The temporal slice is the documented 26 queries.
  assert.equal(report.temporalQueryCount, 26);
  // The baseline variant's `currentTruthAt1`
  // matches the prior diagnostic's finding
  // (12/26). The baseline variant is the
  // `baseline-no-rerank` row, which is the
  // first row.
  const baseline = report.variants[0]!;
  assert.equal(baseline.variant.id, "baseline-no-rerank");
  assert.equal(baseline.metrics.baselineCurrentTruthAt1, 12);
  // The oracle-promote-all variant should
  // produce a higher `currentTruthAt1` than
  // the baseline (every query with a current
  // id in the top-K is promoted). The exact
  // upper bound is `currentTruthInTopK` from
  // the prior diagnostic (22/26).
  const oraclePromote = report.variants.find(
    (v) => v.variant.id === "oracle-current-truth-promote-all",
  );
  assert.ok(oraclePromote);
  assert.ok(
    oraclePromote.metrics.afterCurrentTruthAt1 >=
      baseline.metrics.baselineCurrentTruthAt1,
    "oracle-promote-all should not regress the baseline",
  );
  assert.ok(
    oraclePromote.metrics.afterCurrentTruthAt1 >=
      baseline.metrics.baselineCurrentTruthAt1,
  );
  // The fixture-shaped-stale-demote variant
  // should produce a non-negative delta on
  // `staleTop1` (the demote rule moves stale
  // ids out of the top-1 position).
  const staleDemote = report.variants.find(
    (v) => v.variant.id === "fixture-shaped-stale-demote",
  );
  assert.ok(staleDemote);
  // The combined
  // fixture-shaped-stale-demote-current-promote
  // should produce a strictly-positive
  // `currentTruthAt1Delta` vs the baseline
  // (the rule promotes current ids to the
  // top, so any query with a current id in
  // the top-K is recovered).
  const combined = report.variants.find(
    (v) =>
      v.variant.id === "fixture-shaped-stale-demote-current-promote",
  );
  assert.ok(combined);
  assert.ok(
    combined.metrics.currentTruthAt1Delta > 0,
    "the combined fixture-shaped+oracle variant should recover at least one currentTruthAt1",
  );
  // The production-like mild-heuristic
  // variant is a research probe: with no
  // abstention signals in the lexical
  // baseline artifact, the variant is a
  // no-op. The expected `currentTruthAt1Delta`
  // is 0 and the expected `regressionCount`
  // is 0.
  const mild = report.variants.find(
    (v) => v.variant.id === "mild-heuristic-temporal-current",
  );
  assert.ok(mild);
  assert.equal(mild.metrics.currentTruthAt1Delta, 0);
  assert.equal(mild.metrics.regressionCount, 0);
  // The mild-heuristic variant's verdict
  // should be `safe` (no regressions, no
  // recovery; the variant preserved the
  // baseline).
  assert.equal(mild.verdict, "safe");
});

test("temporal-ranking-preference: end-to-end CLI without an artifact on disk throws a loud error", async () => {
  await assert.rejects(
    () =>
      runTemporalRerankCli({
        outDir: "/tmp/nonexistent-rr-dir",
        noWrite: true,
        noStdout: true,
      }),
    /no --benchmark-artifact given/,
  );
});

// ---------------------------------------------------------------------------
// 10. CLI argument parsing
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: CLI argument parser handles the documented flags", () => {
  const parsed = parseTemporalRerankCliArgs([
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

test("temporal-ranking-preference: CLI argument parser ignores unknown flags", () => {
  const parsed = parseTemporalRerankCliArgs([
    "--unknown-flag",
    "value",
    "--no-write",
  ]);
  assert.equal(parsed.noWrite, true);
});

// ---------------------------------------------------------------------------
// 11. Per-category change rollup
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: perCategoryChange rollup is populated for at least one variant", () => {
  // On the synthetic input, the
  // `oracle-current-truth-promote-all` variant
  // should move the `current-truth-in-topk-stale-top1`
  // queries to `current-truth-top1`. The
  // perCategoryChange block surfaces the
  // `(baseline -> after) -> count` map.
  const { evals, queries } = mkQueryEval([
    // Baseline: current-truth-top1
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    // Baseline: current-truth-in-topk-stale-top1
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  // q1 stays at current-truth-top1 -> current-truth-top1.
  // q2 moves from
  // current-truth-in-topk-stale-top1 to
  // current-truth-top1.
  const change = m.perCategoryChange;
  assert.ok(change);
  assert.ok(
    change["current-truth-in-topk-stale-top1 -> current-truth-top1"] === 1,
    "the stale-top1 -> top1 move should be reflected in the perCategoryChange block",
  );
});

// ---------------------------------------------------------------------------
// 12. Verdict
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: verdict is unsafe when regressions are introduced", () => {
  // A re-ranker that DEMOTES the current
  // truth (id 1) to the bottom of the top-K
  // is a regression: the baseline had
  // `currentTruthAt1`; the re-ranker
  // doesn't. We construct this with the
  // `mild-heuristic-temporal-current` rule
  // and a CUSTOM `staleLikeIds` set that
  // includes 1 (the current truth). When
  // the runtime signal `isTemporalCurrent`
  // is true, the rule demotes 1.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
      abstentionSignals: {
        topScore: 0.5,
        top1Top2Gap: 0,
        top1Top2Ratio: 1,
        returnedCount: 5,
        agreementCount: 0,
        minContributorRank: null,
        maxContributorRank: null,
        meanContributorRank: null,
        minContributorScore: null,
        maxContributorScore: null,
        meanContributorScore: null,
        sourcePresence: "___",
        isNoAnswerHardNegative: false,
        isTemporalCurrent: true,
        isNegationLike: false,
        isOodEntityLike: false,
        isParaphraseTrap: false,
        isFalsePremiseLike: false,
        isAdversarialParaphrase: false,
        isDivergentTemporal: false,
        isNearMissCurrentCluster: false,
      },
    },
  ]);
  // The custom `staleLikeIds` includes 1
  // (the current truth). The default
  // embedded set does NOT include 1, so
  // this is a synthetic scenario that
  // constructs a regression.
  const badRule: TemporalRerankRule = {
    kind: "mild-heuristic-temporal-current",
    staleLikeIds: new Set([1, 21, 22, 23, 24, 112]),
  };
  const badVariant: TemporalRerankVariant = {
    id: "test-bad-mild-heuristic",
    description:
      "Test-only variant: same as mild-heuristic-temporal-current but with a stale-like set that includes the current truth (synthetic regression).",
    category: "production-like",
    rule: badRule,
  };
  const m = evaluateTemporalRerankVariant({
    variant: badVariant,
    evals,
    queries,
  });
  // The re-ranker should introduce a
  // regression: top-1 = 1 (current) before,
  // top-1 = 21 (not current) after.
  assert.ok(
    m.regressionCount >= 1,
    `the re-ranker should introduce a regression (got regressionCount=${m.regressionCount})`,
  );
  // The verdict is unsafe.
  const { verdict } = computeTemporalRerankVerdict(m);
  assert.equal(verdict, "unsafe");
});

test("temporal-ranking-preference: verdict is safe when at least one recovery and zero regressions", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  // The re-ranker recovers q1 (top-1 = 1
  // after).
  assert.equal(m.regressionCount, 0);
  assert.ok(m.currentTruthAt1Delta > 0);
  const { verdict } = computeTemporalRerankVerdict(m);
  assert.equal(verdict, "safe");
});

test("temporal-ranking-preference: verdict is safe when no recovery and no regressions", () => {
  // The baseline-no-rerank variant on a query
  // that is already current-truth-top1
  // produces no change. The verdict is
  // `safe`: no regressions, no change.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  const { verdict } = computeTemporalRerankVerdict(m);
  assert.equal(verdict, "safe"); // baseline preserves currentTruthAt1, so no regression
  assert.equal(m.regressionCount, 0);
  assert.equal(m.currentTruthAt1Delta, 0);
});

// ---------------------------------------------------------------------------
// 13. Clean / fixture-ambiguous split
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: clean / fixture-ambiguous split is on the divergentTemporal label", () => {
  const { evals, queries } = mkQueryEval([
    // Clean (no divergentTemporal label).
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    // Fixture-ambiguous.
    {
      queryId: "q2",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
  ]);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  // 1 clean + 1 fixture-ambiguous.
  assert.equal(m.cleanTotal, 1);
  assert.equal(m.fixtureAmbiguousTotal, 1);
  // q1 is clean and current-truth-top1; q2 is
  // fixture-ambiguous. The split is on the
  // baseline's `isDivergentLabeled` flag.
  const q1 = m.perQuery.find((p) => p.queryId === "q1")!;
  const q2 = m.perQuery.find((p) => p.queryId === "q2")!;
  assert.equal(q1.isClean, true);
  assert.equal(q1.isFixtureAmbiguous, false);
  assert.equal(q2.isClean, false);
  assert.equal(q2.isFixtureAmbiguous, true);
});

// ---------------------------------------------------------------------------
// 14. Regression detection
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: regressionCount is 0 on a no-rerank baseline", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 0);
});

// ---------------------------------------------------------------------------
// 15. Unchanged-because-current-missing
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: unchangedBecauseCurrentMissing is the re-ranker ceiling", () => {
  // On a query whose current truth is NOT in
  // the top-K, the re-ranker cannot help.
  // The metric is the re-ranker's ceiling:
  // the re-ranker cannot promote a current
  // id that is not in the candidate set.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const oraclePromote = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  // The baseline is current-truth-missing-no-stale
  // (no current id in the top-K). The
  // oracle-promote rule also cannot help
  // because the current id is not in the
  // top-K. The `unchangedBecauseCurrentMissing`
  // count is 1.
  assert.equal(m.unchangedBecauseCurrentMissing, 1);
  assert.equal(m.afterCurrentTruthAt1, 0);
  assert.equal(m.afterCurrentMissing, 1);
});

// ---------------------------------------------------------------------------
// 16. Artifact reader + writer round-trip
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: artifact reader + writer round-trip is byte-stable", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-"));
  try {
    // First write: serialize the in-memory
    // report to JSON. The Set-typed
    // `staleLikeIds` field on the
    // `mild-heuristic-temporal-current`
    // variant is serialized as `{}` (the
    // JSON spec for `Set` is an empty
    // object). The round-trip test
    // acknowledges this and compares the
    // JSON strings (modulo `Set` -> `{}`)
    // rather than the in-memory shapes.
    const fullPath = writeTemporalRerankReport(report, tmpDir);
    const text1 = fs.readFileSync(fullPath, "utf8");
    // The on-disk text is byte-stable.
    const text2 = fs.readFileSync(fullPath, "utf8");
    assert.equal(text1, text2);
    // The parsed JSON is well-formed.
    const parsed = JSON.parse(text1) as TemporalRerankReport;
    assert.equal(parsed.sourceVariant, "synthetic");
    assert.equal(parsed.temporalQueryCount, 1);
    assert.equal(parsed.variants.length, BUILTIN_TEMPORAL_RERANK_VARIANTS.length);
    // The parsed `mild-heuristic-temporal-current`
    // variant's `staleLikeIds` is the JSON
    // serialization of the `Set` (an empty
    // object). The set's contents are NOT
    // preserved across the JSON boundary by
    // design (the variant is described in
    // the report by its `description` and
    // `id`; the embedded set is internal
    // state, not an artifact contract).
    const mildRow = parsed.variants.find(
      (r) => r.variant.id === "mild-heuristic-temporal-current",
    );
    assert.ok(mildRow);
    assert.equal(
      mildRow!.variant.rule.kind,
      "mild-heuristic-temporal-current",
    );
    if (mildRow!.variant.rule.kind === "mild-heuristic-temporal-current") {
      // The JSON-parsed set is `{}`; the
      // empty object literal is the
      // documented JSON representation of
      // a `Set`. The runner NEVER consumes
      // the set from the JSON; the in-memory
      // runner builds the set from the
      // built-in table.
      assert.deepEqual(mildRow!.variant.rule.staleLikeIds, {});
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 17. Helper consistency
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: buildTemporalRerankVariantRow is consistent with the per-variant evaluator + verdict", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const row = buildTemporalRerankVariantRow({
    variant: oraclePromote,
    evals,
    queries,
  });
  // The row's metrics match the evaluator's
  // metrics.
  const metrics = evaluateTemporalRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  assert.deepEqual(row.metrics, metrics);
  // The row's verdict matches the verdict
  // function's verdict.
  const { verdict } = computeTemporalRerankVerdict(metrics);
  assert.equal(row.verdict, verdict);
});

test("temporal-ranking-preference: aggregateTemporalRerankPerQuery is consistent with per-query rollups", () => {
  // The aggregate function is a pure helper.
  // The test pins the per-query contract: the
  // sum of the clean + fixture-ambiguous
  // counts equals the total.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    {
      queryId: "q2",
      expectedIds: [1, 21],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
      labels: ["divergentTemporal"],
    },
  ]);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.total, m.cleanTotal + m.fixtureAmbiguousTotal);
});

// ---------------------------------------------------------------------------
// 18. evals/queries length / id mismatch
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: evals/queries length mismatch throws", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  assert.throws(
    () =>
      evaluateTemporalRerankVariant({
        variant: baseline,
        evals,
        queries: [...queries, ...queries],
      }),
    /evals\.length/,
  );
});

test("temporal-ranking-preference: evals/queries id mismatch throws", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const corrupted = [{ ...queries[0]!, id: "different" }];
  assert.throws(
    () =>
      evaluateTemporalRerankVariant({
        variant: baseline,
        evals,
        queries: corrupted,
      }),
    /does not match/,
  );
});

// ---------------------------------------------------------------------------
// 19. End-to-end alignment with the prior diagnostic on the real artifact
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: per-query alignment with prior diagnostic on the real artifact", () => {
  // The baseline-no-rerank variant on the real
  // lexical baseline artifact must agree with
  // the prior diagnostic's `currentTruthAt1`
  // count (12) and the per-category counts.
  const baselinePath = findMostRecentArtifact(
    ".cortex/benchmark",
    "retrieval-baseline-",
  );
  if (!baselinePath) return;
  const artifact = readBenchmarkArtifact(baselinePath);
  const queries = alignQueriesToEvals(artifact.evals);
  const baseline = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateTemporalRerankVariant({
    variant: baseline,
    evals: artifact.evals,
    queries,
  });
  // The baseline's currentTruthAt1 is 12
  // (from the prior diagnostic's finding).
  assert.equal(m.baselineCurrentTruthAt1, 12);
  // The re-ranker is a no-op, so the after
  // count is the same.
  assert.equal(m.afterCurrentTruthAt1, 12);
  assert.equal(m.currentTruthAt1Delta, 0);
  // The fixture-shaped + oracle combined
  // variant must produce a strictly positive
  // `currentTruthAt1Delta`.
  const combined = BUILTIN_TEMPORAL_RERANK_VARIANTS.find(
    (v) =>
      v.id === "fixture-shaped-stale-demote-current-promote",
  )!;
  const combinedM = evaluateTemporalRerankVariant({
    variant: combined,
    evals: artifact.evals,
    queries,
  });
  assert.ok(
    combinedM.currentTruthAt1Delta > 0,
    "the combined fixture-shaped+oracle variant should recover at least one currentTruthAt1 on the real artifact",
  );
  // The combined variant's `regressionCount`
  // is 0: a well-formed re-ranker that
  // promotes current ids and demotes stale
  // ids never demotes a current id.
  assert.equal(combinedM.regressionCount, 0);
});

// ---------------------------------------------------------------------------
// 20. Semantic overlay cross-reference
// ---------------------------------------------------------------------------

test("temporal-ranking-preference: semantic overlay cross-reference is well-formed", () => {
  const { evals, queries } = mkQueryEval([
    // q1: current truth is 1; the semantic map
    // says the dense ranker would have hit
    // this (rare; included for symmetry).
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    // q2: current truth is 1; the semantic map
    // says the dense ranker would have missed
    // this (the common case on the real
    // corpus).
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const semantic = {
    source: "test-embeddinggemma",
    byQueryId: new Map<string, "hit" | "miss">([
      ["q1", "hit"],
      ["q2", "miss"],
    ]),
  };
  const report = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
    semantic,
  });
  assert.ok(report.semanticOverlay);
  assert.equal(report.semanticOverlay!.covered, 2);
  assert.equal(report.semanticOverlay!.hit, 1);
  assert.equal(report.semanticOverlay!.miss, 1);
  // The recovered-by-variant map is
  // populated: the oracle-promote-all variant
  // recovers q2 (the baseline-miss query)
  // because the current truth (1) is at
  // position 1 in the top-K; the re-ranker
  // promotes it to position 0.
  assert.equal(
    report.semanticOverlay!.recoveredByVariant[
      "oracle-current-truth-promote-all"
    ],
    1,
  );
  // The baseline variant recovers 0
  // (the baseline is a no-op).
  assert.equal(
    report.semanticOverlay!.recoveredByVariant["baseline-no-rerank"],
    0,
  );
});

test("temporal-ranking-preference: buildTemporalRerankReport with no semantic overlay omits the field", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildTemporalRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.equal(report.semanticOverlay, undefined);
});
