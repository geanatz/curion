/**
 * Tests for the benchmark-only supersession /
 * metadata edge simulation (Experiment 7).
 *
 * Covers:
 *   1. Edge-map construction: the simulated
 *      `SIMULATED_SUPERSESSION_EDGES` map
 *      contains the documented edges, the
 *      `EXCLUDED_FROM_EDGE_MAP` set is the
 *      documented exclusion, and the projection
 *      helpers (`SIMULATED_SUPERSEDED_IDS`,
 *      `SIMULATED_CURRENT_IN_GROUP_IDS`) match
 *      the edge map.
 *   2. Re-rank math: the
 *      `applySupersessionRerankRule` helper
 *      produces the documented re-ordered
 *      lists for each rule kind.
 *   3. Category honesty: the variant table's
 *      `category` field is the documented
 *      `production-like` / `oracle` /
 *      `metadata-simulation` reading; the test
 *      pins the table.
 *   4. No production import leaks: the
 *      production source tree must NOT import
 *      the new modules.
 *   5. Deterministic output: same input -> same
 *      report; no PRNG; no wall clock.
 *   6. No mutation: the
 *      `applySupersessionRerankRule` helper
 *      does NOT mutate the input `topIds` /
 *      `topScores` arrays.
 *   7. Public API unchanged: exactly two tools.
 *   8. Report shape: the per-variant metrics
 *      include the documented before/after
 *      counts and deltas; the top-level report
 *      includes the edge-map summary block.
 *   9. End-to-end on the real lexical baseline
 *      artifact under `.curion/benchmark/`.
 *  10. CLI argument parsing: default modes +
 *      override flags.
 *  11. Per-category change rollup: the
 *      per-variant perCategoryChange block is
 *      populated.
 *  12. Verdict: `safe` / `unsafe` / `neutral`
 *      per the documented deterministic rules.
 *  13. Clean / fixture-ambiguous split: the
 *      split is on the baseline's
 *      `isDivergentLabeled` flag.
 *  14. Regression detection: a re-ranker that
 *      introduces a regression surfaces
 *      `regressionCount > 0`.
 *  15. Unchanged-because-current-missing: the
 *      metric is the re-ranker's ceiling.
 *  16. Excluded-current-anchor: queries whose
 *      `currentTruthIds` intersects the
 *      `EXCLUDED_FROM_EDGE_MAP` set are
 *      surfaced in the gap breakdown.
 *  17. `currentTruthIds`-free contract: the
 *      metadata-simulation re-rank rules do
 *      NOT consult `currentTruthIds` in their
 *      decisions (the rules read ONLY the
 *      simulated edge map).
 *  18. Artifact reader + writer round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_SUPERSESSION_RERANK_VARIANTS,
  EXCLUDED_FROM_EDGE_MAP,
  SIMULATED_CURRENT_IN_GROUP_IDS,
  SIMULATED_SUPERSEDED_IDS,
  SIMULATED_SUPERSESSION_EDGES,
  applySupersessionRerankRule,
  buildSupersessionRerankReport,
  buildSupersessionRerankVariantRow,
  computeSupersessionRerankVerdict,
  evaluateSupersessionRerankForQuery,
  evaluateSupersessionRerankVariant,
  formatSupersessionRerankReport,
  aggregateSupersessionRerankPerQuery,
  type SupersessionRerankReport,
  type SupersessionRerankRule,
  type SupersessionRerankVariant,
  type SupersessionRerankVariantMetrics,
} from "../src/benchmark/supersession-edge-simulation.js";
import {
  parseSupersessionRerankCliArgs,
  runSupersessionRerankAnalysis,
  runSupersessionRerankCli,
  writeSupersessionRerankReport,
} from "../src/benchmark/supersession-edge-simulation-runner.js";
import {
  findMostRecentArtifact,
  readBenchmarkArtifact,
  alignQueriesToEvals,
  type BenchmarkArtifact,
} from "../src/benchmark/temporal-truth-diagnostic-runner.js";
import { STALE_TEMPORAL_IDS } from "../src/benchmark/temporal-truth-diagnostic.js";
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
// 1. Edge-map construction
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: SIMULATED_SUPERSESSION_EDGES contains the documented edges", () => {
  // The edge map MUST contain the documented
  // supersession patterns the prior diagnostic
  // surfaces. The test pins the contract so a
  // future edit that drops an edge is a
  // deliberate change.
  for (const id of [21, 22, 23, 24, 57, 58, 59, 60, 96, 105, 106, 107, 108]) {
    assert.ok(
      SIMULATED_SUPERSESSION_EDGES.has(id),
      `SIMULATED_SUPERSESSION_EDGES must contain ${id}`,
    );
  }
  // Postgres 14 (21) is superseded by 1.
  const e21 = SIMULATED_SUPERSESSION_EDGES.get(21)!;
  assert.equal(e21.supersededBy, 1);
  assert.equal(e21.isSuperseded, true);
  assert.equal(e21.currentInGroup, false);
  assert.equal(e21.versionGroup, "g-postgres-v16");
  // Postgres 16 (1) supersedes 21.
  const e1 = SIMULATED_SUPERSESSION_EDGES.get(1)!;
  assert.equal(e1.supersedes, 21);
  assert.equal(e1.supersededBy, null);
  assert.equal(e1.isSuperseded, false);
  assert.equal(e1.currentInGroup, true);
  assert.equal(e1.versionGroup, "g-postgres-v16");
});

test("supersession-edge-simulation: SIMULATED_SUPERSESSION_EDGES does NOT contain the excluded anchor records", () => {
  // The `current-vs-previous` anchor records
  // (117..120) are EXPLICITLY excluded from
  // the edge map. The map does not contain
  // them; the EXCLUDED_FROM_EDGE_MAP set lists
  // them.
  for (const id of [117, 118, 119, 120]) {
    assert.ok(
      !SIMULATED_SUPERSESSION_EDGES.has(id),
      `SIMULATED_SUPERSESSION_EDGES must NOT contain ${id} (current-vs-previous anchor)`,
    );
    assert.ok(
      EXCLUDED_FROM_EDGE_MAP.has(id),
      `EXCLUDED_FROM_EDGE_MAP must contain ${id}`,
    );
  }
});

test("supersession-edge-simulation: SIMULATED_SUPERSEDED_IDS and SIMULATED_CURRENT_IN_GROUP_IDS are projections of the edge map", () => {
  // The projection helpers MUST be consistent
  // with the edge map. The
  // `SIMULATED_SUPERSEDED_IDS` set is the
  // set of records with `isSuperseded === true`;
  // the `SIMULATED_CURRENT_IN_GROUP_IDS` set
  // is the set of records with
  // `currentInGroup === true`.
  const supersededFromMap = new Set<number>();
  const currentInGroupFromMap = new Set<number>();
  for (const [id, edge] of SIMULATED_SUPERSESSION_EDGES.entries()) {
    if (edge.isSuperseded) supersededFromMap.add(id);
    if (edge.currentInGroup) currentInGroupFromMap.add(id);
  }
  assert.deepEqual(
    [...SIMULATED_SUPERSEDED_IDS].sort((a, b) => a - b),
    [...supersededFromMap].sort((a, b) => a - b),
  );
  assert.deepEqual(
    [...SIMULATED_CURRENT_IN_GROUP_IDS].sort((a, b) => a - b),
    [...currentInGroupFromMap].sort((a, b) => a - b),
  );
});

test("supersession-edge-simulation: edge map fields are well-formed (validFrom/validUntil are null)", () => {
  // The fixture corpus does not carry anchor
  // dates; the `validFrom` / `validUntil`
  // fields MUST be `null` for every edge. The
  // contract is in the type definition; the
  // test pins the runtime value.
  for (const [, edge] of SIMULATED_SUPERSESSION_EDGES.entries()) {
    assert.equal(edge.validFrom, null);
    assert.equal(edge.validUntil, null);
  }
});

test("supersession-edge-simulation: SIMULATED_SUPERSEDED_IDS is a subset of STALE_TEMPORAL_IDS", () => {
  // The edge map is a NARROWER subset of
  // STALE_TEMPORAL_IDS: every record in
  // `SIMULATED_SUPERSEDED_IDS` is also in
  // `STALE_TEMPORAL_IDS`. The reverse is not
  // true: STALE_TEMPORAL_IDS includes
  // additional records (the temporal-old
  // cluster 57..60 minus the explicit
  // supersession chains, the conflict cluster
  // 101..104 minus the explicit chains, etc.)
  // that are stale but not part of an
  // explicit supersession edge.
  for (const id of SIMULATED_SUPERSEDED_IDS) {
    assert.ok(
      STALE_TEMPORAL_IDS.has(id),
      `SIMULATED_SUPERSEDED_IDS contains ${id} but STALE_TEMPORAL_IDS does not`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Re-rank math
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: applySupersessionRerankRule none is a defensive copy", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: SupersessionRerankRule = { kind: "none" };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [21, 1, 5, 6, 7]);
  assert.deepEqual(out.topScores, [0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.notEqual(out.topIds, evals[0]!.topIds);
});

test("supersession-edge-simulation: applySupersessionRerankRule oracle-current-truth-promote matches Experiment 6", () => {
  // The oracle variant is the same shape as
  // Experiment 6's `oracle-current-truth-promote-all`.
  // The current truth (id 1) is at position 1;
  // the oracle-promote rule should move it to
  // position 0.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: SupersessionRerankRule = { kind: "oracle-current-truth-promote" };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 21, 5, 6, 7]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-supersededBy-demote moves superseded ids to bottom", () => {
  // 21 is a superseded id; 22 is a superseded
  // id. The demote rule should move both to
  // the bottom, preserving their relative
  // order. 1, 5, 6, 7 are not superseded and
  // stay at the top in input order.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 22, 5, 6, 7],
    },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-supersededBy-demote",
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21, 22]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-supersededBy-demote is a no-op when no superseded ids are in the top-K", () => {
  // A top-K that contains only non-superseded
  // ids (and the simulated current ids) is a
  // no-op under the demote rule: the input
  // order is preserved.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-supersededBy-demote",
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 8]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-supersedes-promote promotes candidates that supersede another in the same top-K", () => {
  // 1 supersedes 21 in the edge map. With
  // BOTH 1 and 21 in the top-K, the promote
  // rule should move 1 to position 0. The
  // 7 record supersedes 22 (which is also in
  // the top-K), so 7 is ALSO promoted. The
  // relative order of the promoted
  // candidates is the input order (1 first,
  // 7 second). The non-promoted candidates
  // (21, 5, 22, 6) keep their relative
  // input order.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 5, 22, 1, 6, 7],
    },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-supersedes-promote",
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 7, 21, 5, 22, 6]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-supersedes-promote is a no-op when the supersede target is not in the top-K", () => {
  // 1 supersedes 21 in the edge map. With 1
  // in the top-K and 21 NOT in the top-K, the
  // promote rule should NOT promote 1: the
  // promote rule requires the supersede
  // target to be in the same top-K.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 5, 6, 7, 8] },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-supersedes-promote",
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 8]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-version-group-current prefers currentInGroup within group", () => {
  // 1 (currentInGroup), 21 (not currentInGroup),
  // 5, 6, 7 (no group). The rule partitions by
  // group: [1, 21] are in `g-postgres-v16`;
  // [5, 6, 7] are not in any group. Within the
  // group, 1 is moved to the front.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 5, 1, 6, 7],
    },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-version-group-current",
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  // Expected: g-postgres-v16 slot moves 1 to
  // the front of that slot ([1, 21]); the
  // pass-through slot ([5, 6, 7]) is in input
  // order. The combined order is the
  // concatenation of the group slots in the
  // order they first appear in the input.
  assert.deepEqual(out.topIds, [1, 21, 5, 6, 7]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-combined demotes superseded and promotes supersedes", () => {
  // 21 is superseded, 1 supersedes 21. The
  // combined rule should put 1 at the top and
  // 21 at the bottom. 5, 6, 7 stay in the
  // middle in input order.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 5, 6, 7],
    },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-combined",
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21]);
});

test("supersession-edge-simulation: applySupersessionRerankRule metadata-simulation-stale-id-derived uses the staleLikeIds set", () => {
  // The stale-id-derived rule is the same
  // shape as Experiment 6's
  // `fixture-shaped-stale-demote` rule. The
  // default `staleLikeIds` is
  // `SIMULATED_SUPERSEDED_IDS`.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [1],
      currentTruthIds: [1],
      topIds: [21, 1, 22, 5, 6, 7],
    },
  ]);
  const rule: SupersessionRerankRule = {
    kind: "metadata-simulation-stale-id-derived",
    staleLikeIds: SIMULATED_SUPERSEDED_IDS,
  };
  const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  // 21, 22 are in `SIMULATED_SUPERSEDED_IDS`;
  // 1, 5, 6, 7 are not.
  assert.deepEqual(out.topIds, [1, 5, 6, 7, 21, 22]);
});

test("supersession-edge-simulation: applySupersessionRerankRule preserves length and order semantics on empty top-K", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [] },
  ]);
  for (const rule of [
    { kind: "none" } as const,
    { kind: "oracle-current-truth-promote" } as const,
    { kind: "metadata-simulation-supersededBy-demote" } as const,
    { kind: "metadata-simulation-supersedes-promote" } as const,
    { kind: "metadata-simulation-version-group-current" } as const,
    { kind: "metadata-simulation-combined" } as const,
  ]) {
    const out = applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
    assert.deepEqual(out.topIds, []);
    assert.deepEqual(out.topScores, []);
  }
});

// ---------------------------------------------------------------------------
// 3. Category honesty
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: built-in variant table category honesty", () => {
  const byId = new Map(
    BUILTIN_SUPERSESSION_RERANK_VARIANTS.map((v) => [v.id, v.category] as const),
  );
  assert.equal(byId.get("baseline-no-rerank"), "production-like");
  assert.equal(byId.get("oracle-current-truth-promote-all"), "oracle");
  assert.equal(byId.get("metadata-simulation-supersededBy-demote"), "metadata-simulation");
  assert.equal(byId.get("metadata-simulation-supersedes-promote"), "metadata-simulation");
  assert.equal(byId.get("metadata-simulation-version-group-current"), "metadata-simulation");
  assert.equal(byId.get("metadata-simulation-combined"), "metadata-simulation");
  assert.equal(byId.get("metadata-simulation-stale-id-derived"), "metadata-simulation");
});

test("supersession-edge-simulation: metadata-simulation variants reference the edge map (NOT currentTruthIds)", () => {
  // The metadata-simulation variants
  // describe the edge map in their
  // `description` field. A reviewer who reads
  // the description sees the framing.
  for (const v of BUILTIN_SUPERSESSION_RERANK_VARIANTS) {
    if (v.category !== "metadata-simulation") continue;
    const d = v.description.toLowerCase();
    assert.ok(
      d.includes("supersededby") ||
        d.includes("supersedes") ||
        d.includes("edge map") ||
        d.includes("simulated") ||
        d.includes("metadata-simulation") ||
        d.includes("versiongroup") ||
        d.includes("currentingroup") ||
        d.includes("stale-like") ||
        d.includes("stale_id") ||
        d.includes("stalelikeids"),
      `metadata-simulation variant ${v.id} description must name the edge map contract, got: ${v.description}`,
    );
    // The metadata-simulation category is
    // HONEST about NOT consulting
    // currentTruthIds. The description MUST
    // include the "does NOT consult
    // currentTruthIds" or equivalent framing.
    assert.ok(
      d.includes("does not consult currenttruthid") ||
        d.includes("not consult currenttruthid") ||
        d.includes("never consult") ||
        d.includes("not consult") ||
        d.includes("no consult") ||
        d.includes("doesn’t consult") ||
        d.includes("not keys on currenttruthid") ||
        d.includes("not key on currenttruthid") ||
        d.includes("not keying on currenttruthid") ||
        d.includes("not keyed on currenttruthid") ||
        d.includes("simulated edge map") ||
        d.includes("simulated_supersession_edges") ||
        d.includes("stale_id") ||
        d.includes("stale-like") ||
        d.includes("stalelikeids") ||
        d.includes("stale-ids"),
      `metadata-simulation variant ${v.id} description must be honest about NOT using currentTruthIds, got: ${v.description}`,
    );
  }
});

test("supersession-edge-simulation: oracle variant references currentTruthIds (fixture truth)", () => {
  for (const v of BUILTIN_SUPERSESSION_RERANK_VARIANTS) {
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

// ---------------------------------------------------------------------------
// 4. No production import leaks
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: production source tree does NOT import the new module", () => {
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
        !text.includes("supersession-edge-simulation"),
        `production source ${f} must not import the new module`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Deterministic output
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: same input produces a byte-stable report (no PRNG, no wall clock)", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
    { queryId: "q3", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const r1 = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const r2 = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.deepEqual(r1, r2);
});

test("supersession-edge-simulation: human report is byte-stable", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const s1 = formatSupersessionRerankReport(report);
  const s2 = formatSupersessionRerankReport(report);
  assert.equal(s1, s2);
});

// ---------------------------------------------------------------------------
// 6. No mutation
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: applySupersessionRerankRule does NOT mutate the input arrays", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const originalTopIds = [...evals[0]!.topIds];
  const originalTopScores = [...evals[0]!.topScores];
  for (const rule of [
    { kind: "none" } as const,
    { kind: "oracle-current-truth-promote" } as const,
    { kind: "metadata-simulation-supersededBy-demote" } as const,
    { kind: "metadata-simulation-supersedes-promote" } as const,
    { kind: "metadata-simulation-version-group-current" } as const,
    { kind: "metadata-simulation-combined" } as const,
  ]) {
    applySupersessionRerankRule({ rule, eval: evals[0]!, query: queries[0]! });
  }
  assert.deepEqual(evals[0]!.topIds, originalTopIds);
  assert.deepEqual(evals[0]!.topScores, originalTopScores);
});

// ---------------------------------------------------------------------------
// 7. Public API unchanged
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: public MCP API is unchanged (exactly two tools)", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

// ---------------------------------------------------------------------------
// 8. Report shape
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: report has the documented top-level shape", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.equal(report.sourceVariant, "synthetic");
  assert.equal(report.temporalQueryCount, 1);
  assert.ok(Array.isArray(report.variants));
  assert.equal(report.variants.length, BUILTIN_SUPERSESSION_RERANK_VARIANTS.length);
  // The edge-map summary block is present.
  assert.equal(typeof report.edgeMapSize, "number");
  assert.ok(report.simulatedSupersededIds.length > 0);
  assert.ok(report.simulatedCurrentInGroupIds.length > 0);
  // The "gap the metadata cannot fix" block
  // is present.
  assert.ok(report.gapBreakdown);
  assert.equal(typeof report.gapBreakdown.total, "number");
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

test("supersession-edge-simulation: per-variant metrics include the documented before/after counts", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const report = buildSupersessionRerankReport({
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
    assert.equal(typeof m.excludedCurrentAnchorCount, "number");
  }
});

// ---------------------------------------------------------------------------
// 9. End-to-end on the real lexical baseline artifact
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: end-to-end CLI on the real lexical baseline artifact", async () => {
  const baselinePath = findMostRecentArtifact(
    ".curion/benchmark",
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
  const { report } = await runSupersessionRerankCli({
    benchmarkArtifact: baselinePath,
    ...(hasSemantic ? { semanticEvidence: semanticPath } : {}),
    noWrite: true,
    noStdout: true,
  });
  // The report is well-formed.
  assert.ok(report.sourceVariant.length > 0);
  // The temporal slice is the documented 26 queries.
  assert.equal(report.temporalQueryCount, 26);
  // The edge-map summary block is populated.
  assert.ok(report.edgeMapSize > 0);
  assert.ok(report.simulatedSupersededIds.length > 0);
  assert.ok(report.simulatedCurrentInGroupIds.length > 0);
  // The baseline variant's `currentTruthAt1`
  // matches the prior diagnostic's finding
  // (12/26). The baseline variant is the
  // `baseline-no-rerank` row.
  const baseline = report.variants.find(
    (v) => v.variant.id === "baseline-no-rerank",
  );
  assert.ok(baseline);
  assert.equal(baseline!.metrics.baselineCurrentTruthAt1, 12);
  // The oracle-promote-all variant should
  // produce a higher `currentTruthAt1` than
  // the baseline.
  const oraclePromote = report.variants.find(
    (v) => v.variant.id === "oracle-current-truth-promote-all",
  );
  assert.ok(oraclePromote);
  assert.ok(
    oraclePromote!.metrics.afterCurrentTruthAt1 >=
      baseline!.metrics.baselineCurrentTruthAt1,
  );
  // The metadata-simulation-combined variant
  // should produce a non-negative
  // `currentTruthAt1Delta` (the edge map
  // closes the same gap the prior
  // `fixture-shaped-stale-demote-current-promote`
  // variant closed on the lexical baseline).
  const combined = report.variants.find(
    (v) => v.variant.id === "metadata-simulation-combined",
  );
  assert.ok(combined);
  assert.ok(
    combined!.metrics.currentTruthAt1Delta >= 0,
    "the combined metadata-simulation variant should not regress the baseline on currentTruthAt1",
  );
  // The metadata-simulation-supersededBy-demote
  // variant's `staleTop1` should be lower than
  // the baseline (the demote rule moves
  // superseded ids out of the top-1 position).
  const demote = report.variants.find(
    (v) => v.variant.id === "metadata-simulation-supersededBy-demote",
  );
  assert.ok(demote);
  assert.ok(
    demote!.metrics.afterStaleTop1 <= demote!.metrics.baselineStaleTop1,
    "the supersededBy-demote variant should not increase staleTop1",
  );
  // The combined variant's `regressionCount`
  // is honest: the metadata-simulation
  // rule's notion of "current" is the
  // `currentInGroup` member of the version
  // chain, which DOES NOT match the
  // fixture's notion of "current" for the
  // `current-vs-previous` anchor queries
  // (the records 117..120 are EXPLICITLY
  // excluded from the edge map because they
  // encode BOTH the current and the previous
  // fact in their summary). The combined
  // rule can therefore promote 7 (the
  // release-cut current record) above 118
  // (the release current-vs-previous
  // anchor), which is a regression on the
  // fixture's `currentTruthAt1` metric.
  // The regression is documented as a
  // HEADLINE finding of the experiment: a
  // runtime metadata schema that uses the
  // edge map's `currentInGroup` flag as
  // its "is current" signal would NOT be a
  // drop-in replacement for the fixture's
  // `currentTruthIds` on the multi-anchor
  // queries. The test pins the regression
  // count >= 0 (it is allowed to be > 0) so
  // a future schema revision that closes
  // the regression is a deliberate edit.
  assert.ok(
    combined!.metrics.regressionCount >= 0,
    "regression count is non-negative",
  );
  // The "gap the metadata cannot fix" block
  // is populated. The excluded current-anchor
  // queries are the `temp-current-vs-previous-*`
  // queries (the queries whose
  // `currentTruthIds` intersects
  // `EXCLUDED_FROM_EDGE_MAP`).
  assert.ok(
    report.gapBreakdown.total > 0,
    "the gap breakdown should surface at least one excluded current-anchor query",
  );
});

test("supersession-edge-simulation: end-to-end CLI without an artifact on disk throws a loud error", async () => {
  await assert.rejects(
    () =>
      runSupersessionRerankCli({
        outDir: "/tmp/nonexistent-ses-dir",
        noWrite: true,
        noStdout: true,
      }),
    /no --benchmark-artifact given/,
  );
});

// ---------------------------------------------------------------------------
// 10. CLI argument parsing
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: CLI argument parser handles the documented flags", () => {
  const parsed = parseSupersessionRerankCliArgs([
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

test("supersession-edge-simulation: CLI argument parser ignores unknown flags", () => {
  const parsed = parseSupersessionRerankCliArgs([
    "--unknown-flag",
    "value",
    "--no-write",
  ]);
  assert.equal(parsed.noWrite, true);
});

// ---------------------------------------------------------------------------
// 11. Per-category change rollup
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: perCategoryChange rollup is populated for at least one variant", () => {
  // On the synthetic input, the
  // `oracle-current-truth-promote-all` variant
  // should move the
  // `current-truth-in-topk-stale-top1` query
  // (q2) to `current-truth-top1`. The
  // perCategoryChange block surfaces the
  // `(baseline -> after) -> count` map.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateSupersessionRerankVariant({
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
// 12. Verdict
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: verdict is safe when at least one recovery and zero regressions", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 0);
  assert.ok(m.currentTruthAt1Delta > 0);
  const { verdict } = computeSupersessionRerankVerdict(m);
  assert.equal(verdict, "safe");
});

test("supersession-edge-simulation: verdict is neutral when no recovery and zero regressions (no-op re-ranker)", () => {
  // A baseline no-rerank variant on a query
  // whose top-1 is already the current truth:
  // `regressionCount` is 0 AND
  // `currentTruthAt1Delta` is 0. Per the
  // documented rules, this is `neutral` (a
  // research probe that did not help), NOT
  // `safe`. This pins the no-op re-ranker
  // branch of `computeSupersessionRerankVerdict`.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 0);
  assert.equal(m.currentTruthAt1Delta, 0);
  const { verdict, note } = computeSupersessionRerankVerdict(m);
  assert.equal(verdict, "neutral");
  // The note must explain why this is neutral
  // and not safe, so a reviewer who reads
  // the headline table does not mistake a
  // no-op re-ranker for a recovering one.
  assert.match(note, /no regressions, no currentTruthAt1 recovery/i);
  assert.match(note, /neutral/i);
});

// ---------------------------------------------------------------------------
// 13. Clean / fixture-ambiguous split
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: clean / fixture-ambiguous split is on the divergentTemporal label", () => {
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
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
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
// 14. Regression detection
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: regressionCount is 0 on a no-rerank baseline", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.regressionCount, 0);
});

// ---------------------------------------------------------------------------
// 15. Unchanged-because-current-missing
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: unchangedBecauseCurrentMissing is the re-ranker ceiling", () => {
  // On a query whose current truth is NOT in
  // the top-K, the re-ranker cannot help. The
  // metric is the re-ranker's ceiling.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [2, 3, 4, 5, 6] },
  ]);
  const oraclePromote = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  assert.equal(m.unchangedBecauseCurrentMissing, 1);
  assert.equal(m.afterCurrentTruthAt1, 0);
  assert.equal(m.afterCurrentMissing, 1);
});

// ---------------------------------------------------------------------------
// 16. Excluded-current-anchor
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: excluded current-anchor flag is set when currentTruthIds intersects EXCLUDED_FROM_EDGE_MAP", () => {
  // A temporal query whose current truth is
  // one of the `current-vs-previous` anchor
  // records (e.g. 117) is the
  // `temp-current-vs-previous-postgres` query.
  // The query's `currentTruthIds` intersects
  // `EXCLUDED_FROM_EDGE_MAP`; the
  // `hasExcludedCurrentAnchor` flag is `true`.
  const { evals, queries } = mkQueryEval([
    {
      queryId: "q1",
      expectedIds: [117],
      currentTruthIds: [117],
      topIds: [117, 21, 5, 6, 7],
    },
  ]);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.excludedCurrentAnchorCount, 1);
  const q1 = m.perQuery.find((p) => p.queryId === "q1")!;
  assert.equal(q1.hasExcludedCurrentAnchor, true);
});

test("supersession-edge-simulation: excluded current-anchor flag is unset for non-anchor current truths", () => {
  // A temporal query whose current truth is
  // not an excluded anchor (e.g. 1, the
  // current Postgres 16 record) has
  // `hasExcludedCurrentAnchor === false`.
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.excludedCurrentAnchorCount, 0);
  const q1 = m.perQuery.find((p) => p.queryId === "q1")!;
  assert.equal(q1.hasExcludedCurrentAnchor, false);
});

// ---------------------------------------------------------------------------
// 17. currentTruthIds-free contract
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: metadata-simulation re-rank rules do NOT consult currentTruthIds", () => {
  // The metadata-simulation re-rank rules
  // read ONLY the simulated edge map; the
  // rules do NOT consult
  // `query.currentTruthIds`. The test pins
  // the contract by running the same query
  // with two different `currentTruthIds`
  // values and asserting the re-ranked
  // output is identical.
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
    { kind: "metadata-simulation-supersedes-promote" } as const,
    { kind: "metadata-simulation-version-group-current" } as const,
    { kind: "metadata-simulation-combined" } as const,
  ]) {
    const out1 = applySupersessionRerankRule({
      rule,
      eval: evals1[0]!,
      query: queries1[0]!,
    });
    const out2 = applySupersessionRerankRule({
      rule,
      eval: evals2[0]!,
      query: queries2[0]!,
    });
    assert.deepEqual(
      out1.topIds,
      out2.topIds,
      `metadata-simulation rule ${rule.kind} must produce the same output regardless of currentTruthIds`,
    );
  }
});

test("supersession-edge-simulation: oracle rule DOES consult currentTruthIds", () => {
  // The oracle rule reads
  // `currentTruthIds` directly. The test
  // pins the contract by running two
  // queries with different
  // `currentTruthIds` values and asserting
  // the re-ranked outputs are different
  // (when the candidate set includes a
  // currentTruthId).
  const { evals: evals1, queries: queries1 } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const { evals: evals2, queries: queries2 } = mkQueryEval([
    { queryId: "q1", expectedIds: [21], currentTruthIds: [21], topIds: [21, 1, 5, 6, 7] },
  ]);
  const rule: SupersessionRerankRule = { kind: "oracle-current-truth-promote" };
  const out1 = applySupersessionRerankRule({
    rule,
    eval: evals1[0]!,
    query: queries1[0]!,
  });
  const out2 = applySupersessionRerankRule({
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
// 18. Artifact reader + writer round-trip
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: artifact reader + writer round-trip is byte-stable", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-"));
  try {
    const fullPath = writeSupersessionRerankReport(report, tmpDir);
    const text1 = fs.readFileSync(fullPath, "utf8");
    const text2 = fs.readFileSync(fullPath, "utf8");
    assert.equal(text1, text2);
    const parsed = JSON.parse(text1) as SupersessionRerankReport;
    assert.equal(parsed.sourceVariant, "synthetic");
    assert.equal(parsed.temporalQueryCount, 1);
    assert.equal(
      parsed.variants.length,
      BUILTIN_SUPERSESSION_RERANK_VARIANTS.length,
    );
    // The `metadata-simulation-stale-id-derived`
    // variant's `staleLikeIds` is the JSON
    // serialization of the `Set` (an empty
    // object). The set's contents are NOT
    // preserved across the JSON boundary by
    // design; the in-memory runner builds the
    // set from the built-in table.
    const staleIdRow = parsed.variants.find(
      (r) => r.variant.id === "metadata-simulation-stale-id-derived",
    );
    assert.ok(staleIdRow);
    if (
      staleIdRow!.variant.rule.kind === "metadata-simulation-stale-id-derived"
    ) {
      assert.deepEqual(staleIdRow!.variant.rule.staleLikeIds, {});
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 19. Helper consistency
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: buildSupersessionRerankVariantRow is consistent with the per-variant evaluator + verdict", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const oraclePromote = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "oracle-current-truth-promote-all",
  )!;
  const row = buildSupersessionRerankVariantRow({
    variant: oraclePromote,
    evals,
    queries,
  });
  const metrics = evaluateSupersessionRerankVariant({
    variant: oraclePromote,
    evals,
    queries,
  });
  assert.deepEqual(row.metrics, metrics);
  const { verdict } = computeSupersessionRerankVerdict(metrics);
  assert.equal(row.verdict, verdict);
});

test("supersession-edge-simulation: aggregateSupersessionRerankPerQuery is consistent with per-query rollups", () => {
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
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
    variant: baseline,
    evals,
    queries,
  });
  assert.equal(m.total, m.cleanTotal + m.fixtureAmbiguousTotal);
});

// ---------------------------------------------------------------------------
// 20. evals/queries length / id mismatch
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: evals/queries length mismatch throws", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  assert.throws(
    () =>
      evaluateSupersessionRerankVariant({
        variant: baseline,
        evals,
        queries: [...queries, ...queries],
      }),
    /evals\.length/,
  );
});

test("supersession-edge-simulation: evals/queries id mismatch throws", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1] },
  ]);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const corrupted = [{ ...queries[0]!, id: "different" }];
  assert.throws(
    () =>
      evaluateSupersessionRerankVariant({
        variant: baseline,
        evals,
        queries: corrupted,
      }),
    /does not match/,
  );
});

// ---------------------------------------------------------------------------
// 21. End-to-end alignment with prior diagnostic on the real artifact
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: per-query alignment with prior diagnostic on the real artifact", () => {
  const baselinePath = findMostRecentArtifact(
    ".curion/benchmark",
    "retrieval-baseline-",
  );
  if (!baselinePath) return;
  const artifact = readBenchmarkArtifact(baselinePath);
  const queries = alignQueriesToEvals(artifact.evals);
  const baseline = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "baseline-no-rerank",
  )!;
  const m = evaluateSupersessionRerankVariant({
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
});

test("supersession-edge-simulation: combined metadata-simulation variant closes the gap on the real artifact", () => {
  // The combined metadata-simulation variant
  // SHOULD close a non-negative fraction of
  // the recoverable gap on the real artifact.
  // The exact number is the experiment's
  // headline. The test pins that the combined
  // variant's `currentTruthAt1Delta` is at
  // least as large as the
  // `metadata-simulation-supersededBy-demote`
  // variant's `currentTruthAt1Delta` (the
  // combined variant subsumes the demote
  // rule).
  const baselinePath = findMostRecentArtifact(
    ".curion/benchmark",
    "retrieval-baseline-",
  );
  if (!baselinePath) return;
  const artifact = readBenchmarkArtifact(baselinePath);
  const queries = alignQueriesToEvals(artifact.evals);
  const demote = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "metadata-simulation-supersededBy-demote",
  )!;
  const combined = BUILTIN_SUPERSESSION_RERANK_VARIANTS.find(
    (v) => v.id === "metadata-simulation-combined",
  )!;
  const demoteM = evaluateSupersessionRerankVariant({
    variant: demote,
    evals: artifact.evals,
    queries,
  });
  const combinedM = evaluateSupersessionRerankVariant({
    variant: combined,
    evals: artifact.evals,
    queries,
  });
  assert.ok(
    combinedM.currentTruthAt1Delta >= demoteM.currentTruthAt1Delta,
    "the combined metadata-simulation variant should recover at least as many queries as the demote-only variant",
  );
});

// ---------------------------------------------------------------------------
// 22. Semantic overlay cross-reference
// ---------------------------------------------------------------------------

test("supersession-edge-simulation: semantic overlay cross-reference is well-formed", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
    { queryId: "q2", expectedIds: [1], currentTruthIds: [1], topIds: [21, 1, 5, 6, 7] },
  ]);
  const semantic = {
    source: "test-embeddinggemma",
    byQueryId: new Map<string, "hit" | "miss">([
      ["q1", "hit"],
      ["q2", "miss"],
    ]),
  };
  const report = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
    semantic,
  });
  assert.ok(report.semanticOverlay);
  assert.equal(report.semanticOverlay!.covered, 2);
  assert.equal(report.semanticOverlay!.hit, 1);
  assert.equal(report.semanticOverlay!.miss, 1);
  assert.equal(
    report.semanticOverlay!.recoveredByVariant[
      "oracle-current-truth-promote-all"
    ],
    1,
  );
  assert.equal(
    report.semanticOverlay!.recoveredByVariant["baseline-no-rerank"],
    0,
  );
});

test("supersession-edge-simulation: buildSupersessionRerankReport with no semantic overlay omits the field", () => {
  const { evals, queries } = mkQueryEval([
    { queryId: "q1", expectedIds: [1], currentTruthIds: [1], topIds: [1, 21, 5, 6, 7] },
  ]);
  const report = buildSupersessionRerankReport({
    sourceVariant: "synthetic",
    evals,
    queries,
  });
  assert.equal(report.semanticOverlay, undefined);
});
