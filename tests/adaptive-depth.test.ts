/**
 * Tests for the adaptive recall depth helper.
 *
 * The helper replaces the fixed production `topK = 5` cap with a
 * deterministic, score-driven selection. These tests pin the
 * selector behavior on the canonical synthetic corpora the
 * branch's evaluation helper produces:
 *
 *   1. Narrow precise queries (one dominant memory) must stay
 *      tight: the selector must NOT include weak candidates
 *      below the relevance cluster, even when there are many of
 *      them.
 *   2. Broad queries with many closely relevant memories must
 *      grow: the selector must include all candidates above the
 *      relevance floor and within a coherent cluster, capped at
 *      `maxK`.
 *   3. Noisy candidates far below the cluster must be excluded.
 *   4. The diversity filter (opt-in) must dedupe near-duplicates
 *      and preserve non-redundant candidates.
 *   5. The prompt-budget step must truncate and drop with a
 *      deterministic, bounded outcome.
 *   6. End-to-end pipeline (`runAdaptiveDepth`) must compose
 *      selector + diversity + budget with stable ordering.
 *   7. The selector must remain deterministic across repeated
 *      calls (no randomness, no clock dependence).
 *   8. The `minK` floor must always be honoured (never fewer
 *      than `minK` candidates when the input has at least that
 *      many).
 *   9. The `maxK` cap must always be honoured (never more than
 *      `maxK` candidates in the output).
 *  10. The "plateau" strategy must produce a deterministic
 *      selection that respects `plateauTolerance` and `minK` /
 *      `maxK` caps.
 *  11. The internal evaluation helper must correctly report the
 *      two strategies' selections side by side.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AdaptiveCandidateWithText,
  type AdaptiveDepthPipelineConfig,
  applyDiversityFilter,
  applyPromptBudget,
  compareAdaptiveStrategies,
  resolveAdaptiveDepthConfig,
  runAdaptiveDepth,
  selectAdaptiveCandidates,
} from "../src/retrieval/adaptive-depth.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  id: number,
  score: number,
  text = `text for memory ${id}`,
  tags: string[] = []
): AdaptiveCandidateWithText {
  return { id, score, text, tags };
}

/**
 * Canonical "narrow precise" corpus: one dominant memory at the
 * top, then a steep drop, then a long tail of weak candidates.
 */
function narrowCorpus(): AdaptiveCandidateWithText[] {
  return [
    makeCandidate(1, 0.95, "Postgres is the primary database for the project."),
    makeCandidate(2, 0.4, "Office plants are watered on a biweekly rotation."),
    makeCandidate(3, 0.35, "The kitchen dishwasher runs nightly at 11pm."),
    makeCandidate(4, 0.3, "Conference room chairs are restocked monthly."),
    makeCandidate(5, 0.25, "Lunch orders are placed on Mondays for the team."),
    makeCandidate(6, 0.2, "The office has a foosball table near the kitchen."),
    makeCandidate(7, 0.18, "Snow removal is contracted out to a local firm."),
  ];
}

/**
 * Canonical "many closely relevant" corpus: a tight cluster of
 * memories all above 0.45 with a clear elbow to the rest.
 */
function broadCorpus(): AdaptiveCandidateWithText[] {
  const coreTexts = [
    "Project theme is minimal agent memory surfaces with conservative defaults.",
    "Project theme favors explicit tool contracts over implicit prompt conventions.",
    "Project theme keeps raw input out of any persisted memory table.",
    "Project theme routes multi-project recall through a registry of roots.",
    "Project theme uses lexical-only MVP retrieval before semantic opt-in.",
    "Project theme pins the public recall(text) tool to a single text parameter.",
    "Project theme exposes structuredContent for recall outcomes but never for remember.",
    "Project theme treats the synthesis LLM as best-effort and re-validates the answer.",
    "Project theme is small, deterministic, and easy to reason about per memory.",
    "Project theme separates safety pre-check from lexical ranking for defense in depth.",
  ];
  const out: AdaptiveCandidateWithText[] = coreTexts.map((t, i) =>
    makeCandidate(100 + i, 0.85 - i * 0.01, t)
  );
  // Append two weak tail candidates (one clearly in a separate cluster).
  out.push(makeCandidate(200, 0.2, "Office plants are watered on a biweekly rotation."));
  out.push(makeCandidate(201, 0.15, "Conference room chairs are restocked monthly."));
  return out;
}

// ---------------------------------------------------------------------------
// 1. Selector: narrow precise stays tight
// ---------------------------------------------------------------------------

test("adaptive-depth: narrow precise corpus keeps a small tight cluster (default elbow)", () => {
  const corpus = narrowCorpus();
  const result = selectAdaptiveCandidates(corpus, {});
  // The top-1 dominates at 0.95; the next score is 0.4 — a
  // 0.55 gap. The baseline (top minK=3) is always included
  // to preserve demoted-stale candidates and the
  // weak-corpus floor. The remainder candidates (0.3, 0.25,
  // 0.2, 0.18) are all below the relative floor (0.475 =
  // 0.95 * 0.5) so the elbow excludes them.
  assert.equal(
    result.selected.length,
    3,
    "narrow corpus should keep exactly the baseline (minK=3)"
  );
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [1, 2, 3],
    "narrow corpus should keep the top 3 by id (the baseline)"
  );
  assert.equal(result.trace.topScore, 0.95);
  assert.equal(result.trace.config.strategy, "elbow");
});

test("adaptive-depth: narrow precise with topK=5 cap (the production-equivalent config) returns the tight cluster only", () => {
  const corpus = narrowCorpus();
  // When the legacy topK=5 is requested and the cluster is
  // narrow (one strong + a steep drop), the selector must
  // honour the relative floor and the elbow cut. It MUST
  // NOT inflate the cluster because the legacy cap is "5".
  const result = selectAdaptiveCandidates(corpus, {
    minK: 3,
    maxK: 5,
    relativeFraction: 0.5,
  });
  assert.equal(
    result.selected.length,
    3,
    "narrow corpus with topK=5 still keeps only the tight cluster"
  );
});

// ---------------------------------------------------------------------------
// 2. Selector: broad corpus grows
// ---------------------------------------------------------------------------

test("adaptive-depth: broad corpus with a coherent cluster grows past the production topK=5", () => {
  const corpus = broadCorpus();
  const result = selectAdaptiveCandidates(corpus, {});
  // The cluster has 10 memories at scores 0.85 down to 0.76, all
  // within the relative floor (0.85 * 0.5 = 0.425) and within
  // the elbow tolerance (gaps <= 0.05). The selector must keep
  // all 10 because they sit in a coherent cluster with no elbow.
  assert.equal(
    result.selected.length,
    10,
    `broad corpus should keep all 10 cluster memories, got ${result.selected.length}`
  );
  // Score-desc order preserved.
  for (let i = 1; i < result.selected.length; i++) {
    assert.ok(
      result.selected[i - 1]!.score >= result.selected[i]!.score,
      `selected[${i - 1}]=${result.selected[i - 1]!.score} must be >= selected[${i}]=${result.selected[i]!.score}`
    );
  }
  // The two tail candidates (0.2 and 0.15) must be excluded.
  for (const c of result.selected) {
    assert.ok(c.id < 200, `tail candidate ${c.id} must be excluded`);
  }
});

test("adaptive-depth: maxK caps the cluster when there are many coherent memories", () => {
  // Build a cluster of 30 memories at a uniform score (no
  // gaps). The selector must cap at maxK.
  const corpus: AdaptiveCandidateWithText[] = [];
  for (let i = 0; i < 30; i++) {
    corpus.push(makeCandidate(1000 + i, 0.9 - i * 0.001, `broad memory ${i}`));
  }
  const result = selectAdaptiveCandidates(corpus, { maxK: 12 });
  assert.equal(result.selected.length, 12, "maxK cap must hold");
});

// ---------------------------------------------------------------------------
// 3. Selector: noisy tail excluded
// ---------------------------------------------------------------------------

test("adaptive-depth: noisy candidates below the relevance cluster are excluded", () => {
  // Two-cluster corpus: a tight cluster at 0.8 then a long
  // tail of weak candidates at 0.2. The selector must cut at
  // the gap, not bleed into the noise.
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.85, "Project uses Postgres 16 for the primary store."),
    makeCandidate(2, 0.83, "Project ships with a workspace CLI binary."),
    makeCandidate(3, 0.8, "Project uses lexical ranker as the MVP retrieval."),
    makeCandidate(4, 0.25, "Office plants are watered biweekly."), // gap of 0.55
    makeCandidate(5, 0.2, "Conference room chairs are restocked monthly."),
    makeCandidate(6, 0.18, "Lunch orders are placed on Mondays."),
  ];
  const result = selectAdaptiveCandidates(corpus, {
    minK: 3,
    maxK: 15,
    relativeFraction: 0.5,
    elbowGapTolerance: 0.05,
  });
  assert.equal(result.selected.length, 3, "tight cluster must be kept at exactly 3");
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [1, 2, 3]
  );
});

// ---------------------------------------------------------------------------
// 4. Selector: edge cases
// ---------------------------------------------------------------------------

test("adaptive-depth: empty input returns empty selection", () => {
  const result = selectAdaptiveCandidates([]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.trace.topScore, null);
});

test("adaptive-depth: single candidate is always kept", () => {
  const result = selectAdaptiveCandidates([makeCandidate(7, 0.9)]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]!.id, 7);
});

test("adaptive-depth: input smaller than minK keeps everything", () => {
  const corpus = [makeCandidate(1, 0.9), makeCandidate(2, 0.5)];
  const result = selectAdaptiveCandidates(corpus, { minK: 5 });
  assert.equal(result.selected.length, 2);
  assert.equal(result.trace.reason, "baseline only (input shorter than minK)");
});

test("adaptive-depth: equal scores keep id-desc tiebreak", () => {
  const corpus = [
    makeCandidate(1, 0.5),
    makeCandidate(2, 0.5),
    makeCandidate(3, 0.5),
    makeCandidate(4, 0.5),
  ];
  const result = selectAdaptiveCandidates(corpus, { minK: 4, maxK: 4 });
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [4, 3, 2, 1],
    "id-desc tiebreak on equal scores"
  );
});

// ---------------------------------------------------------------------------
// 5. Selector: config defaults and clamping
// ---------------------------------------------------------------------------

test("adaptive-depth: default config uses elbow strategy and bounded knobs", () => {
  const cfg = resolveAdaptiveDepthConfig();
  assert.equal(cfg.strategy, "elbow");
  assert.equal(cfg.minK, 3);
  assert.equal(cfg.maxK, 15);
  assert.equal(cfg.relativeFraction, 0.5);
  assert.equal(cfg.plateauTolerance, 0.05);
  assert.equal(cfg.elbowGapTolerance, 0.05);
});

test("adaptive-depth: clampInt clamps minK to [1, 50]", () => {
  const a = resolveAdaptiveDepthConfig({ minK: -10 });
  assert.equal(a.minK, 1);
  const b = resolveAdaptiveDepthConfig({ minK: 9999 });
  assert.equal(b.minK, 50);
});

test("adaptive-depth: clampNum clamps relativeFraction to [0, 1]", () => {
  const a = resolveAdaptiveDepthConfig({ relativeFraction: -1 });
  assert.equal(a.relativeFraction, 0);
  const b = resolveAdaptiveDepthConfig({ relativeFraction: 2 });
  assert.equal(b.relativeFraction, 1);
});

// ---------------------------------------------------------------------------
// 6. Plateau strategy
// ---------------------------------------------------------------------------

test("adaptive-depth: plateau strategy extends the cluster by tolerance", () => {
  // A corpus with a flat top, then small dips within
  // plateauTolerance, then a sharp drop. Plateau semantics:
  // walk while consecutive scores stay within plateauTolerance
  // of the previous kept candidate. A drop > plateauTolerance
  // ends the plateau.
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9),
    makeCandidate(2, 0.89),
    makeCandidate(3, 0.88),
    makeCandidate(4, 0.85), // 0.03 dip from baseline, kept
    makeCandidate(5, 0.82), // 0.03 dip, kept
    makeCandidate(6, 0.5), // 0.32 drop, exceeds tolerance, dropped
    makeCandidate(7, 0.2), // below relativeFloor, dropped
  ];
  const result = selectAdaptiveCandidates(corpus, {
    strategy: "plateau",
    minK: 3,
    maxK: 15,
    relativeFraction: 0.5,
    plateauTolerance: 0.05,
  });
  // Plateau extends through 0.85 and 0.82 (each drop = 0.03
  // <= 0.05). The drop to 0.5 (gap 0.32) exceeds the
  // tolerance and ends the plateau. So we expect ids 1..5.
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [1, 2, 3, 4, 5],
    "plateau must extend to include the 0.85 and 0.82 candidates"
  );
  // 6 and 7 are excluded by the sharp drop and the relative floor.
  assert.ok(!result.selected.some((c) => c.id === 6));
  assert.ok(!result.selected.some((c) => c.id === 7));
});

test("adaptive-depth: plateau respects relative floor (stops when score < relativeFloor)", () => {
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.4),
    makeCandidate(2, 0.1), // below relativeFloor = 0.2
    makeCandidate(3, 0.1),
  ];
  const result = selectAdaptiveCandidates(corpus, {
    strategy: "plateau",
    minK: 1,
    relativeFraction: 0.5,
    plateauTolerance: 0.5,
  });
  // Only id 1 is kept: 2 and 3 are below the relative floor.
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]!.id, 1);
});

// ---------------------------------------------------------------------------
// 7. Diversity filter
// ---------------------------------------------------------------------------

test("adaptive-depth: diversity filter dedupes near-duplicates when enabled", () => {
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(
      1,
      0.9,
      "The project uses Postgres 16 for the primary store. Postgres is the canonical database choice."
    ),
    makeCandidate(
      2,
      0.85,
      "The project uses Postgres 16 for the primary store. Postgres is the canonical database choice."
    ),
    makeCandidate(
      3,
      0.8,
      "Office plants are watered on a biweekly rotation by the facilities team."
    ),
  ];
  const result = applyDiversityFilter(corpus, {
    enabled: true,
    redundancyThreshold: 0.9,
  });
  // 1 and 2 are near-duplicates (>0.9 Jaccard); only the
  // higher-scoring one (1) is kept. 3 is non-redundant and
  // kept.
  assert.equal(result.length, 2, "near-duplicate must be deduped");
  assert.deepEqual(
    result.map((c) => c.id),
    [1, 3]
  );
});

test("adaptive-depth: diversity filter is opt-in (no-op when disabled)", () => {
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, "Postgres 16 for primary store Postgres is canonical."),
    makeCandidate(2, 0.85, "Postgres 16 for primary store Postgres is canonical."),
  ];
  const result = applyDiversityFilter(corpus, { enabled: false });
  assert.equal(result.length, 2, "no dedup when disabled");
});

test("adaptive-depth: diversity filter threshold=1.0 disables dedup", () => {
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, "Postgres 16 for primary store Postgres is canonical."),
    makeCandidate(2, 0.85, "Postgres 16 for primary store Postgres is canonical."),
  ];
  const result = applyDiversityFilter(corpus, {
    enabled: true,
    redundancyThreshold: 1.0,
  });
  assert.equal(result.length, 2);
});

test("adaptive-depth: diversity filter never drops non-redundant candidates", () => {
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, "Postgres is the primary database for the project."),
    makeCandidate(2, 0.85, "Office plants are watered biweekly by facilities team."),
    makeCandidate(3, 0.8, "Conference room chairs are restocked monthly by ops."),
  ];
  const result = applyDiversityFilter(corpus, {
    enabled: true,
    redundancyThreshold: 0.9,
  });
  assert.equal(result.length, 3, "all distinct candidates are kept");
});

// ---------------------------------------------------------------------------
// 8. Prompt budget
// ---------------------------------------------------------------------------

test("adaptive-depth: prompt budget truncates over-cap memories with a marker", () => {
  const longText = "word ".repeat(600).trim(); // ~3000 chars
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, longText),
    makeCandidate(2, 0.85, "short memory"),
  ];
  const result = applyPromptBudget(corpus, {
    totalCharBudget: 6000,
    perMemoryCharCap: 500,
    dropLowestWhenOverBudget: true,
  });
  // Memory 1 must be truncated to <= perMemoryCharCap (500)
  // plus the marker.
  const t1 = result.kept.find((k) => k.id === 1);
  assert.ok(t1, "memory 1 must be kept");
  assert.ok(
    t1.text.length <= 500 + "... [truncated]".length + 1,
    `truncated text must be <= perMemoryCap + marker, got ${t1.text.length}`
  );
  assert.match(t1.text, /\[truncated\]/);
  assert.equal(result.truncatedCount, 1, "exactly one memory truncated");
});

test("adaptive-depth: prompt budget drops the lowest-scoring candidates when over budget", () => {
  // Many long memories that together exceed the total budget.
  const longText = "x".repeat(800);
  const corpus: AdaptiveCandidateWithText[] = [];
  for (let i = 0; i < 12; i++) {
    corpus.push(makeCandidate(100 + i, 0.9 - i * 0.01, longText));
  }
  const result = applyPromptBudget(corpus, {
    totalCharBudget: 3000,
    perMemoryCharCap: 500,
    dropLowestWhenOverBudget: true,
  });
  // Each truncated memory is 500 chars + the "... [truncated]"
  // marker (14 chars) = 514 chars. With a 3000 total budget
  // we can fit 5 (5 * 514 = 2570 <= 3000; the 6th would push
  // us to 3084 > 3000).
  assert.equal(result.kept.length, 5, `expected 5 kept, got ${result.kept.length}`);
  assert.equal(result.droppedCount, 7, `expected 7 dropped, got ${result.droppedCount}`);
  // The kept ones are the highest-scoring (ids 100..104).
  const keptIds = result.kept.map((k) => k.id).sort((a, b) => a - b);
  assert.deepEqual(keptIds, [100, 101, 102, 103, 104], "highest-scoring memories are kept");
});

test("adaptive-depth: prompt budget is a no-op when totals fit", () => {
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, "short one"),
    makeCandidate(2, 0.85, "short two"),
  ];
  const result = applyPromptBudget(corpus, {
    totalCharBudget: 6000,
    perMemoryCharCap: 500,
    dropLowestWhenOverBudget: true,
  });
  assert.equal(result.kept.length, 2);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.truncatedCount, 0);
  assert.equal(result.totalChars, "short one".length + "short two".length);
});

test("adaptive-depth: prompt budget returns empty result for empty input", () => {
  const result = applyPromptBudget([], {
    totalCharBudget: 6000,
    perMemoryCharCap: 500,
  });
  assert.equal(result.kept.length, 0);
  assert.equal(result.totalChars, 0);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.truncatedCount, 0);
});

test("adaptive-depth: prompt budget config clamps perMemoryCap to >= 1", () => {
  const a = resolveAdaptivePromptBudgetConfig({ perMemoryCharCap: -5 });
  assert.ok(a.perMemoryCharCap >= 1);
  const b = resolveAdaptivePromptBudgetConfig({ perMemoryCharCap: 500 });
  assert.equal(b.perMemoryCharCap, 500);
});

// ---------------------------------------------------------------------------
// 9. Determinism: same input -> same output, repeated
// ---------------------------------------------------------------------------

test("adaptive-depth: selector is deterministic across repeated calls", () => {
  const corpus = broadCorpus();
  const r1 = selectAdaptiveCandidates(corpus, {});
  const r2 = selectAdaptiveCandidates(corpus, {});
  const r3 = selectAdaptiveCandidates(corpus, {});
  assert.deepEqual(r1.selected, r2.selected);
  assert.deepEqual(r2.selected, r3.selected);
});

test("adaptive-depth: pipeline is deterministic across repeated calls", () => {
  const corpus = broadCorpus();
  const config: AdaptiveDepthPipelineConfig = {
    selector: { strategy: "elbow", minK: 3, maxK: 15 },
    diversity: { enabled: false },
    budget: { totalCharBudget: 6000, perMemoryCharCap: 500 },
  };
  const r1 = runAdaptiveDepth(corpus, config);
  const r2 = runAdaptiveDepth(corpus, config);
  assert.deepEqual(
    r1.selected.map((c) => c.id),
    r2.selected.map((c) => c.id)
  );
  assert.equal(r1.trace.budget.totalChars, r2.trace.budget.totalChars);
});

// ---------------------------------------------------------------------------
// 10. End-to-end pipeline
// ---------------------------------------------------------------------------

test("adaptive-depth: pipeline composes selector + diversity + budget correctly", () => {
  // Mix of long unique and short unique memories plus duplicates.
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(
      1,
      0.9,
      "Project theme is minimal agent memory surfaces with conservative defaults and explicit tool contracts."
    ),
    makeCandidate(
      2,
      0.85,
      "Project theme is minimal agent memory surfaces with conservative defaults and explicit tool contracts."
    ), // dup
    makeCandidate(
      3,
      0.8,
      "Office plants are watered on a biweekly rotation by the facilities team."
    ),
    makeCandidate(4, 0.2, "Conference room chairs are restocked monthly."),
  ];
  const result = runAdaptiveDepth(corpus, {
    selector: { strategy: "elbow", minK: 3, maxK: 15 },
    diversity: { enabled: true, redundancyThreshold: 0.9 },
    budget: { totalCharBudget: 6000, perMemoryCharCap: 500 },
  });
  // 1 and 2 dedupe to 1. 3 and 4 are non-redundant. The
  // selector keeps all 4 in the cluster (scores 0.9, 0.85, 0.8,
  // 0.2 — the 0.2 is below the relative floor 0.45 so the
  // elbow cuts it). Diversity keeps 1, 3.
  assert.equal(result.trace.diversity.droppedByFilter, 1, "exactly one duplicate dropped");
  assert.equal(result.trace.selector.selectedCount, 3, "selector keeps 3 candidates");
  assert.equal(result.selected.length, 2, "final kept = 2");
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [1, 3]
  );
  assert.equal(result.trace.budget.truncatedCount, 0);
  assert.equal(result.trace.budget.droppedCount, 0);
});

// ---------------------------------------------------------------------------
// 11. Internal evaluation helper: compareAdaptiveStrategies
// ---------------------------------------------------------------------------

test("adaptive-depth: compareAdaptiveStrategies reports the same trace for both strategies on a narrow corpus", () => {
  const corpus = narrowCorpus();
  const result = compareAdaptiveStrategies(corpus, {});
  // The narrow corpus has one dominant memory and a steep
  // drop. Both strategies converge to the same selection
  // (the baseline, since no remainder candidate passes the
  // relative floor).
  assert.equal(result.narrow.selected.length, 3);
  assert.deepEqual(
    result.narrow.selected.map((c) => c.id),
    result.broad.selected.map((c) => c.id),
    "elbow and plateau must agree on the narrow corpus"
  );
});

test("adaptive-depth: compareAdaptiveStrategies reports different traces for broad corpus", () => {
  const corpus = broadCorpus();
  const result = compareAdaptiveStrategies(corpus, {});
  // The broad corpus has a coherent cluster. Both strategies
  // must keep the cluster, but the trace.reason may differ
  // (elbow reports "elbow kept N/M", plateau reports
  // "plateau kept N/M").
  assert.ok(
    result.narrow.trace.reason.startsWith("elbow") ||
      result.narrow.trace.reason.startsWith("plateau")
  );
  assert.ok(
    result.broad.trace.reason.startsWith("elbow") || result.broad.trace.reason.startsWith("plateau")
  );
  // The broad corpus must grow past topK=5 in both strategies.
  assert.ok(result.broad.selected.length > 5);
});

test("adaptive-depth: compareAdaptiveStrategies is deterministic", () => {
  const corpus = broadCorpus();
  const a = compareAdaptiveStrategies(corpus, {});
  const b = compareAdaptiveStrategies(corpus, {});
  assert.deepEqual(a.narrow.selected, b.narrow.selected);
  assert.deepEqual(a.broad.selected, b.broad.selected);
  assert.equal(a.narrow.trace.selectedCount, b.narrow.trace.selectedCount);
});

// ---------------------------------------------------------------------------
// 12. Diversity + budget integration: long unique memories survive truncation
// ---------------------------------------------------------------------------

test("adaptive-depth: pipeline truncates long unique memories without dropping them when budget allows", () => {
  const longText = "memory detail ".repeat(80).trim(); // ~1400 chars
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, longText),
    makeCandidate(2, 0.85, "short memory"),
  ];
  const result = runAdaptiveDepth(corpus, {
    selector: { strategy: "elbow", minK: 2, maxK: 15 },
    diversity: { enabled: false },
    budget: { totalCharBudget: 6000, perMemoryCharCap: 500 },
  });
  // Memory 1 truncated, memory 2 short; both kept.
  assert.equal(result.selected.length, 2);
  assert.equal(result.trace.budget.truncatedCount, 1);
  assert.equal(result.trace.budget.droppedCount, 0);
  const t1 = result.selected.find((c) => c.id === 1);
  assert.match(t1!.text, /\[truncated\]/);
});

// ---------------------------------------------------------------------------
// 13. Memory-content safety: helper never echoes raw content via trace
// ---------------------------------------------------------------------------

test("adaptive-depth: trace records are bounded and contain no memory content", () => {
  const secretText = "AKIAIOSFODNN7EXAMPLE super secret api key";
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(1, 0.9, secretText),
    makeCandidate(2, 0.85, "ordinary memory"),
  ];
  const result = runAdaptiveDepth(corpus, {});
  // The trace must NOT carry the secret-shaped text in any
  // field. Only the `selected` and `kept` arrays carry
  // content (which the controller projects to the safe
  // summary shape before synthesis).
  const traceJson = JSON.stringify(result.trace);
  assert.ok(
    !traceJson.includes("AKIAIOSFODNN7EXAMPLE"),
    `trace must not echo raw memory content; got ${traceJson}`
  );
});

// ---------------------------------------------------------------------------
// 14. Order preservation: selector preserves score-desc, id-desc order
// ---------------------------------------------------------------------------

test("adaptive-depth: selected list is score-desc, id-desc stable", () => {
  // Build a corpus with shuffled ids to make sure the
  // selector re-sorts defensively.
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(50, 0.55),
    makeCandidate(20, 0.95),
    makeCandidate(30, 0.75),
    makeCandidate(10, 0.85),
  ];
  const result = selectAdaptiveCandidates(corpus, {
    minK: 2,
    maxK: 10,
    relativeFraction: 0.5,
    elbowGapTolerance: 0.05,
  });
  // Expected order: score-desc -> id-desc tiebreak.
  // 0.95 -> 20 (top-1)
  // 0.85 -> 10 (top-2, baselineFloor=0.85)
  // remainder: 30 (0.75), 50 (0.55)
  // relativeFloor = 0.475
  // Both 0.75 and 0.55 are above 0.475 -> passes = [30, 50].
  // Gaps: baseline->30 = 0.10, 30->50 = 0.20.
  // Max gap = 0.20 at index 1 (between 30 and 50).
  // 0.20 > 0.05 (elbowGapTolerance), so cut at index 1
  //   (keep passes[0..0] = [30]).
  // Final order: [20, 10, 30]. The 0.55 candidate is cut by
  // the elbow.
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [20, 10, 30]
  );
});

test("adaptive-depth: uniform cluster survives the elbow (no large gap to cut at)", () => {
  // A uniform cluster: all gaps are small, so the elbow does
  // not cut. Every candidate is kept.
  const corpus: AdaptiveCandidateWithText[] = [
    makeCandidate(10, 0.9),
    makeCandidate(11, 0.88),
    makeCandidate(12, 0.86),
    makeCandidate(13, 0.84),
    makeCandidate(14, 0.82),
  ];
  const result = selectAdaptiveCandidates(corpus, {
    minK: 2,
    maxK: 10,
    relativeFraction: 0.5,
    elbowGapTolerance: 0.05,
  });
  // baselineFloor = 0.88. passes = [12 (0.86), 13 (0.84), 14 (0.82)].
  // Gaps: 0.88->0.86 = 0.02, 0.86->0.84 = 0.02, 0.84->0.82 = 0.02.
  // Max gap = 0.02 <= 0.05 -> keep everything.
  assert.deepEqual(
    result.selected.map((c) => c.id),
    [10, 11, 12, 13, 14]
  );
});
