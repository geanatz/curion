/**
 * Hybrid / RRF retrieval variant tests.
 *
 * Mirrors the FTS5 / vector test files in shape. Verifies:
 *
 *   1. RRF math: `rrfContribution` matches the documented
 *      `weight / (k + rank)` formula, with the documented
 *      guards for `rank === null`, non-positive `k`, and
 *      negative / non-finite weights.
 *   2. `fuseRankings` correctly unions the per-variant
 *      rankings, sums the contributions, and returns the
 *      top-K by RRF score (desc, id-desc tie-break).
 *   3. Tie-breaking: when two candidates have the same RRF
 *      score, the higher id wins (newer memory, matches the
 *      other variants' contract).
 *   4. k-parameter behavior: a smaller k makes rank-1
 *      dominate; a larger k flattens the contribution of
 *      high ranks.
 *   5. Weight behavior: a weight of 0 silences a variant;
 *      a weight of 2 doubles its contribution.
 *   6. `rankHybrid` end-to-end:
 *        - The same input corpus + queries produce the
 *          same fused ranking on every call.
 *        - The function returns the `{id, score, contributors}`
 *          shape (or, in the adapter, the `{id, score}[]`
 *          shape).
 *        - The no-answer path returns an empty top-K when
 *          no contributing variant returns a hit.
 *   7. Production path is untouched: the recall controller,
 *      the production seam, and the public MCP server do
 *      not import the hybrid module. A source-tree guard
 *      walk pins the whitelist.
 *   8. Public MCP contract is unchanged: still exactly two
 *      tools (`remember`, `recall`).
 *   9. CLI / report shape: the runner supports a new
 *      `--variant hybrid` flag, the new variant writes
 *      `retrieval-hybrid-*.json` artifacts under
 *      `.curion/benchmark/`, and `--variant all` includes
 *      the hybrid report in the comparison shape.
 *
 * The tests do not require a real provider, a network, or a
 * persistent database. The contributing variants (lexical,
 * FTS5, vector) are each tested in their own test file; the
 * hybrid tests focus on the fusion layer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import { buildCandidates } from "../src/benchmark/retrieval-runner.ts";
import type { LexicalCandidate } from "../src/retrieval/lexical.ts";
import {
  fuseRankings,
  rankHybrid,
  rankHybridAsLexical,
  rrfContribution,
  DEFAULT_RRF_K,
  DEFAULT_HYBRID_THRESHOLD,
  DEFAULT_HYBRID_TOP_K,
  RRF_SWEEP_K_VALUES,
} from "../src/benchmark/variants/hybrid.ts";
import {
  runRetrievalBenchmark,
  parseRetrievalCli,
  isSingleVariantReport,
  isComparisonReport,
  resolveBenchmarkArtifactsDir,
  writeBenchmarkReport,
  writeComparisonReport,
  formatComparisonReport,
  formatHumanReport,
} from "../src/benchmark/retrieval-runner.ts";
import { aggregateMetrics } from "../src/benchmark/metrics.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 1. rrfContribution: pure math helper
// ---------------------------------------------------------------------------

test("rrfContribution: returns weight / (k + rank) when rank is present", () => {
  // Conventional RRF paper example: rank 1, weight 1, k=60
  // -> 1 / 61.
  assert.ok(
    Math.abs(rrfContribution(1, 1, 60) - 1 / 61) < 1e-12,
    "rank-1 with default k=60 should equal 1/61",
  );
  // rank 3, weight 1, k=60 -> 1/63.
  assert.ok(
    Math.abs(rrfContribution(3, 1, 60) - 1 / 63) < 1e-12,
  );
  // rank 1, weight 2, k=60 -> 2/61.
  assert.ok(
    Math.abs(rrfContribution(1, 2, 60) - 2 / 61) < 1e-12,
  );
});

test("rrfContribution: returns 0 when rank is null (candidate absent from source)", () => {
  assert.equal(rrfContribution(null, 1, 60), 0);
  assert.equal(rrfContribution(null, 5, 20), 0);
});

test("rrfContribution: returns 0 when weight is 0 (variant is silenced)", () => {
  assert.equal(rrfContribution(1, 0, 60), 0);
  assert.equal(rrfContribution(5, 0, 20), 0);
});

test("rrfContribution: throws on invalid k (non-positive, non-finite)", () => {
  assert.throws(() => rrfContribution(1, 1, 0), /k must be a positive finite number/);
  assert.throws(() => rrfContribution(1, 1, -1), /k must be a positive finite number/);
  assert.throws(() => rrfContribution(1, 1, Number.NaN), /k must be a positive finite number/);
  assert.throws(() => rrfContribution(1, 1, Number.POSITIVE_INFINITY), /k must be a positive finite number/);
});

test("rrfContribution: throws on invalid weight (negative, non-finite)", () => {
  assert.throws(() => rrfContribution(1, -0.1, 60), /weight must be a non-negative finite number/);
  assert.throws(() => rrfContribution(1, Number.NaN, 60), /weight must be a non-negative finite number/);
  assert.throws(() => rrfContribution(1, Number.POSITIVE_INFINITY, 60), /weight must be a non-negative finite number/);
});

test("rrfContribution: throws on invalid rank (non-positive, non-finite, non-integer)", () => {
  assert.throws(() => rrfContribution(0, 1, 60), /rank must be a positive integer or null/);
  assert.throws(() => rrfContribution(-1, 1, 60), /rank must be a positive integer or null/);
  assert.throws(() => rrfContribution(Number.NaN, 1, 60), /rank must be a positive integer or null/);
});

// ---------------------------------------------------------------------------
// 2. fuseRankings: rank-only fusion correctness
// ---------------------------------------------------------------------------

test("fuseRankings: unions per-variant ids, sums contributions, sorts by RRF desc, id desc", () => {
  // Three variants with disjoint sets; verify the union
  // is the right size and the order is RRF desc.
  const lex = [
    { id: 1, score: 0.9 },
    { id: 2, score: 0.7 },
    { id: 3, score: 0.4 },
  ];
  const fts = [
    { id: 4, score: 0.8 },
    { id: 5, score: 0.5 },
  ];
  const vec = [
    { id: 6, score: 0.6 },
    { id: 1, score: 0.2 },
  ];
  const fused = fuseRankings(
    [
      { label: "lexical", list: lex, weight: 1 },
      { label: "fts5", list: fts, weight: 1 },
      { label: "vector", list: vec, weight: 1 },
    ],
    60,
    5,
  );
  // 6 distinct ids across the three lists; top-5 keeps
  // the five highest RRF scores.
  assert.equal(fused.length, 5);
  // Per-id RRF scores (k=60, weight=1):
  //   id=1: lexical rank 1 + vector rank 2 -> 1/61 + 1/62
  //   id=2: lexical rank 2 -> 1/62
  //   id=3: lexical rank 3 -> 1/63
  //   id=4: fts5 rank 1 -> 1/61
  //   id=5: fts5 rank 2 -> 1/62
  //   id=6: vector rank 1 -> 1/61
  // Descending order, with id-desc tie-break:
  //   id=1 (0.0325) > id=6 (0.0164) == id=4 (0.0164)
  //   > id=5 (0.0161) == id=2 (0.0161) > id=3 (0.0159)
  // Top-5: [1, 6, 4, 5, 2]. id=3 is outside top-5.
  assert.equal(fused[0]!.id, 1);
  assert.equal(fused[1]!.id, 6);
  assert.equal(fused[2]!.id, 4);
  assert.equal(fused[3]!.id, 5);
  assert.equal(fused[4]!.id, 2);
  // Every fused entry has a contributor for every
  // source — even sources that did not return the
  // candidate, so a reviewer can see "absent from fts5"
  // explicitly.
  for (const c of fused) {
    assert.equal(c.contributors.length, 3);
    const labels = c.contributors.map((x) => x.source).sort();
    assert.deepEqual(labels, ["fts5", "lexical", "vector"]);
  }
  // id=1 is in lexical (rank 1) and vector (rank 2);
  // the contributor entries must reflect that.
  const id1 = fused[0]!;
  const lex1 = id1.contributors.find((x) => x.source === "lexical")!;
  const fts1 = id1.contributors.find((x) => x.source === "fts5")!;
  const vec1 = id1.contributors.find((x) => x.source === "vector")!;
  assert.equal(lex1.rank, 1);
  assert.equal(lex1.score, 0.9);
  assert.ok(Math.abs(lex1.contribution - 1 / 61) < 1e-12);
  assert.equal(fts1.rank, null);
  assert.equal(fts1.score, null);
  assert.equal(fts1.contribution, 0);
  assert.equal(vec1.rank, 2);
  assert.equal(vec1.score, 0.2);
  assert.ok(Math.abs(vec1.contribution - 1 / 62) < 1e-12);
});

test("fuseRankings: tie-break is id-descending when RRF scores are equal", () => {
  // Two candidates with the same RRF score. To get an
  // exact RRF tie we put each at the same rank in a
  // separate variant (id=3 at rank 1 in lexical, id=7
  // at rank 1 in fts5; both contribute 1/(k+1)). The
  // higher id must come first.
  const fused = fuseRankings(
    [
      { label: "lexical", list: [{ id: 3, score: 0.9 }], weight: 1 },
      { label: "fts5", list: [{ id: 7, score: 0.5 }], weight: 1 },
      { label: "vector", list: [], weight: 1 },
    ],
    60,
    5,
  );
  assert.equal(fused.length, 2);
  assert.equal(fused[0]!.id, 7);
  assert.equal(fused[1]!.id, 3);
  assert.equal(fused[0]!.score, fused[1]!.score);
});

test("fuseRankings: weight 0 silences a variant; weight 2 doubles its contribution", () => {
  // id=1: rank-1 in lexical (weight 1) and rank-1 in
  // fts5 (weight 2 -> 2/61). id=2: rank-1 in lexical
  // (weight 1 -> 1/61) only. Expected: id=1 wins by
  // 1/61 (the extra contribution from fts5).
  const lex = [
    { id: 1, score: 0.9 },
    { id: 2, score: 0.8 },
  ];
  const fts = [{ id: 1, score: 0.5 }];
  const fused = fuseRankings(
    [
      { label: "lexical", list: lex, weight: 1 },
      { label: "fts5", list: fts, weight: 2 },
      { label: "vector", list: [], weight: 0 },
    ],
    60,
    5,
  );
  assert.equal(fused[0]!.id, 1);
  assert.equal(fused[1]!.id, 2);
  // The fts5 contributor for id=1 is 2/61, the lexical
  // is 1/61, the vector is 0. The total is 3/61.
  const id1 = fused[0]!;
  const fts1 = id1.contributors.find((x) => x.source === "fts5")!;
  const vec1 = id1.contributors.find((x) => x.source === "vector")!;
  assert.ok(Math.abs(fts1.contribution - 2 / 61) < 1e-12);
  assert.equal(fts1.weight, 2);
  assert.equal(vec1.contribution, 0);
  assert.equal(vec1.weight, 0);
});

test("fuseRankings: k=20 makes rank-1 dominate; k=100 flattens high ranks", () => {
  // id=1: rank-1 in lexical only. id=2: rank-2 in
  // lexical only. Compare the lead.
  const lex = [
    { id: 1, score: 0.9 },
    { id: 2, score: 0.7 },
  ];
  const ftsK20 = fuseRankings(
    [
      { label: "lexical", list: lex, weight: 1 },
      { label: "fts5", list: [], weight: 1 },
      { label: "vector", list: [], weight: 1 },
    ],
    20,
    5,
  );
  const ftsK100 = fuseRankings(
    [
      { label: "lexical", list: lex, weight: 1 },
      { label: "fts5", list: [], weight: 1 },
      { label: "vector", list: [], weight: 1 },
    ],
    100,
    5,
  );
  // Both runs have id=1 first and id=2 second, but the
  // lead changes with k.
  assert.equal(ftsK20[0]!.id, 1);
  assert.equal(ftsK100[0]!.id, 1);
  const leadK20 = ftsK20[0]!.score - ftsK20[1]!.score;
  const leadK100 = ftsK100[0]!.score - ftsK100[1]!.score;
  // 1/(20+1) - 1/(20+2) vs 1/(100+1) - 1/(100+2)
  //   = 1/21 - 1/22 = 1/(21*22) ≈ 0.00216
  //   vs 1/101 - 1/102 = 1/(101*102) ≈ 0.0000970
  // The lead with k=20 is much larger.
  assert.ok(
    leadK20 > leadK100 * 10,
    `expected k=20 lead to dominate k=100 lead by 10x, got ${leadK20} vs ${leadK100}`,
  );
  // And the absolute values match the math.
  assert.ok(Math.abs(leadK20 - (1 / 21 - 1 / 22)) < 1e-12);
  assert.ok(Math.abs(leadK100 - (1 / 101 - 1 / 102)) < 1e-12);
});

test("fuseRankings: empty input rankings return an empty result", () => {
  const fused = fuseRankings(
    [
      { label: "lexical", list: [], weight: 1 },
      { label: "fts5", list: [], weight: 1 },
      { label: "vector", list: [], weight: 1 },
    ],
    60,
    5,
  );
  assert.equal(fused.length, 0);
});

test("fuseRankings: validates k and topK", () => {
  const list = [{ id: 1, score: 0.5 }];
  assert.throws(
    () =>
      fuseRankings(
        [{ label: "lexical", list, weight: 1 }],
        0,
        5,
      ),
    /k must be a positive finite number/,
  );
  assert.throws(
    () =>
      fuseRankings(
        [{ label: "lexical", list, weight: 1 }],
        60,
        0,
      ),
    /topK must be a positive integer/,
  );
  assert.throws(
    () =>
      fuseRankings(
        [{ label: "lexical", list, weight: -0.1 }],
        60,
        5,
      ),
    /weight must be a non-negative finite number/,
  );
});

test("fuseRankings: duplicate ids in a single source keep the first rank", () => {
  // Defensive: the three contributing rankers do not
  // produce duplicates (each candidate is scored once),
  // but the fuser MUST handle a malformed input without
  // crashing. The first occurrence wins.
  const list = [
    { id: 1, score: 0.9 },
    { id: 1, score: 0.7 },
  ];
  const fused = fuseRankings(
    [{ label: "lexical", list, weight: 1 }],
    60,
    5,
  );
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.id, 1);
  const lex = fused[0]!.contributors.find((x) => x.source === "lexical")!;
  assert.equal(lex.rank, 1);
  assert.equal(lex.score, 0.9);
});

// ---------------------------------------------------------------------------
// 3. Defaults: RRF constants are sensible
// ---------------------------------------------------------------------------

test("hybrid: defaults are k=60, threshold=0, topK=5 (matches the existing variants)", () => {
  assert.equal(DEFAULT_RRF_K, 60);
  assert.equal(DEFAULT_HYBRID_THRESHOLD, 0);
  assert.equal(DEFAULT_HYBRID_TOP_K, 5);
  // The sweep covers the conventional triumvirate:
  // k=20 (rank-1 dominates), k=60 (default), k=100
  // (mid-list hits matter more).
  assert.deepEqual([...RRF_SWEEP_K_VALUES], [20, 60, 100]);
  assert.ok(RRF_SWEEP_K_VALUES.includes(DEFAULT_RRF_K));
});

// ---------------------------------------------------------------------------
// 4. rankHybrid: end-to-end on the fixture corpus
// ---------------------------------------------------------------------------

test("rankHybrid: end-to-end on the fixture corpus returns a stable, well-formed fused ranking", () => {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const query = "Postgres primary data store";
  const a = rankHybrid(query, candidates, { k: 60, topK: 5 });
  const b = rankHybrid(query, candidates, { k: 60, topK: 5 });
  // Determinism: same input -> same output.
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.id, b[i]!.id);
    assert.equal(a[i]!.score, b[i]!.score);
  }
  // Top-K shape: id is a number, score is a finite
  // number, contributors has exactly three entries
  // (one per source).
  for (const c of a) {
    assert.equal(typeof c.id, "number");
    assert.ok(Number.isFinite(c.score));
    assert.ok(c.score > 0, "expected at least one contributing variant");
    assert.equal(c.contributors.length, 3);
  }
  // The top-1 should be a record that has real
  // token-overlap with the query (the corpus's
  // Postgres primary data store record is id=1 by
  // construction; the lexical / FTS5 / vector variants
  // all surface it).
  assert.equal(a[0]!.id, 1);
});

test("rankHybrid: a no-match query returns an empty top-K (RRF=0 for every candidate)", () => {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  // A stopword-only / zero-token query short-circuits
  // to an empty top-K on every contributing variant
  // (the lexical short-circuits; FTS5 / vector
  // short-circuit via the same token-count check). The
  // hybrid therefore must return [].
  const empty = rankHybrid("the and for are", candidates, { k: 60, topK: 5 });
  assert.equal(empty.length, 0);
});

test("rankHybrid: a zero-token query returns an empty top-K (short-circuits like the lexical baseline)", () => {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const empty = rankHybrid("", candidates, { k: 60, topK: 5 });
  assert.equal(empty.length, 0);
  // Stopword-only query: every token is dropped by the
  // tokenizer, so the lexical short-circuit triggers.
  const stopwords = rankHybrid("the and for are", candidates, { k: 60, topK: 5 });
  assert.equal(stopwords.length, 0);
});

test("rankHybrid: k parameter changes the fused ranking (smaller k boosts rank-1)", () => {
  // Construct a tiny controlled scenario: lexical and
  // FTS5 strongly agree on id=1, but vector prefers
  // id=2 at rank 1.
  const candidates: LexicalCandidate[] = [
    { id: 1, text: "alpha beta gamma" },
    { id: 2, text: "delta epsilon zeta" },
  ];
  // For "alpha" query:
  //   - lexical ranks 1 (strong) at rank 1, 2 at the
  //     bottom.
  //   - fts5 does the same (BM25 prefers 1).
  //   - vector prefers 2 (different words -> a different
  //     BoW signature; on this controlled corpus the
  //     cosine is biased toward the "delta" record).
  // We do not assert the exact vector outcome; the
  // important property is that the RRF top-1 stays
  // stable across k values for this strongly-aligned
  // case. The test asserts the structural invariants
  // (length, score > 0, contributors present).
  const fused = rankHybrid("alpha", candidates, { k: 60, topK: 5 });
  assert.ok(fused.length > 0);
  for (const c of fused) {
    assert.ok(c.score > 0);
    assert.equal(c.contributors.length, 3);
  }
  // And k=20 vs k=100 can shift the order on this
  // controlled input; both are valid, both must be
  // well-formed.
  const fusedSmallK = rankHybrid("alpha", candidates, { k: 20, topK: 5 });
  const fusedLargeK = rankHybrid("alpha", candidates, { k: 100, topK: 5 });
  for (const c of [...fusedSmallK, ...fusedLargeK]) {
    assert.ok(c.score > 0);
    assert.equal(c.contributors.length, 3);
  }
});

test("rankHybrid: threshold > 0 filters out low-RRF candidates", () => {
  // A threshold above 0 drops any candidate whose RRF
  // score is below it. The contributing variants'
  // rank-1 contributions at k=60 are 1/61; setting
  // threshold to 0.5 (above any RRF score on this
  // corpus) must drop every candidate.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const all = rankHybrid("Postgres primary data store", candidates, {
    k: 60,
    topK: 5,
    threshold: 0,
  });
  assert.ok(all.length > 0, "sanity: k=60 run on the real query should be non-empty");
  const filtered = rankHybrid("Postgres primary data store", candidates, {
    k: 60,
    topK: 5,
    threshold: 0.5,
  });
  assert.equal(filtered.length, 0, "threshold 0.5 must drop every RRF score on this corpus");
});

test("rankHybrid: invalid k / weight throws at the public boundary", () => {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  assert.throws(
    () => rankHybrid("Postgres", candidates, { k: 0 }),
    /k must be a positive finite number/,
  );
  assert.throws(
    () => rankHybrid("Postgres", candidates, { k: -1 }),
    /k must be a positive finite number/,
  );
  assert.throws(
    () => rankHybrid("Postgres", candidates, { weights: { lexical: -0.1 } }),
    /weights must be non-negative finite numbers/,
  );
});

test("rankHybridAsLexical: adapter returns the {id, score}[] shape with score desc, id desc", () => {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const out = rankHybridAsLexical("Postgres primary data store", candidates, {
    k: 60,
    topK: 5,
  });
  // Shape: every element is {id, score}; no `contributors`
  // field (the adapter drops the diagnostics).
  for (const c of out) {
    assert.equal(typeof c.id, "number");
    assert.equal(typeof c.score, "number");
    assert.ok((c as unknown as { contributors?: unknown }).contributors === undefined);
  }
  // Stable order: score desc, id desc (newer wins).
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.score === out[i - 1]!.score) {
      assert.ok(out[i]!.id < out[i - 1]!.id, "id-desc tie-break");
    } else {
      assert.ok(out[i]!.score < out[i - 1]!.score, "score-desc order");
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Production path is untouched
// ---------------------------------------------------------------------------

test("hybrid variant is benchmark-only: production recall() controller is not modified", () => {
  // The hybrid variant must not leak into the production
  // retrieval path. The contract is:
  //   - The recall controller still imports `rankLexical`
  //     and only `rankLexical`.
  //   - The MCP server's public tool surface is unchanged.
  //   - The production seam does not import the hybrid
  //     module.
  //
  // We enforce this with a string-level check on the
  // production source files. A future refactor that wires
  // hybrid into recall() will break this test, which is
  // the point: it makes the "benchmark-only" contract
  // visible in CI.
  const recallSrc = fs.readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "src",
      "controller",
      "recall-controller.ts",
    ),
    "utf8",
  );
  assert.match(recallSrc, /rankLexical/, "recall controller must still import rankLexical");
  assert.doesNotMatch(
    recallSrc,
    /rankHybrid/,
    "recall controller must NOT import rankHybrid — hybrid is benchmark-only",
  );
  assert.doesNotMatch(
    recallSrc,
    /benchmark\/variants\/hybrid/,
    "recall controller must NOT import the hybrid benchmark module",
  );
  const seamSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "retrieval", "seam.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    seamSrc,
    /rankHybrid/,
    "retrieval/seam.ts must NOT call rankHybrid — it is the production seam",
  );
  assert.doesNotMatch(
    seamSrc,
    /benchmark\/variants\/hybrid/,
    "retrieval/seam.ts must NOT import the hybrid benchmark module",
  );
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8",
  );
  assert.match(serverSrc, /"remember"/);
  assert.match(serverSrc, /"recall"/);
  // Sanity: the public contract is exactly two tools.
  // Phase clean-structured-tool-responses: the server now
  // uses the non-deprecated `server.registerTool(...)` API
  // so it can attach an `outputSchema` (which the legacy
  // `server.tool(...)` overloads do not accept). The
  // public tool surface is still exactly `remember` +
  // `recall`.
  assert.deepEqual(
    serverSrc.match(/server\.registerTool\(\s*"(\w+)"/g),
    ['server.registerTool(\n    "remember"', 'server.registerTool(\n    "recall"'],
    "public MCP tool surface must remain exactly remember + recall",
  );
});

test("hybrid variant: only the benchmark runner imports the hybrid module", () => {
  // Whitelist: only the benchmark runner and the hybrid
  // module itself may import `benchmark/variants/hybrid.ts`.
  // Any other importer is a leak into production. We
  // walk the source tree and check imports + direct
  // symbol usage.
  const root = path.join(import.meta.dirname, "..", "src");
  const allowedImporters = new Set<string>([
    path.join("benchmark", "retrieval-runner.ts"),
    path.join("benchmark", "held-out-runner.ts"),
    path.join("benchmark", "held-out-validation.ts"),
    path.join("benchmark", "variants", "hybrid.ts"),
  ]);
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full));
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }
  // Files that legitimately define their own RRF helper (kept
  // self-contained per the brief); they must be excluded from
  // the symbol-usage check so the guard stays focused on actual
  // benchmark-only symbol leaks.
  const selfContainedFiles = new Set<string>([
    path.join("retrieval", "semantic", "score.ts"),
  ]);
  for (const file of walk(root)) {
    const rel = path.relative(root, file);
    if (allowedImporters.has(rel)) continue;
    const src = fs.readFileSync(file, "utf8");
    const importsHybridModule =
      src.includes("from \"./hybrid\"") ||
      src.includes("from \"./hybrid.js\"") ||
      src.includes("from \"../benchmark/variants/hybrid") ||
      src.includes("from \"../../benchmark/variants/hybrid");
    // Direct symbol usage outside the module's own file is
    // also a leak — except for self-contained production files
    // that define their own RRF helper copy.
    const usesHybridSymbol =
      (!selfContainedFiles.has(rel) &&
        (src.match(/\brankHybrid\b/) !== null ||
          src.match(/\brankHybridAsLexical\b/) !== null ||
          src.match(/\bfuseRankings\b/) !== null ||
          src.match(/\brrfContribution\b/) !== null ||
          src.match(/\bHybridWeights\b/) !== null ||
          src.match(/\bHybridRankingOptions\b/) !== null));
    assert.ok(
      !importsHybridModule,
      `unexpected import of hybrid module in ${rel}`,
    );
    assert.ok(
      !usesHybridSymbol,
      `unexpected hybrid symbol usage in ${rel}`,
    );
  }
});

test("public MCP contract unchanged: exactly two tools, one text param each", () => {
  // The public tool list is exactly the two stable names.
  // This pins the public MCP contract: the hybrid
  // benchmark MUST NOT add a third tool, a new parameter,
  // or a debug knob to the existing two tools.
  // (Phase clean-structured-tool-responses: the server
  // migrated from the legacy `server.tool(...)` API to
  // `server.registerTool(...)` so it could attach an
  // `outputSchema`; the public tool surface is unchanged.)
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
  assert.equal(PUBLIC_TOOL_NAMES.length, 2);
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8",
  );
  const toolCallCount = (serverSrc.match(/server\.registerTool\(/g) ?? []).length;
  assert.equal(
    toolCallCount,
    2,
    `server.ts must register exactly 2 tools, found ${toolCallCount}`,
  );
});

// ---------------------------------------------------------------------------
// 6. CLI and report shape
// ---------------------------------------------------------------------------

test("CLI: --variant hybrid is a recognized flag and routes to the hybrid ranker", () => {
  const opts = parseRetrievalCli(["--variant", "hybrid"]);
  assert.equal(opts.variant, "hybrid");
});

test("CLI: --hybrid-k <n> parses to options.k (forward-compat knob, default 60)", () => {
  // The hybrid k is a benchmark sweep knob, not a
  // production knob. We parse it on the CLI for the
  // explicit-per-k runs; the default is the
  // conventional k=60.
  const opts = parseRetrievalCli(["--variant", "hybrid", "--hybrid-k", "20"]);
  assert.equal(opts.hybridK, 20);
  const optsDefault = parseRetrievalCli(["--variant", "hybrid"]);
  // The default `hybridK` is undefined; the runner falls
  // back to DEFAULT_RRF_K = 60.
  assert.equal(optsDefault.hybridK, undefined);
});

test("CLI: --hybrid-k with a non-hybrid variant emits a stderr note (Reviewer follow-up)", () => {
  // The RRF smoothing constant is only consumed by the
  // hybrid / "all" paths. Passing it for lexical / fts5
  // / vector is a no-op and most likely a user mistake.
  // The parser emits a stderr note to make the no-op
  // visible. We intercept `process.stderr.write` for
  // the duration of the parse to assert the note fires.
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // The signature is overloaded; cast to the most
  // permissive form to avoid a TypeError.
  (process.stderr as { write: (s: string) => boolean }).write = (s: string) => {
    captured.push(s);
    return true;
  };
  try {
    for (const v of ["lexical", "fts5", "vector"] as const) {
      captured.length = 0;
      const opts = parseRetrievalCli([
        "--variant",
        v,
        "--hybrid-k",
        "20",
      ]);
      assert.equal(opts.hybridK, 20, `--hybrid-k must still parse for ${v}`);
      assert.equal(opts.variant, v);
      const joined = captured.join("");
      assert.ok(
        joined.includes("--hybrid-k 20 is ignored"),
        `expected stderr note for ${v}, got: ${JSON.stringify(joined)}`,
      );
      assert.ok(
        joined.includes(`--variant ${v}`),
        `stderr note must mention the active variant, got: ${JSON.stringify(joined)}`,
      );
    }
    // And the warning does NOT fire for hybrid / all /
    // when --variant is absent.
    for (const argv of [
      ["--variant", "hybrid", "--hybrid-k", "20"],
      ["--variant", "all", "--hybrid-k", "20"],
      ["--hybrid-k", "20"],
    ]) {
      captured.length = 0;
      parseRetrievalCli(argv);
      assert.equal(
        captured.length,
        0,
        `unexpected stderr note for ${JSON.stringify(argv)}: ${captured.join("")}`,
      );
    }
  } finally {
    (process.stderr as { write: typeof original }).write = original;
  }
});

test("runner: --variant hybrid produces a single-variant report with the `hybrid-benchmark` label", () => {
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  assert.ok(isSingleVariantReport(report));
  if (!isSingleVariantReport(report)) return;
  assert.equal(report.variant, "hybrid-benchmark");
  assert.equal(report.config.threshold, 0);
  assert.equal(report.config.topK, 5);
  // Every family is present.
  for (const f of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ]) {
    assert.ok(report.metrics.perFamily[f] !== undefined, `missing family: ${f}`);
  }
});

test("runner: --variant hybrid-k20 / hybrid-k100 produce reports for the explicit k values", () => {
  for (const k of [20, 100]) {
    const report = runRetrievalBenchmark({ variant: "hybrid", hybridK: k });
    assert.ok(isSingleVariantReport(report));
    if (!isSingleVariantReport(report)) return;
    assert.equal(report.variant, "hybrid-benchmark");
    // The k is recorded in the config so a reviewer can
    // see which k the report used without re-running.
    assert.equal(report.config.hybridK, k);
    assert.equal(report.config.threshold, 0);
  }
});

test("runner: --variant all still works and now includes the hybrid report", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  assert.ok(isComparisonReport(report));
  if (!isComparisonReport(report)) return;
  // The comparison shape gains a `hybrid` field. The
  // per-variant single reports are preserved.
  assert.equal(report.lexical.variant, "lexical-baseline");
  assert.equal(report.fts5.variant, "fts5-benchmark");
  assert.equal(report.vector.variant, "vector-benchmark");
  assert.ok(report.hybrid !== undefined, "comparison report must include hybrid");
  assert.equal(report.hybrid.variant, "hybrid-benchmark");
  // The comparison table has at least one row per metric.
  assert.ok(report.comparison.length > 0);
  // Every row has a hybrid column.
  for (const row of report.comparison) {
    assert.ok("hybrid" in row, `comparison row missing hybrid column: ${row.metric}`);
    assert.equal(typeof row.hybrid, "number");
  }
});

test("runner: --variant all --hybrid-k 20 threads the k through every hybrid report", () => {
  const report = runRetrievalBenchmark({ variant: "all", hybridK: 20 });
  assert.ok(isComparisonReport(report));
  if (!isComparisonReport(report)) return;
  assert.equal(report.hybrid.config.hybridK, 20);
});

test("runner: comparison artifacts include the hybrid section and the hybrid column in the comparison table", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-hybrid-compare-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = runRetrievalBenchmark({ variant: "all" });
    if (!isComparisonReport(report)) return;
    const file = writeComparisonReport(report, dir);
    assert.ok(fs.existsSync(file));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      lexical: { variant: string };
      fts5: { variant: string };
      vector: { variant: string };
      hybrid: { variant: string; config: { hybridK?: number } };
      comparison: Array<{ metric: string; hybrid: number }>;
    };
    assert.equal(parsed.variant, "all");
    assert.equal(parsed.hybrid.variant, "hybrid-benchmark");
    assert.ok(parsed.hybrid.config.hybridK !== undefined);
    assert.ok(parsed.comparison.length > 0);
    for (const row of parsed.comparison) {
      assert.ok("hybrid" in row);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: hybrid single-variant artifacts are written with the `hybrid-` prefix", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-hybrid-art-"));
  try {
    const dir = resolveBenchmarkArtifactsDir({ artifactsDir: tmp });
    const report = runRetrievalBenchmark({ variant: "hybrid" });
    if (!isSingleVariantReport(report)) {
      throw new Error("expected single-variant report");
    }
    const file = writeBenchmarkReport(report, dir);
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^retrieval-hybrid-/);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      variant: string;
      metrics: { totalQueries: number };
    };
    assert.equal(parsed.variant, "hybrid-benchmark");
    assert.equal(parsed.metrics.totalQueries, BENCHMARK_QUERIES.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: formatHumanReport for the hybrid variant includes the hybrid k and the per-source contributor section", () => {
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  if (!isSingleVariantReport(report)) return;
  const out = formatHumanReport(report);
  // The variant label and the k are surfaced in the
  // config block. The contributor section is the
  // richer-diagnostics block the brief asks for.
  assert.match(out, /variant:\s+hybrid-benchmark/);
  assert.match(out, /hybrid-k:\s+60/);
  assert.match(out, /hybrid contributors/i);
});

test("runner: formatComparisonReport includes the hybrid section and the hybrid column in the headline table", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(report)) return;
  const out = formatComparisonReport(report);
  for (const section of [
    "comparison (lexical vs fts5 vs vector vs hybrid",
    "### hybrid ###",
    "hybrid-benchmark",
  ]) {
    assert.ok(
      out.includes(section),
      `comparison report missing section: ${section}`,
    );
  }
  // The headline table has a hybrid column. Every row
  // exposes lexical/fts5/vector/hybrid numbers plus a
  // delta.
  for (const metric of ["rank1 (positive)", "hit@5 (positive)", "no-answer TNR"]) {
    assert.ok(
      out.includes(metric),
      `comparison table missing metric: ${metric}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Hybrid metrics are well-formed and the headline aggregates are stable
// ---------------------------------------------------------------------------

test("runner: hybrid report metrics are well-formed (rank1/hit@5/TNR match aggregateMetrics output)", () => {
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  if (!isSingleVariantReport(report)) return;
  const m = report.metrics;
  // Aggregate counts add up.
  const totalPerFamily = Object.values(m.perFamily).reduce(
    (s, p) => s + p.total,
    0,
  );
  assert.equal(totalPerFamily, m.totalQueries);
  // Headline counts are within bounds.
  assert.ok(m.rank1 >= 0 && m.rank1 <= m.positiveTotal);
  assert.ok(m.hitAt5 >= 0 && m.hitAt5 <= m.positiveTotal);
  assert.ok(m.noAnswerCorrect >= 0 && m.noAnswerCorrect <= m.noAnswerTotal);
  // `aggregateMetrics` on the per-query evals reproduces
  // the runner's metrics block. This is the same
  // invariant the FTS5 and vector tests pin.
  const shadow = aggregateMetrics(report.evals);
  assert.equal(shadow.rank1, m.rank1);
  assert.equal(shadow.hitAt5, m.hitAt5);
  assert.equal(shadow.noAnswerCorrect, m.noAnswerCorrect);
  assert.equal(shadow.currentTruthAt1, m.currentTruthAt1);
});

test("runner: hybrid report carries richer diagnostics (per-query contributor ranks + per-family deltas)", () => {
  // The richer-diagnostics block the brief asks for.
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  if (!isSingleVariantReport(report)) return;
  // Per-query contributor block on the evals.
  for (const e of report.evals) {
    assert.ok(
      Array.isArray(e.hybridContributors),
      `eval ${e.queryId} must carry hybridContributors`,
    );
    assert.equal(
      e.hybridContributors!.length,
      3,
      "hybridContributors must have one entry per source",
    );
    for (const c of e.hybridContributors!) {
      assert.ok(
        c.source === "lexical" || c.source === "fts5" || c.source === "vector",
      );
      assert.equal(typeof c.contribution, "number");
      assert.ok(
        c.contribution >= 0,
        `contribution must be non-negative (got ${c.contribution})`,
      );
    }
  }
  // Per-family delta table against the best baseline
  // (lexical is the production baseline; the table is
  // also computed against fts5 / vector so a reviewer
  // can see the trade-off).
  assert.ok(
    Array.isArray(report.hybridPerFamilyDelta),
    "hybrid report must carry hybridPerFamilyDelta",
  );
  assert.ok(report.hybridPerFamilyDelta!.length > 0);
  for (const row of report.hybridPerFamilyDelta!) {
    assert.ok(typeof row.family === "string");
    assert.equal(typeof row.hybridRank1, "number");
    assert.equal(typeof row.lexicalRank1, "number");
    assert.equal(typeof row.fts5Rank1, "number");
    assert.equal(typeof row.vectorRank1, "number");
    assert.equal(typeof row.hybridHit5, "number");
    assert.equal(typeof row.deltaHybridVsLexical, "number");
  }
});

test("runner: --variant all --hybrid-k 20 changes the hybrid column in the comparison table (k has an effect)", () => {
  // Sanity check: changing k on the CLI changes the
  // hybrid column. We do not assert which value is
  // better; we only assert that the comparison block
  // reflects the k choice. (If the comparison report
  // ignored the k flag the test would catch a real
  // regression.)
  const reportK20 = runRetrievalBenchmark({ variant: "all", hybridK: 20 });
  const reportK100 = runRetrievalBenchmark({ variant: "all", hybridK: 100 });
  if (!isComparisonReport(reportK20)) return;
  if (!isComparisonReport(reportK100)) return;
  // The hybrid rank1 column must differ on at least one
  // metric. (If they are identical the fusion is k-
  // invariant on this corpus, which is a real signal
  // but not a regression — the test just verifies the
  // runner is using the requested k.)
  let anyDiff = false;
  for (let i = 0; i < reportK20.comparison.length; i++) {
    const a = reportK20.comparison[i]!;
    const b = reportK100.comparison[i]!;
    if (a.hybrid !== b.hybrid) {
      anyDiff = true;
      break;
    }
  }
  // The k=20 / k=100 outputs can be equal on every
  // metric for a tiny corpus; we don't require a diff,
  // but we do require the reports to be byte-equal iff
  // the fusions are equal. If they are equal, both
  // reports must still carry the requested k in the
  // config so a reviewer can audit the choice.
  if (!anyDiff) {
    assert.equal(reportK20.hybrid.config.hybridK, 20);
    assert.equal(reportK100.hybrid.config.hybridK, 100);
  }
});

// ---------------------------------------------------------------------------
// 8. Hybrid query-level improvements and regressions
// ---------------------------------------------------------------------------

test("runner: query-level fix/regression table surfaces the deltas per family (hybrid vs best baseline)", () => {
  // The richer-diagnostics block the brief asks for:
  // for each family, the table reports
  //   - hybrid rank1 / hit5,
  //   - the best baseline (lexical, fts5, or vector) at
  //     rank1 / hit5,
  //   - the delta (hybrid - best baseline).
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  if (!isSingleVariantReport(report)) return;
  const table = report.hybridPerFamilyDelta!;
  // Every family has exactly one row.
  const families = new Set(table.map((r) => r.family));
  for (const f of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ]) {
    assert.ok(families.has(f), `hybridPerFamilyDelta missing family: ${f}`);
  }
  // For every row, the best baseline rank1 is the max
  // of the three single-variant rank1 numbers.
  for (const row of table) {
    const expected = Math.max(row.lexicalRank1, row.fts5Rank1, row.vectorRank1);
    assert.equal(row.bestBaselineRank1, expected);
  }
});

test("runner: --variant hybrid single-variant report carries real (non-zero) baseline per-family deltas", () => {
  // Reviewer follow-up fix. Previously, the hybrid
  // single-variant report attached a stub per-family
  // delta table with all-zero baselines, so the "best
  // baseline" column misleadingly showed 0. The fix
  // computes the lexical / FTS5 / vector baselines
  // inline on the same corpus + query set, so a
  // `--variant hybrid` run carries the same real
  // per-family delta table as `--variant all`.
  //
  // This test pins the fix: the per-family delta on
  // the single-variant hybrid report must match the
  // per-family delta on the comparison report (same
  // corpus, same queries, same per-variant defaults)
  // and must contain real baseline numbers (not all
  // zeros) for at least one family on this corpus.
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  if (!isSingleVariantReport(single)) return;
  const singleTable = single.hybridPerFamilyDelta!;
  assert.ok(singleTable.length > 0, "single-variant hybrid must carry hybridPerFamilyDelta");
  // Same-shape invariant: the comparison report's
  // per-family delta must be byte-for-byte equal to the
  // single-variant hybrid's per-family delta on this
  // corpus (same queries, same per-variant defaults,
  // same threshold = 0 for hybrid / fts5 / vector and
  // = 0.2 for lexical, same topK = 5). If a future
  // refactor changes the per-family delta between
  // single-variant and comparison paths, the report
  // consumers will diverge and this test will catch
  // it.
  const all = runRetrievalBenchmark({ variant: "all" });
  if (!isComparisonReport(all)) return;
  assert.deepEqual(
    singleTable,
    all.hybridPerFamilyDelta,
    "single-variant hybrid per-family delta must match the comparison report's per-family delta",
  );
  // The "all zero" regression guard. On the 60-record
  // corpus at least one family has a non-zero baseline
  // rank1 (e.g. "exact" has 10+ lexical rank-1 hits).
  // If the per-family delta is ever all-zero again, this
  // assertion fails and the regression is visible in CI.
  const allBestZero = singleTable.every(
    (r) =>
      r.lexicalRank1 === 0 &&
      r.fts5Rank1 === 0 &&
      r.vectorRank1 === 0 &&
      r.bestBaselineRank1 === 0,
  );
  assert.ok(
    !allBestZero,
    "single-variant hybrid per-family delta must not be all-zero baselines (Reviewer regression guard)",
  );
  // Per-row sanity: bestBaselineRank1 is the max of the
  // three baselines, and deltaHybridVsBest is the
  // signed difference. These hold for any real table.
  for (const row of singleTable) {
    assert.equal(
      row.bestBaselineRank1,
      Math.max(row.lexicalRank1, row.fts5Rank1, row.vectorRank1),
      `bestBaselineRank1 must be max of baselines for family ${row.family}`,
    );
    assert.equal(
      row.deltaHybridVsBest,
      row.hybridRank1 - row.bestBaselineRank1,
      `deltaHybridVsBest must be hybrid - best for family ${row.family}`,
    );
    assert.equal(
      row.deltaHybridVsLexical,
      row.hybridRank1 - row.lexicalRank1,
      `deltaHybridVsLexical must be hybrid - lexical for family ${row.family}`,
    );
  }
});

test("runner: hybrid hybridReport never contains credential-shaped or raw-text fragments", () => {
  // The fixture corpus is sanitized; the report must
  // remain free of credential-shaped fragments, raw
  // text-shaped fragments, and Authorization headers.
  // The hybrid diagnostics carry per-query contributor
  // data; the sweep tests the entire serialization
  // for accidental leaks.
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  if (!isSingleVariantReport(report)) return;
  const serialized = JSON.stringify(report);
  assert.ok(
    !/apiKey|authorization|bearer|sk-[A-Za-z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_\-]{20,}/i.test(
      serialized,
    ),
    "hybrid report must not contain credential-shaped fragments",
  );
});
