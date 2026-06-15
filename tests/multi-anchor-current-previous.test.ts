/**
 * Tests for the benchmark-only multi-anchor /
 * current-vs-previous handling (Experiment 8).
 *
 * Covers:
 *   1. Multi-anchor metadata construction:
 *      the simulated
 *      `SIMULATED_MULTI_ANCHOR_TREATMENT` map
 *      contains the documented 117-120 cluster;
 *      the `SIMULATED_MULTI_ANCHOR_IDS` and
 *      `SIMULATED_PROTECTED_ANCHOR_IDS` sets
 *      are the documented projections; the
 *      `validFrom` / `validUntil` fields are
 *      `null` (the fixture does not carry
 *      anchor dates); the fields are
 *      well-formed.
 *   2. Re-rank math: the
 *      `applyMultiAnchorRerankRule` helper
 *      produces the documented re-ordered
 *      lists for each rule kind. Critical
 *      cases:
 *      - The protection step on a
 *        `temp-current-vs-previous-release`-
 *        style query (rank 1 is the anchor;
 *        7 is in the top-K; 7 supersedes 22
 *        in the top-K).
 *      - The protection step is a no-op
 *        when the rank-1 record is NOT an
 *        anchor.
 *      - The non-anchor variants (baseline,
 *        safe demote, unsafe combined, oracle)
 *        are unaffected by the multi-anchor
 *        treatment.
 *   3. Regression prevention: the
 *      `multi-anchor-aware-combined` variant
 *      recovers the +1 on
 *      `temp-release-process` while NOT
 *      introducing the regression on
 *      `temp-current-vs-previous-release`.
 *      The `multi-anchor-aware-combined`
 *      variant's regressionCount is 0 on
 *      the multi-anchor subset.
 *   4. Category honesty: the variant table's
 *      `category` field is the documented
 *      `production-like` / `oracle` /
 *      `metadata-simulation` /
 *      `multi-anchor-simulation` reading; the
 *      test pins the table.
 *   5. No production import leaks: the
 *      production source tree must NOT import
 *      the new modules.
 *   6. Deterministic output: same input ->
 *      same report; no PRNG; no wall clock.
 *   7. No mutation: the
 *      `applyMultiAnchorRerankRule` helper
 *      does NOT mutate the input `topIds` /
 *      `topScores` arrays.
 *   8. Public API unchanged: exactly two tools.
 *   9. Report shape: the per-variant metrics
 *      include the documented before/after
 *      counts and deltas; the top-level report
 *      includes the multi-anchor subset block,
 *      the gap block, the treatment summary
 *      block, and the category-change keys.
 *  10. End-to-end on the real lexical baseline
 *      artifact under `.cortex/benchmark/`.
 *  11. CLI argument parsing: default modes +
 *      override flags.
 *  12. Per-category change rollup: the
 *      per-variant perCategoryChange block is
 *      populated.
 *  13. Verdict: `safe` / `unsafe` / `neutral`
 *      per the documented deterministic rules.
 *  14. Clean / fixture-ambiguous split: the
 *      split is on the baseline's
 *      `isDivergentLabeled` flag.
 *  15. Multi-anchor subset: the
 *      `multiAnchorQueryCount` /
 *      `multiAnchorRegressionCount` /
 *      `multiAnchorProtectedCount` metrics
 *      are populated and consistent.
 *  16. `currentTruthIds`-free contract: the
 *      multi-anchor-simulation re-rank rules
 *      do NOT consult `currentTruthIds` in
 *      their decisions (the rules read ONLY
 *      the simulated edge map + the
 *      multi-anchor treatment).
 *  17. Artifact reader + writer round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS,
  SIMULATED_MULTI_ANCHOR_IDS,
  SIMULATED_MULTI_ANCHOR_TREATMENT,
  SIMULATED_PROTECTED_ANCHOR_IDS,
  applyMultiAnchorRerankRule,
  buildMultiAnchorRerankReport,
  buildMultiAnchorRerankVariantRow,
  computeMultiAnchorRerankVerdict,
  evaluateMultiAnchorRerankForQuery,
  evaluateMultiAnchorRerankVariant,
  formatMultiAnchorRerankReport,
  aggregateMultiAnchorRerankPerQuery,
  type MultiAnchorRerankReport,
  type MultiAnchorRerankRule,
  type MultiAnchorRerankVariant,
  type MultiAnchorRerankVariantMetrics,
} from "../src/benchmark/multi-anchor-current-previous.js";
import {
  parseMultiAnchorRerankCliArgs,
  runMultiAnchorRerankAnalysis,
  runMultiAnchorRerankCli,
  writeMultiAnchorRerankReport,
} from "../src/benchmark/multi-anchor-current-previous-runner.js";
import {
  findMostRecentArtifact,
  readBenchmarkArtifact,
  alignQueriesToEvals,
  type BenchmarkArtifact,
} from "../src/benchmark/temporal-truth-diagnostic-runner.js";
import type { BenchmarkQuery } from "../src/benchmark/queries.js";
import { evaluateQuery, type QueryEval } from "../src/benchmark/metrics.js";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";
import { EXCLUDED_FROM_EDGE_MAP } from "../src/benchmark/supersession-edge-simulation.js";

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
    // Re-derive rank1 / currentTruthAt1 in
    // case the synthetic topIds is empty.
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
// 1. Multi-anchor metadata construction
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: SIMULATED_MULTI_ANCHOR_TREATMENT contains the documented 117-120 cluster", () => {
  // The multi-anchor treatment MUST contain
  // the documented `current-vs-previous`
  // anchor records 117..120. The test pins
  // the contract so a future edit that drops
  // a record is a deliberate change.
  for (const id of [117, 118, 119, 120]) {
    assert.ok(
      SIMULATED_MULTI_ANCHOR_TREATMENT.has(id),
      `SIMULATED_MULTI_ANCHOR_TREATMENT must contain ${id}`,
    );
    const t = SIMULATED_MULTI_ANCHOR_TREATMENT.get(id)!;
    assert.equal(t.recordId, id);
    assert.equal(t.isMultiAnchor, true);
    assert.equal(t.currentVsPreviousAnchor, true);
    assert.equal(t.preferAnchorWhenQueryNeedsComparison, true);
    assert.equal(t.validFrom, null);
    assert.equal(t.validUntil, null);
  }
});

test("multi-anchor-current-previous: SIMULATED_MULTI_ANCHOR_TREATMENT does NOT contain non-anchor records", () => {
  // The treatment is restricted to the
  // documented 117-120 cluster. Records
  // outside the cluster are NOT in the map.
  for (const id of [1, 7, 21, 22, 23, 24, 69, 105, 106, 107, 108]) {
    assert.ok(
      !SIMULATED_MULTI_ANCHOR_TREATMENT.has(id),
      `SIMULATED_MULTI_ANCHOR_TREATMENT must NOT contain ${id}`,
    );
  }
});

test("multi-anchor-current-previous: SIMULATED_MULTI_ANCHOR_IDS and SIMULATED_PROTECTED_ANCHOR_IDS are projections of the treatment", () => {
  // The projection helpers MUST be consistent
  // with the treatment map. The
  // `SIMULATED_MULTI_ANCHOR_IDS` set is the
  // set of records with
  // `currentVsPreviousAnchor === true`; the
  // `SIMULATED_PROTECTED_ANCHOR_IDS` set is
  // the set of records with
  // `preferAnchorWhenQueryNeedsComparison ===
  // true`. For the simulated treatment, the
  // two sets are the same.
  const multiAnchorFromMap = new Set<number>();
  const protectedFromMap = new Set<number>();
  for (const [id, t] of SIMULATED_MULTI_ANCHOR_TREATMENT.entries()) {
    if (t.currentVsPreviousAnchor) multiAnchorFromMap.add(id);
    if (t.preferAnchorWhenQueryNeedsComparison) protectedFromMap.add(id);
  }
  assert.deepEqual(
    [...SIMULATED_MULTI_ANCHOR_IDS].sort((a, b) => a - b),
    [...multiAnchorFromMap].sort((a, b) => a - b),
  );
  assert.deepEqual(
    [...SIMULATED_PROTECTED_ANCHOR_IDS].sort((a, b) => a - b),
    [...protectedFromMap].sort((a, b) => a - b),
  );
});

test("multi-anchor-current-previous: SIMULATED_MULTI_ANCHOR_IDS and EXCLUDED_FROM_EDGE_MAP are the same set (117-120)", () => {
  // The multi-anchor treatment's projection
  // is the same set as Experiment 7's
  // `EXCLUDED_FROM_EDGE_MAP` (records
  // 117-120). The two constants are
  // intentionally distinct module exports
  // (different metadata dimensions in a
  // production schema), but their
  // intersection on the fixture corpus is
  // the same set. The test pins the
  // cross-experiment consistency.
  assert.deepEqual(
    [...SIMULATED_MULTI_ANCHOR_IDS].sort((a, b) => a - b),
    [...EXCLUDED_FROM_EDGE_MAP].sort((a, b) => a - b),
    "SIMULATED_MULTI_ANCHOR_IDS and EXCLUDED_FROM_EDGE_MAP must be the same set on the fixture corpus",
  );
});

test("multi-anchor-current-previous: treatment fields are well-formed (validFrom/validUntil are null)", () => {
  // The fixture corpus does not carry anchor
  // dates; the `validFrom` / `validUntil`
  // fields MUST be `null` for every entry.
  // The contract is in the type definition;
  // the test pins the runtime value.
  for (const [, t] of SIMULATED_MULTI_ANCHOR_TREATMENT.entries()) {
    assert.equal(t.validFrom, null);
    assert.equal(t.validUntil, null);
  }
});

// ---------------------------------------------------------------------------
// 2. Re-rank math
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: applyMultiAnchorRerankRule none is a defensive copy", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: MultiAnchorRerankRule = { kind: "none" };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  assert.deepEqual(out.topIds, [21, 1, 5, 6, 7]);
  assert.deepEqual(out.topScores, [0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.notEqual(out.topIds, evals[0]!.topIds);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule metadata-simulation-supersededBy-demote is the same as Experiment 7", () => {
  // The safe demote rule is a thin wrapper
  // around Experiment 7's rule. The math is
  // identical; the test pins the contract.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 22, 5, 6, 7],
    },
  ]);
  const rule: MultiAnchorRerankRule = {
    kind: "metadata-simulation-supersededBy-demote",
  };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  // 21 and 22 are superseded; 1, 5, 6, 7 are
  // not.
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21, 22]);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule metadata-simulation-combined-unsafe reproduces Experiment 7's regression", () => {
  // The unsafe combined rule is a thin
  // wrapper around Experiment 7's combined
  // rule. On the `temp-current-vs-previous-
  // release` pattern, the rule introduces the
  // 1 regression Experiment 7 surfaces.
  // The test pins the BEFORE state of the
  // regression.
  const { evals, queries } = mkQueryEval([
    {
      // currentTruthIds = [118] (the
      // multi-anchor).
      queryId: "q-cvprev-release",
      expectedIds: [118],
      currentTruthIds: [118],
      // 118 at rank 1, 7 in top-K, 7
      // supersedes 22 in top-K. The combined
      // rule promotes 7 above 118.
      topIds: [118, 112, 7, 22, 60],
    },
  ]);
  const rule: MultiAnchorRerankRule = {
    kind: "metadata-simulation-combined-unsafe",
  };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  // 7 is promoted above 118. 112 is not in
  // the edge map; 22 (g-release-tue) and 60
  // (g-monitoring) are both superseded, so
  // they go to the BOTTOM in input order.
  assert.deepEqual(out.topIds, [7, 118, 112, 22, 60]);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule multi-anchor-aware-combined PROTECTS the rank-1 anchor", () => {
  // On the same `temp-current-vs-previous-
  // release` pattern, the multi-anchor-aware
  // rule protects 118 (the rank-1 anchor)
  // from being displaced by 7 (the
  // promotion). 7 is STILL promoted to
  // rank 2 (the rule's middle slot), but 118
  // stays at rank 1.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q-cvprev-release",
      expectedIds: [118],
      currentTruthIds: [118],
      topIds: [118, 112, 7, 22, 60],
    },
  ]);
  const rule: MultiAnchorRerankRule = {
    kind: "multi-anchor-aware-combined",
  };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  // 118 protected at rank 1; 7 promoted to
  // rank 2; 112 in the middle; 22 and 60
  // demoted to the bottom in input order.
  assert.deepEqual(out.topIds, [118, 7, 112, 22, 60]);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule multi-anchor-aware-combined recovers the +1 on the non-anchor case", () => {
  // On the `temp-release-process` pattern
  // (the non-anchor release query), the
  // rank-1 record is 112, NOT an anchor.
  // The protection step does NOT fire; the
  // combined rule's promotion still moves
  // 7 above 112. The result is the same as
  // the unsafe combined rule.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q-release-process",
      expectedIds: [7],
      currentTruthIds: [7],
      topIds: [112, 118, 7, 22, 103],
    },
  ]);
  const rule: MultiAnchorRerankRule = {
    kind: "multi-anchor-aware-combined",
  };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  // 7 promoted to rank 1; 112 and 118 in
  // the middle (118 is at rank 2 here, not
  // rank-1, so the protection step does NOT
  // fire); 22 (g-release-tue) and 103
  // (g-release-tue) are both superseded and
  // go to the BOTTOM in input order.
  assert.deepEqual(out.topIds, [7, 112, 118, 22, 103]);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule multi-anchor-protected-supersedes-promote is promotion-only (no demote)", () => {
  // The protected-promote rule is the
  // supersedes-promote rule with the
  // protection step; it does NOT demote
  // superseded records. On a query where
  // 21 is superseded (and 1 supersedes 21),
  // the rule should promote 1 to the top
  // but leave 21 in the middle.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      // 5 is the rank-1; not an anchor.
      topIds: [5, 21, 1, 6, 7],
    },
  ]);
  const rule: MultiAnchorRerankRule = {
    kind: "multi-anchor-protected-supersedes-promote",
  };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  // 1 supersedes 21; 1 is promoted to rank
  // 1. 21 stays in the middle. 5, 6, 7 keep
  // their relative order.
  assert.deepEqual(out.topIds, [1, 5, 21, 6, 7]);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule multi-anchor-aware-combined demotes superseded records", () => {
  // The combined rule (with protection) MUST
  // still demote superseded records. The
  // protection step protects the RANK-1
  // anchor; superseded records (non-anchor)
  // still go to the bottom.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      // 5 is the rank-1; not an anchor.
      topIds: [5, 21, 1, 6, 7],
    },
  ]);
  const rule: MultiAnchorRerankRule = {
    kind: "multi-anchor-aware-combined",
  };
  const out = applyMultiAnchorRerankRule({
    rule,
    eval: evals[0]!,
    query: queries[0]!,
  });
  // 1 supersedes 21; 1 is promoted to rank
  // 1; 21 is demoted to the bottom.
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21]);
});

test("multi-anchor-current-previous: applyMultiAnchorRerankRule preserves length and order semantics on empty top-K", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [] },
  ]);
  for (const rule of [
    { kind: "none" } as const,
    { kind: "oracle-current-truth-promote" } as const,
    { kind: "metadata-simulation-supersededBy-demote" } as const,
    { kind: "metadata-simulation-combined-unsafe" } as const,
    { kind: "multi-anchor-protected-supersedes-promote" } as const,
    { kind: "multi-anchor-aware-combined" } as const,
  ]) {
    const out = applyMultiAnchorRerankRule({
      rule,
      eval: evals[0]!,
      query: queries[0]!,
    });
    assert.deepEqual(out.topIds, []);
    assert.deepEqual(out.topScores, []);
  }
});

// ---------------------------------------------------------------------------
// 3. Regression prevention
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: multi-anchor-aware-combined prevents the temp-current-vs-previous-release regression", () => {
  // On the `temp-current-vs-previous-release`
  // pattern, the unsafe combined rule
  // introduces a regression
  // (118 -> 7) but the multi-anchor-aware
  // combined rule preserves 118 at rank 1.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q-cvprev-release",
      expectedIds: [118],
      currentTruthIds: [118],
      topIds: [118, 112, 7, 22, 60],
    },
  ]);
  // Run the unsafe rule.
  const unsafeMetrics = evaluateMultiAnchorRerankVariant({
    variant: BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
      (v) => v.id === "metadata-simulation-combined-unsafe",
    )!,
    evals,
    queries,
  });
  // Run the multi-anchor-aware rule.
  const awareMetrics = evaluateMultiAnchorRerankVariant({
    variant: BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
      (v) => v.id === "multi-anchor-aware-combined",
    )!,
    evals,
    queries,
  });
  // The unsafe rule introduces a regression
  // (currentTruthAt1: true -> false).
  const unsafeQ = unsafeMetrics.perQuery[0]!;
  assert.equal(unsafeQ.baselineCurrentTruthAt1, true);
  assert.equal(unsafeQ.afterCurrentTruthAt1, false);
  assert.equal(unsafeQ.regression, true);
  // The multi-anchor-aware rule preserves
  // currentTruthAt1.
  const awareQ = awareMetrics.perQuery[0]!;
  assert.equal(awareQ.baselineCurrentTruthAt1, true);
  assert.equal(awareQ.afterCurrentTruthAt1, true);
  assert.equal(awareQ.regression, false);
  // The multi-anchor-aware rule sets the
  // `anchorProtected` flag.
  assert.equal(awareQ.anchorProtected, true);
});

// ---------------------------------------------------------------------------
// 4. Category honesty
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: built-in variant table category honesty", () => {
  const byId = new Map(
    BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.map(
      (v) => [v.id, v.category] as const,
    ),
  );
  assert.equal(byId.get("baseline-no-rerank"), "production-like");
  assert.equal(byId.get("metadata-simulation-supersededBy-demote"), "metadata-simulation");
  assert.equal(byId.get("metadata-simulation-combined-unsafe"), "metadata-simulation");
  assert.equal(byId.get("multi-anchor-protected-supersedes-promote"), "multi-anchor-simulation");
  assert.equal(byId.get("multi-anchor-aware-combined"), "multi-anchor-simulation");
  assert.equal(byId.get("oracle-current-truth-promote-all"), "oracle");
});

test("multi-anchor-current-previous: multi-anchor-simulation variants are honest about NOT consulting currentTruthIds", () => {
  for (const v of BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS) {
    if (v.category !== "multi-anchor-simulation") continue;
    const d = v.description.toLowerCase();
    // The multi-anchor-simulation category
    // is honest about NOT consulting
    // currentTruthIds.
    assert.ok(
      d.includes("does not consult currenttruthid") ||
        d.includes("not consult currenttruthid") ||
        d.includes("never consult") ||
        d.includes("doesn’t consult") ||
        d.includes("not keys on currenttruthid") ||
        d.includes("not key on currenttruthid") ||
        d.includes("not keying on currenttruthid") ||
        d.includes("not keyed on currenttruthid"),
      `multi-anchor-simulation variant ${v.id} description must be honest about NOT using currentTruthIds, got: ${v.description}`,
    );
    // The multi-anchor-simulation category
    // describes the multi-anchor treatment.
    assert.ok(
      d.includes("multi-anchor") ||
        d.includes("anchor") ||
        d.includes("currentvspreviousanchor") ||
        d.includes("preferanchorwhenqueryneedscomparison"),
      `multi-anchor-simulation variant ${v.id} description must name the multi-anchor treatment, got: ${v.description}`,
    );
  }
});

test("multi-anchor-current-previous: oracle variant references currentTruthIds (fixture truth)", () => {
  for (const v of BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS) {
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

test("multi-anchor-current-previous: metadata-simulation variants do NOT consult the multi-anchor treatment", () => {
  // The Experiment 7 metadata-simulation
  // variants (surfaced here as reference
  // rows) do NOT consult the multi-anchor
  // treatment. The re-rank math is
  // IDENTICAL to Experiment 7.
  for (const v of BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS) {
    if (v.category !== "metadata-simulation") continue;
    const d = v.description.toLowerCase();
    // The description explicitly says the
    // rule does NOT consult the multi-anchor
    // treatment.
    assert.ok(
      d.includes("does not consult") ||
        d.includes("not consult") ||
        d.includes("never consult") ||
        d.includes("doesn’t consult") ||
        d.includes("not key on") ||
        d.includes("not keyed on"),
      `metadata-simulation variant ${v.id} description must be honest about NOT using the multi-anchor treatment, got: ${v.description}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. No production import leaks
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: production source tree does NOT import the new module", () => {
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
        !text.includes("multi-anchor-current-previous"),
        `production source ${f} must not import the new module`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 6. Deterministic output
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: same input produces a byte-stable report (no PRNG, no wall clock)", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
    { queryId: "q3", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const r1 = buildMultiAnchorRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const r2 = buildMultiAnchorRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.deepEqual(r1, r2);
});

test("multi-anchor-current-previous: human report is byte-stable", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildMultiAnchorRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const s1 = formatMultiAnchorRerankReport(report);
  const s2 = formatMultiAnchorRerankReport(report);
  assert.equal(s1, s2);
});

// ---------------------------------------------------------------------------
// 7. No mutation
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: applyMultiAnchorRerankRule does NOT mutate the input arrays", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const originalTopIds = [...evals[0]!.topIds];
  const originalTopScores = [...evals[0]!.topScores];
  for (const rule of [
    { kind: "none" } as const,
    { kind: "oracle-current-truth-promote" } as const,
    { kind: "metadata-simulation-supersededBy-demote" } as const,
    { kind: "metadata-simulation-combined-unsafe" } as const,
    { kind: "multi-anchor-protected-supersedes-promote" } as const,
    { kind: "multi-anchor-aware-combined" } as const,
  ]) {
    applyMultiAnchorRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  }
  assert.deepEqual(evals[0]!.topIds, originalTopIds);
  assert.deepEqual(evals[0]!.topScores, originalTopScores);
});

// ---------------------------------------------------------------------------
// 8. Public API unchanged
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: public MCP API is unchanged (exactly two tools)", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

// ---------------------------------------------------------------------------
// 9. Report shape
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: report has the documented top-level shape", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildMultiAnchorRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.equal(report.sourceVariant, "synthetic");
  assert.equal(report.temporalQueryCount, 1);
  assert.ok(Array.isArray(report.variants));
  assert.equal(
    report.variants.length,
    BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.length,
  );
  // The treatment summary block is present.
  assert.equal(typeof report.supersessionEdgeMapSize, "number");
  assert.equal(typeof report.multiAnchorTreatmentSize, "number");
  assert.ok(report.simulatedSupersededIds.length > 0);
  assert.ok(report.simulatedMultiAnchorIds.length > 0);
  // The multi-anchor subset block is present.
  assert.ok(report.multiAnchorSubset);
  assert.equal(typeof report.multiAnchorSubset.total, "number");
  // The gap breakdown block is present.
  assert.ok(report.gapBreakdown);
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

test("multi-anchor-current-previous: per-variant metrics include the documented before/after counts", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildMultiAnchorRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  for (const row of report.variants) {
    const m = row.metrics;
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
    assert.equal(typeof m.multiAnchorQueryCount, "number");
    assert.equal(typeof m.multiAnchorRegressionCount, "number");
    assert.equal(typeof m.multiAnchorProtectedCount, "number");
  }
});

// ---------------------------------------------------------------------------
// 10. End-to-end on the real lexical baseline artifact
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: end-to-end CLI on the real lexical baseline artifact", async () => {
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
  const { report } = await runMultiAnchorRerankCli({
    benchmarkArtifact: baselinePath,
    ...(hasSemantic ? { semanticEvidence: semanticPath } : {}),
    noWrite: true,
    noStdout: true,
  });
  // The report is well-formed.
  assert.ok(report.sourceVariant.length > 0);
  // The temporal slice is the documented 26 queries.
  assert.equal(report.temporalQueryCount, 26);
  // The treatment summary block is populated.
  assert.ok(report.supersessionEdgeMapSize > 0);
  assert.ok(report.multiAnchorTreatmentSize > 0);
  // The multi-anchor subset is the documented 4 queries.
  assert.equal(report.multiAnchorSubset.total, 4);
  // The baseline variant's `currentTruthAt1`
  // matches the prior diagnostic's finding
  // (12/26).
  const baseline = report.variants.find(
    (v) => v.variant.id === "baseline-no-rerank",
  );
  assert.ok(baseline);
  assert.equal(baseline!.metrics.baselineCurrentTruthAt1, 12);
  // The multi-anchor-aware combined variant
  // recovers the +1 over the safe baseline.
  const aware = report.variants.find(
    (v) => v.variant.id === "multi-anchor-aware-combined",
  );
  assert.ok(aware);
  assert.equal(aware!.metrics.afterCurrentTruthAt1, 18);
  assert.equal(aware!.metrics.regressionCount, 0);
  // The multi-anchor-aware combined variant
  // protects all 4 multi-anchor queries.
  assert.equal(aware!.metrics.multiAnchorRegressionCount, 0);
  assert.equal(aware!.metrics.multiAnchorProtectedCount, 4);
  // The unsafe combined baseline has 1
  // regression on the multi-anchor subset.
  const unsafe = report.variants.find(
    (v) => v.variant.id === "metadata-simulation-combined-unsafe",
  );
  assert.ok(unsafe);
  assert.equal(unsafe!.metrics.regressionCount, 1);
  assert.equal(unsafe!.metrics.multiAnchorRegressionCount, 1);
  // The safe demote baseline recovers +5
  // with 0 regressions.
  const demote = report.variants.find(
    (v) => v.variant.id === "metadata-simulation-supersededBy-demote",
  );
  assert.ok(demote);
  assert.equal(demote!.metrics.afterCurrentTruthAt1, 17);
  assert.equal(demote!.metrics.regressionCount, 0);
  // The oracle ceiling is 22.
  const oracle = report.variants.find(
    (v) => v.variant.id === "oracle-current-truth-promote-all",
  );
  assert.ok(oracle);
  assert.equal(oracle!.metrics.afterCurrentTruthAt1, 22);
  assert.equal(oracle!.metrics.regressionCount, 0);
  // Gap closed: the multi-anchor-aware
  // variant closes 6 of the 10 oracle gain
  // (the remaining 4 are the
  // `current-truth-missing-*` queries
  // out of reach for any in-list re-rank).
  const gapClosed = aware!.metrics.currentTruthAt1Delta;
  const oracleGain = oracle!.metrics.currentTruthAt1Delta;
  assert.ok(
    gapClosed > 0 && gapClosed < oracleGain,
    `multi-anchor-aware variant closes ${gapClosed} of ${oracleGain} oracle gain; honest partial recovery`,
  );
});

test("multi-anchor-current-previous: end-to-end CLI without an artifact on disk throws a loud error", async () => {
  await assert.rejects(
    () =>
      runMultiAnchorRerankCli({
        outDir: "/tmp/nonexistent-macp-dir",
        noWrite: true,
        noStdout: true,
      }),
    /no --benchmark-artifact given/,
  );
});

// ---------------------------------------------------------------------------
// 11. CLI argument parsing
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: CLI argument parser handles the documented flags", () => {
  const parsed = parseMultiAnchorRerankCliArgs([
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

test("multi-anchor-current-previous: CLI argument parser ignores unknown flags", () => {
  const parsed = parseMultiAnchorRerankCliArgs([
    "--unknown-flag",
    "value",
    "--no-write",
  ]);
  assert.equal(parsed.noWrite, true);
});

// ---------------------------------------------------------------------------
// 12. Per-category change rollup
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: perCategoryChange rollup is populated for at least one variant", () => {
  // On the synthetic input, the
  // `oracle-current-truth-promote-all`
  // variant should move the
  // `current-truth-in-topk-stale-top1`
  // query (q2) to `current-truth-top1`.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  const change = m.perCategoryChange;
  assert.ok(change);
  assert.ok(
    change["current-truth-in-topk-stale-top1 -> current-truth-top1"] === 1,
    "the stale-top1 -> top1 move should be reflected in the perCategoryChange block",
  );
});

// ---------------------------------------------------------------------------
// 13. Verdict
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: verdict is safe when at least one recovery and zero regressions", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 0);
  assert.ok(m.currentTruthAt1Delta > 0);
  const { verdict } = computeMultiAnchorRerankVerdict(m);
  assert.equal(verdict, "safe");
});

test("multi-anchor-current-previous: verdict is neutral when no recovery and zero regressions (no-op re-ranker)", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const baseline = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 0);
  assert.equal(m.currentTruthAt1Delta, 0);
  const { verdict, note } = computeMultiAnchorRerankVerdict(m);
  assert.equal(verdict, "neutral");
  assert.match(note, /no regressions, no currentTruthAt1 recovery/i);
  assert.match(note, /neutral/i);
});

test("multi-anchor-current-previous: verdict is unsafe when at least one regression", () => {
  const { evals, queries } = mkQueryEval([
    {
      // currentTruthIds = [118] (the
      // multi-anchor).
      queryId: "q-cvprev-release",
      expectedIds: [118],
      currentTruthIds: [118],
      topIds: [118, 112, 7, 22, 60],
    },
  ]);
  const unsafe = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "metadata-simulation-combined-unsafe",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: unsafe,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 1);
  const { verdict, note } = computeMultiAnchorRerankVerdict(m);
  assert.equal(verdict, "unsafe");
  assert.match(note, /regression/i);
});

// ---------------------------------------------------------------------------
// 14. Clean / fixture-ambiguous split
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: clean / fixture-ambiguous split is on the divergentTemporal label", () => {
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
  const baseline = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.cleanTotal, 1);
  assert.equal(m.fixtureAmbiguousTotal, 1);
  const q1 = m.perQuery.find((p) => p.queryId === "q1")!;
  const q2 = m.perQuery.find((p) => p.queryId === "q2")!;
  assert.equal(q1.isClean, true);
  assert.equal(q1.isFixtureAmbiguous, false);
  assert.equal(q2.isClean, false);
  assert.equal(q2.isFixtureAmbiguous, true);
});

// ---------------------------------------------------------------------------
// 15. Multi-anchor subset
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: multi-anchor subset metrics are populated and consistent", () => {
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q-cvprev",
      expectedIds: [117],
      currentTruthIds: [117],
      topIds: [117, 21, 5, 6, 7],
    },
    {
      queryId: "q-non-cvprev",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
    },
  ]);
  const aware = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "multi-anchor-aware-combined",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: aware,
    evals,
    queries,
  });
  // 1 of 2 queries is on the multi-anchor
  // subset.
  assert.equal(m.multiAnchorQueryCount, 1);
  // The multi-anchor query's baseline is
  // currentTruthAt1=true (117 is the
  // currentTruth and is at rank 1).
  assert.equal(m.multiAnchorBaselineCurrentTruthAt1, 1);
  // The protection step fires (the rank-1
  // record 117 is a multi-anchor).
  assert.equal(m.multiAnchorProtectedCount, 1);
  // No regression on the multi-anchor
  // subset.
  assert.equal(m.multiAnchorRegressionCount, 0);
});

test("multi-anchor-current-previous: isMultiAnchorSubset is true for queries whose currentTruthIds intersects SIMULATED_MULTI_ANCHOR_IDS", () => {
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q-cvprev",
      expectedIds: [117],
      currentTruthIds: [117],
      topIds: [117, 21, 5, 6, 7],
    },
    {
      queryId: "q-non-cvprev",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [1, 21, 5, 6, 7],
    },
  ]);
  const baseline = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  const q1 = m.perQuery.find((p) => p.queryId === "q-cvprev")!;
  const q2 = m.perQuery.find((p) => p.queryId === "q-non-cvprev")!;
  assert.equal(q1.isMultiAnchorSubset, true);
  assert.equal(q1.hasExcludedCurrentAnchor, true);
  assert.equal(q2.isMultiAnchorSubset, false);
  assert.equal(q2.hasExcludedCurrentAnchor, false);
});

test("multi-anchor-current-previous: anchorProtected is true only for protection rules on rank-1 multi-anchor records", () => {
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q-cvprev",
      expectedIds: [117],
      currentTruthIds: [117],
      // 117 is at rank 1: a multi-anchor
      // record at rank 1.
      topIds: [117, 21, 5, 6, 7],
    },
  ]);
  for (const variantId of [
    "baseline-no-rerank",
    "metadata-simulation-supersededBy-demote",
    "metadata-simulation-combined-unsafe",
    "multi-anchor-protected-supersedes-promote",
    "multi-anchor-aware-combined",
    "oracle-current-truth-promote-all",
  ]) {
    const variant = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
      (v) => v.id === variantId,
    )!;
    const m = evaluateMultiAnchorRerankVariant({
      variant,
      evals,
      queries,
    });
    const q = m.perQuery[0]!;
    const isProtectionRule =
      variantId === "multi-anchor-protected-supersedes-promote" ||
      variantId === "multi-anchor-aware-combined";
    assert.equal(
      q.anchorProtected,
      isProtectionRule,
      `anchorProtected for ${variantId} should be ${isProtectionRule}, got ${q.anchorProtected}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 16. currentTruthIds-free contract
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: multi-anchor-simulation re-rank rules do NOT consult currentTruthIds", () => {
  // The multi-anchor-simulation re-rank rules
  // read ONLY the simulated edge map and the
  // multi-anchor treatment; the rules do NOT
  // consult `query.currentTruthIds`. The test
  // pins the contract by running the same
  // query with two different `currentTruthIds`
  // values and asserting the re-ranked output
  // is identical.
  const ids1 = [1];
  const ids2 = [999]; // different `currentTruthIds`
  const { evals: evals1, queries: queries1 } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: ids1, topIds: [21, 1, 5, 6, 7] },
  ]);
  const { evals: evals2, queries: queries2 } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: ids2, topIds: [21, 1, 5, 6, 7] },
  ]);
  for (const rule of [
    { kind: "metadata-simulation-supersededBy-demote" } as const,
    { kind: "metadata-simulation-combined-unsafe" } as const,
    { kind: "multi-anchor-protected-supersedes-promote" } as const,
    { kind: "multi-anchor-aware-combined" } as const,
  ]) {
    const out1 = applyMultiAnchorRerankRule({
      rule,
      eval: evals1[0]!,
      query: queries1[0]!,
    });
    const out2 = applyMultiAnchorRerankRule({
      rule,
      eval: evals2[0]!,
      query: queries2[0]!,
    });
    assert.deepEqual(
      out1.topIds,
      out2.topIds,
      `multi-anchor / metadata-simulation rule ${rule.kind} must produce the same output regardless of currentTruthIds`,
    );
  }
});

test("multi-anchor-current-previous: oracle rule DOES consult currentTruthIds", () => {
  const { evals: evals1, queries: queries1 } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const { evals: evals2, queries: queries2 } = mkQueryEval([
    { queryId: "q1", expectedIds: [21], currentTruthIds: [21], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: MultiAnchorRerankRule = { kind: "oracle-current-truth-promote" };
  const out1 = applyMultiAnchorRerankRule({
    rule,
    eval: evals1[0]!,
    query: queries1[0]!,
  });
  const out2 = applyMultiAnchorRerankRule({
    rule,
    eval: evals2[0]!,
    query: queries2[0]!,
  });
  // Different currentTruthIds -> different
  // re-ranked output.
  assert.notDeepEqual(out1.topIds, out2.topIds);
  // The first output promotes 1; the second
  // promotes 21.
  assert.deepEqual(out1.topIds, [1, 21, 5, 6, 7]);
  assert.deepEqual(out2.topIds, [21, 1, 5, 6, 7]);
});

// ---------------------------------------------------------------------------
// 17. Artifact reader + writer round-trip
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: artifact reader + writer round-trip is byte-stable", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildMultiAnchorRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "macp-"));
  try {
    const fullPath = writeMultiAnchorRerankReport(report, tmpDir);
    const text1 = fs.readFileSync(fullPath, "utf8");
    const text2 = fs.readFileSync(fullPath, "utf8");
    assert.equal(text1, text2);
    const parsed = JSON.parse(text1) as MultiAnchorRerankReport;
    assert.equal(parsed.sourceVariant, "synthetic");
    assert.equal(parsed.temporalQueryCount, 1);
    assert.equal(
      parsed.variants.length,
      BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.length,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 18. Helper consistency
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: buildMultiAnchorRerankVariantRow is consistent with the per-variant evaluator + verdict", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const row = buildMultiAnchorRerankVariantRow({
    variant: oraclePromote,
    evals,
    queries,
  });
  const metrics = evaluateMultiAnchorRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  assert.deepEqual(row.metrics, metrics);
  const { verdict } = computeMultiAnchorRerankVerdict(metrics);
  assert.equal(row.verdict, verdict);
});

test("multi-anchor-current-previous: aggregateMultiAnchorRerankPerQuery is consistent with per-query rollups", () => {
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
  const baseline = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateMultiAnchorRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.total, m.cleanTotal + m.fixtureAmbiguousTotal);
});

// ---------------------------------------------------------------------------
// 19. evals/queries length / id mismatch
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: evals/queries length mismatch throws", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  const baseline = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  assert.throws(
    () =>
      evaluateMultiAnchorRerankVariant({
        variant: baseline,
        evals,
        queries: [...queries, ...queries],
      }),
    /evals\.length/,
  );
});

test("multi-anchor-current-previous: evals/queries id mismatch throws", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  const baseline = BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const corrupted = [{ ...queries[0]!, id: "different" }];
  assert.throws(
    () =>
      evaluateMultiAnchorRerankVariant({
        variant: baseline,
        evals,
        queries: corrupted,
      }),
    /does not match/,
  );
});

// ---------------------------------------------------------------------------
// 20. End-to-end alignment with prior diagnostic on the real artifact
// ---------------------------------------------------------------------------

test("multi-anchor-current-previous: per-query alignment with prior diagnostic on the real artifact", () => {
  const baselinePath = findMostRecentArtifact(
    ".cortex/benchmark",
    "retrieval-baseline-",
  );
  if (!baselinePath) return;
  const artifact = readBenchmarkArtifact(baselinePath);
  const queries = alignQueriesToEvals(artifact.evals);
  // Every query is a BenchmarkQuery; the
  // family is preserved.
  for (let i = 0; i < queries.length; i++) {
    assert.equal(queries[i]!.id, artifact.evals[i]!.queryId);
    assert.equal(queries[i]!.family, artifact.evals[i]!.family);
  }
});
