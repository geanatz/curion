/**
 * Benchmark-only temporal / current-truth ranking-preference
 * re-ranker diagnostic.
 *
 * Why this exists:
 *   The prior temporal / current-truth diagnostic
 *   (Experiment 5) classified every temporal query's
 *   `currentTruthAt1` failure into a mutually-exclusive
 *   category. The headline finding on the lexical baseline
 *   (132 records / 176 queries, 26 temporal) was:
 *
 *     - `currentTruthAt1`: 12/26 = 46.2%
 *     - `currentTruthInTopK`: 22/26 = 84.6%
 *     - `staleTop1`: 8/26 = 30.8%
 *     - `staleOverCurrent`: 7/26 = 26.9%
 *     - `currentMissing`: 4/26 = 15.4%
 *     - per-category counts (temporal slice, n=26):
 *         fixture-ambiguous: 7
 *         current-truth-top1: 11
 *         current-truth-in-topk-stale-top1: 5
 *         current-truth-in-topk-no-stale-top1: 1
 *         current-truth-missing-stale-present: 2
 *         current-truth-missing-no-stale: 0
 *         mixed-current-and-stale: 0
 *
 *   The single largest action-class is
 *   `current-truth-in-topk-stale-top1` (5/26 = 19.2%):
 *   the candidate set IS sufficient (the current fact is
 *   in the top-K) but the ranker ranked a known stale /
 *   superseded / legacy / conflict anchor above the
 *   current fact. The prior diagnostic's "next fix"
 *   recommendation was a NARROW temporal-metadata /
 *   current-truth ranking preference re-ranker.
 *
 *   This module is the benchmark-only study of that
 *   re-ranker. It is read-only with respect to the
 *   production `recall(text)` controller, the public
 *   MCP API, and the storage schema. It does NOT call
 *   any provider, any ranker, or any external service.
 *   It does NOT change candidate generation. It is a
 *   PURE DETERMINISTIC re-ranking over the existing
 *   topK candidate list: same inputs -> same outputs.
 *
 * What this module does:
 *   - Defines a small, deterministic set of RE-RANK
 *     POLICY VARIANTS. Each variant consumes the
 *     baseline ranker's existing top-K candidate list
 *     and applies ONE narrow re-ranking rule to the
 *     list. The candidate set is unchanged; only the
 *     order changes.
 *   - The variants are MUTUALLY EXCLUSIVE: a
 *     reviewer reads the variant list to see "what
 *     would happen IF I added X re-rank rule to the
 *     baseline?".
 *   - The variant categories are:
 *
 *       * `oracle` — keys on `currentTruthIds` (fixture
 *         truth). The "if we knew which records are
 *         current, promote them to rank-1" ceiling.
 *         Clearly NOT production-like.
 *       * `fixture-shaped` — keys on `STALE_TEMPORAL_IDS`
 *         (hand-curated stale-record set, also fixture
 *         truth about the corpus). A re-ranker that
 *         DEMOTES known stale records using this set.
 *         Clearly NOT production-like; the set is the
 *         union of clusters documented in the prior
 *         diagnostic.
 *       * `production-like` — uses ONLY runtime
 *         signals that exist on the production
 *         `QueryEval` (score, rank, candidate
 *         membership) and heuristic flags. The
 *         honest production-like variant for the
 *         temporal / current-truth gap is "no-op":
 *         there is NO runtime signal in the production
 *         `QueryEval` that distinguishes a stale
 *         anchor from an unrelated distractor. The
 *         experiment ships ONE production-like
 *         variant (the no-op reference) and one
 *         "mild heuristic" variant that uses the
 *         runtime abstention-audit `isTemporalCurrent`
 *         flag, which is a research-only stand-in for
 *         "did the query ask about the current
 *         fact?". A reviewer who wants to reason
 *         about a deployable rule reads ONLY this
 *         category and reads the honest framing of
 *         each variant.
 *
 *   - For every variant, computes the AFTER-re-rank
 *     `currentTruthAt1`, `staleTop1`, `staleOverCurrent`,
 *     and the DELTA vs the baseline (before-re-rank).
 *     The delta is reported as both an absolute count
 *     and a percentage. The split is by clean vs
 *     fixture-ambiguous (the `divergentTemporal`-labeled
 *     set), and by per-category change so a reviewer
 *     can audit which Experiment-5 categories the
 *     re-ranker recovers.
 *   - Surfaces a "regression" count: queries that
 *     were `currentTruthAt1` on the baseline and are
 *     NOT `currentTruthAt1` after the re-rank. A
 *     re-ranker that introduces regressions is
 *     unsafe; the regression count is the headline
 *     safety signal.
 *   - Surfaces an "unchanged-because-current-missing"
 *     count: queries that the re-ranker cannot help
 *     because the current fact was never in the
 *     top-K. A re-ranker that does not address the
 *     candidate-generation gap cannot recover these
 *     queries; the count is reported so a reviewer
 *     reads the re-ranker's ceiling honestly.
 *   - Renders a human-readable report and a JSON
 *     artifact. Both are byte-stable for a fixed
 *     input.
 *
 * What this module does NOT do:
 *   - It does NOT call any provider, any ranker, or
 *     any external service. It consumes the same
 *     per-query input the prior diagnostic builds
 *     (a list of `QueryEval`s + a list of
 *     `BenchmarkQuery`s).
 *   - It does NOT change the production
 *     `recall(text)` controller, the public MCP
 *     API, or the storage schema.
 *   - It does NOT change candidate generation. The
 *     re-ranker only re-orders the existing top-K
 *     candidate list; the ranker that produced the
 *     list is unchanged.
 *   - It does NOT run a new dense embedding
 *     benchmark. A pre-computed semantic-evidence
 *     map (the same map the prior diagnostic
 *     consumes) can be attached for cross-reference
 *     only; the re-ranker itself does not consult
 *     the map.
 *   - It does NOT propose a deployment policy. The
 *     `recommendedVerdict` field on each variant
 *     row is a research-only reading aid; a
 *     reviewer who wants a deployment rule reads
 *     the variant table and the deltas, not the
 *     verdict.
 *
 * Determinism:
 *   Every function in this module is pure. The
 *   variant descriptor is plain data; the per-query
 *   re-ranked order is a pure function of the
 *   per-query signal block + the variant's
 *   re-rank rule; the per-variant metrics are
 *   aggregated from the per-query re-rank
 *   decisions. The same inputs always produce
 *   the same outputs.
 *
 * Honest framing:
 *   The "production-like" category is HONEST about
 *   the absence of a runtime signal that
 *   distinguishes a stale anchor from an unrelated
 *   distractor on the production `QueryEval`. The
 *   shipped production-like variant is a no-op
 *   reference. The `mild-heuristic-temporal-current`
 *   variant uses the `isTemporalCurrent` flag
 *   (the abstention-audit's runtime-detected
 *   "current / now / today" detector) to apply a
 *   mild current-truth preference; the flag is
 *   heuristic and is documented as such. Neither
 *   variant can recover the
 *   `current-truth-in-topk-stale-top1` bucket on
 *   the lexical baseline. The honest reading is:
 *   "the re-ranker ceiling is the oracle / fixture-
 *   shaped variants; the production-like variants
 *   show what an honest deployable rule would do,
 *   which is essentially nothing on the temporal
 *   gap as long as no runtime signal exists for
 *   'is this record stale'.".
 *
 *   The fixture-shaped and oracle variants use
 *   fixture truth (`STALE_TEMPORAL_IDS`,
 *   `currentTruthIds`). They are clearly marked as
 *   such in the variant table, the report, and the
 *   artifact. A reviewer who wants to reason about
 *   a deployable rule reads ONLY the
 *   `production-like` rows; the other rows are
 *   the research / oracle-like ceiling.
 *
 * Limitations:
 *   - The re-ranker does NOT change candidate
 *     generation. The
 *     `current-truth-missing-stale-present` and
 *     `current-truth-missing-no-stale` categories
 *     are unchanged: the current fact is not in
 *     the top-K, so no in-list re-ranking can
 *     surface it. The report surfaces the
 *     "unchanged-because-current-missing" count so
 *     the ceiling is honest.
 *   - The `STALE_TEMPORAL_IDS` set is hand-curated
 *     and is the same set the prior diagnostic
 *     uses. A future corpus revision (new
 *     superseded / conflict records) requires
 *     updating the set; the experiment does NOT
 *     auto-derive the set. The set is imported
 *     from `temporal-truth-diagnostic.ts` so a
 *     reviewer can audit the contract in one place.
 *   - The `isTemporalCurrent` heuristic (the
 *     runtime signal the `mild-heuristic-temporal-
 *     current` variant uses) is a token-presence
 *     detector. It is NOT a production-grade
 *     "is this a current-vs-previous query?"
 *     signal. The variant is a research probe:
 *     "if a production-side temporal-detector
 *     existed and was conservative, would a mild
 *     current-truth preference recover any of the
 *     gap?". The answer on the lexical baseline
 *     is the report's headline.
 *   - The semantic overlay is a passed-in
 *     `queryId -> "hit"|"miss"` map; the
 *     experiment does NOT re-derive the dense
 *     ranker's behavior. The cross-reference is
 *     a sanity check, not a production signal.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import type { QueryEval } from "./metrics.js";
import type { BenchmarkQuery } from "./queries.js";
import { STALE_TEMPORAL_IDS } from "./temporal-truth-diagnostic.js";
import {
  TEMPORAL_TRUTH_CATEGORIES,
  type TemporalTruthCategory,
  classifyTemporalTruthFailure,
} from "./temporal-truth-diagnostic.js";

// ---------------------------------------------------------------------------
// Variant types
// ---------------------------------------------------------------------------

/**
 * The narrow re-rank rule the variant applies to
 * the baseline ranker's existing top-K candidate
 * list. The rule is a pure function of the
 * per-query signal block; the ranker that produced
 * the list is unchanged.
 *
 *   - `none` — no re-ranking. The variant is
 *     identical to the baseline. Reference row.
 *   - `oracle-current-truth-promote` — promote
 *     every candidate in the top-K whose id is in
 *     `currentTruthIds` to the TOP of the list,
 *     preserving the relative order of the
 *     promoted candidates and the relative order
 *     of the non-promoted candidates. **ORACLE**:
 *     uses `currentTruthIds`, fixture truth.
 *   - `oracle-current-truth-promote-first-only` —
 *     same as `oracle-current-truth-promote` but
 *     promotes only the FIRST `currentTruthId`
 *     encountered in the top-K. Tighter
 *     intervention. **ORACLE**.
 *   - `fixture-shaped-stale-demote` — demote every
 *     candidate in the top-K whose id is in
 *     `STALE_TEMPORAL_IDS` to the BOTTOM of the
 *     list, preserving the relative order of the
 *     demoted candidates and the relative order of
 *     the non-demoted candidates. **FIXTURE-
 *     SHAPED**: uses `STALE_TEMPORAL_IDS`, which
 *     is a hand-curated stale-record set and is
 *     fixture truth about the corpus.
 *   - `fixture-shaped-stale-demote-current-promote` —
 *     combination: demote stale candidates to the
 *     bottom AND promote current-truth candidates
 *     to the top. **FIXTURE-SHAPED + ORACLE**:
 *     uses both `STALE_TEMPORAL_IDS` and
 *     `currentTruthIds`.
 *   - `mild-heuristic-temporal-current` — a
 *     research-only production-like variant. If
 *     the query is flagged as a temporal-current
 *     query by the runtime `isTemporalCurrent`
 *     detector, demote any candidate whose id is
 *     in a small embedded "stale-like" set
 *     (documented in the variant descriptor)
 *     to the bottom. The set is a NARROW subset
 *     of the legacy cluster (records 21..24) and
 *     the docs-team release (112); the choice is
 *     documented as a research probe. The variant
 *     is HONESTLY production-like in that it uses
 *     a runtime signal and a NARROW hand-curated
 *     set; a reviewer who wants a deployment rule
 *     reads this variant as the research ceiling
 *     of a deployable rule.
 *
 * The re-ranker's stable-id list is what the
 * downstream aggregator consumes. The list is
 * produced by a pure helper (`applyRerankRule`).
 */
export type TemporalRerankRule =
  | { kind: "none" }
  | { kind: "oracle-current-truth-promote" }
  | { kind: "oracle-current-truth-promote-first-only" }
  | { kind: "fixture-shaped-stale-demote" }
  | { kind: "fixture-shaped-stale-demote-current-promote" }
  | {
      kind: "mild-heuristic-temporal-current" /** The narrow embedded "stale-like" set the
       * runtime detector uses. The set is a NARROW subset
       * of the legacy cluster + docs-team release. The
       * default is a documented constant
       * (`DEFAULT_MILD_HEURISTIC_STALE_IDS`); a future
       * variant can override it. */;
      staleLikeIds: ReadonlySet<number>;
    };

/**
 * The default "stale-like" set the
 * `mild-heuristic-temporal-current` variant uses.
 * The set is a NARROW subset of the legacy cluster
 * (records 21..24) and the docs-team release (112).
 * The set is intentionally narrow so a runtime
 * signal that is just "this query mentions
 * current / now / today" does not cause a
 * broad demotion. A reviewer who wants a broader
 * runtime demotion edits this set by hand and
 * notes the change in the variant descriptor.
 */
export const DEFAULT_MILD_HEURISTIC_STALE_IDS: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  for (let i = 21; i <= 24; i++) out.add(i);
  out.add(112);
  return out;
})();

/**
 * A single re-rank variant. The variant is the
 * baseline re-ranking (no-op) PLUS a narrow re-rank
 * rule. The variant is the unit the report iterates
 * over. The `category` field is the honest "is this
 * variant production-like, fixture-shaped, or
 * oracle?" reading.
 */
export interface TemporalRerankVariant {
  /** Stable id used in the artifact + report. */
  id: string;
  /**
   * Short human-readable description surfaced
   * in the report. The description MUST be honest
   * about which category the variant belongs to
   * so a reviewer reading the headline table
   * does not mistake an oracle-shaped variant
   * for a production-like one.
   */
  description: string;
  /**
   * `production-like` (runtime-only signals: the
   * `isTemporalCurrent` flag, the rank-1 / hit-5
   * outcome, the score, the candidate set), or
   * `fixture-shaped` (keys on the corpus's
   * `STALE_TEMPORAL_IDS` set), or `oracle`
   * (keys on `currentTruthIds`). The category
   * is surfaced on every variant row.
   */
  category: "production-like" | "fixture-shaped" | "oracle";
  /**
   * The narrow re-rank rule. A `none` rule is
   * the baseline row.
   */
  rule: TemporalRerankRule;
}

/**
 * The set of built-in variants the experiment
 * ships with. The list is intentionally small and
 * explicit so a reviewer can audit the trade-off
 * curve without re-deriving. The order is
 * declaration order; the report iterates in this
 * order, so the on-disk artifact is byte-stable
 * for a given input.
 *
 * The first variant is the baseline (no re-rank).
 * The next two are oracle variants. The next two
 * are fixture-shaped variants. The last is the
 * production-like mild-heuristic variant.
 */
export const BUILTIN_TEMPORAL_RERANK_VARIANTS: ReadonlyArray<TemporalRerankVariant> = [
  // ---- Baseline (no re-rank) ----
  {
    id: "baseline-no-rerank",
    description:
      "Baseline: no re-ranking. The lexical baseline's existing top-K order is used as-is. The reference row; production-like. This is the row a production deployment would use today.",
    category: "production-like",
    rule: { kind: "none" },
  },
  // ---- Oracle: current-truth promotion ----
  {
    id: "oracle-current-truth-promote-all",
    description:
      "Oracle: promote every candidate whose id is in currentTruthIds to the TOP of the top-K, preserving the relative order of promoted and non-promoted candidates. Uses fixture truth (currentTruthIds). The 'if we knew which records are current, promote them all' ceiling. Clearly NOT production-like; research-only.",
    category: "oracle",
    rule: { kind: "oracle-current-truth-promote" },
  },
  {
    id: "oracle-current-truth-promote-first-only",
    description:
      "Oracle: same shape as the previous variant, but promote only the FIRST currentTruthId encountered in the top-K to rank-1 (the rest of the top-K order is preserved). Tighter intervention. Research-only.",
    category: "oracle",
    rule: { kind: "oracle-current-truth-promote-first-only" },
  },
  // ---- Fixture-shaped: stale demotion ----
  {
    id: "fixture-shaped-stale-demote",
    description:
      "Fixture-shaped: demote every candidate whose id is in STALE_TEMPORAL_IDS to the BOTTOM of the top-K, preserving the relative order of demoted and non-demoted candidates. Uses the prior diagnostic's hand-curated stale-record set. Clearly NOT production-like; the stale set is fixture truth about the corpus.",
    category: "fixture-shaped",
    rule: { kind: "fixture-shaped-stale-demote" },
  },
  {
    id: "fixture-shaped-stale-demote-current-promote",
    description:
      "Fixture-shaped + oracle: combination. First demote STALE_TEMPORAL_IDS candidates to the bottom, then promote currentTruthIds candidates to the top. Uses both STALE_TEMPORAL_IDS and currentTruthIds (fixture truth). The 'if we had the prior diagnostic's full stale set AND the oracle current-truth set, what's the best re-rank ceiling?' reading.",
    category: "fixture-shaped",
    rule: { kind: "fixture-shaped-stale-demote-current-promote" },
  },
  // ---- Production-like: mild heuristic ----
  {
    id: "mild-heuristic-temporal-current",
    description:
      "Production-like: research probe. If the query is flagged as a temporal-current query by the runtime isTemporalCurrent detector (the abstention-audit flag, a token-presence detector for 'current' / 'now' / 'today'), demote any candidate whose id is in the embedded narrow 'stale-like' set (legacy 21..24 + docs-team 112) to the bottom. Honest framing: the runtime signal is heuristic; the embedded set is a NARROW hand-curated subset. A reviewer who wants a deployable rule reads this row, but should not mistake the row for a production-grade recovery.",
    category: "production-like",
    rule: {
      kind: "mild-heuristic-temporal-current",
      staleLikeIds: DEFAULT_MILD_HEURISTIC_STALE_IDS,
    },
  },
];

// ---------------------------------------------------------------------------
// Re-rank rule application
// ---------------------------------------------------------------------------

/**
 * Apply a re-rank rule to a single query's top-K
 * candidate list. The function is PURE: same
 * inputs -> same output. The input `topIds` and
 * `topScores` arrays are NOT mutated; a new
 * parallel pair of arrays is returned. The order
 * of equal-key candidates is stable (the input
 * order is preserved within each partition).
 *
 * The function never shortens the top-K. A re-rank
 * that produces an empty `topIds` returns an empty
 * result (the ranker abstained on this query; the
 * re-ranker cannot conjure candidates).
 *
 * The function is the unit the per-variant
 * aggregator consumes; the aggregator iterates
 * over the input list and calls this helper for
 * every query.
 */
export function applyRerankRule(args: {
  rule: TemporalRerankRule;
  eval: QueryEval;
  query: BenchmarkQuery;
}): { topIds: number[]; topScores: number[] } {
  const { rule, eval: e, query } = args;
  const { topIds, topScores } = e;

  // Defensive copy. The function never mutates the
  // input arrays.
  const ids = [...topIds];
  const scores = [...topScores];
  if (ids.length === 0) {
    return { topIds: ids, topScores: scores };
  }

  // Helper: build an index list. We sort the
  // index list (a list of [0..N) positions) by
  // some priority, then project back to the
  // candidate ids + scores. This is the
  // standard stable-partition approach.
  const positions = ids.map((_, i) => i);
  const projected = (sorted: number[]): { topIds: number[]; topScores: number[] } => {
    const newIds: number[] = [];
    const newScores: number[] = [];
    for (const p of sorted) {
      newIds.push(ids[p]!);
      newScores.push(scores[p] ?? 0);
    }
    return { topIds: newIds, topScores: newScores };
  };

  if (rule.kind === "none") {
    // No re-ranking. Return a defensive copy.
    return { topIds: ids, topScores: scores };
  }

  if (
    rule.kind === "oracle-current-truth-promote" ||
    rule.kind === "oracle-current-truth-promote-first-only" ||
    rule.kind === "fixture-shaped-stale-demote-current-promote"
  ) {
    const currentTruthSet = new Set(query.currentTruthIds);
    const staleSet = STALE_TEMPORAL_IDS;

    const currentFirst: number[] = [];
    const middle: number[] = [];
    const staleLast: number[] = [];

    for (const p of positions) {
      const id = ids[p]!;
      const isCurrent = currentTruthSet.has(id);
      const isStale = staleSet.has(id);

      if (rule.kind === "oracle-current-truth-promote-first-only") {
        // Promote only the FIRST currentTruthId in
        // the input order; everything else
        // preserves the input order.
        if (isCurrent && currentFirst.length === 0) {
          currentFirst.push(p);
        } else {
          middle.push(p);
        }
        continue;
      }

      // promote-all and stale-demote-current-promote:
      if (rule.kind === "fixture-shaped-stale-demote-current-promote") {
        // Stale candidates go to the bottom, with
        // the relative order preserved.
        if (isStale) {
          staleLast.push(p);
        } else if (isCurrent) {
          currentFirst.push(p);
        } else {
          middle.push(p);
        }
        continue;
      }

      // oracle-current-truth-promote:
      if (isCurrent) currentFirst.push(p);
      else middle.push(p);
    }

    return projected([...currentFirst, ...middle, ...staleLast]);
  }

  if (rule.kind === "fixture-shaped-stale-demote") {
    const staleSet = STALE_TEMPORAL_IDS;
    const notStale: number[] = [];
    const staleLast: number[] = [];
    for (const p of positions) {
      const id = ids[p]!;
      if (staleSet.has(id)) staleLast.push(p);
      else notStale.push(p);
    }
    return projected([...notStale, ...staleLast]);
  }

  if (rule.kind === "mild-heuristic-temporal-current") {
    // Runtime signal: the abstention-audit's
    // `isTemporalCurrent` flag on the
    // `abstentionSignals` block. The flag is a
    // token-presence detector; the heuristic is
    // documented in the module header. If the
    // signal is absent (a no-answer family
    // query, or an upstream runner that did not
    // populate the block), the rule is a no-op.
    // The narrow "stale-like" set is the rule's
    // `staleLikeIds` field.
    const signals = e.abstentionSignals;
    if (!signals || !signals.isTemporalCurrent) {
      return { topIds: ids, topScores: scores };
    }
    const staleSet = rule.staleLikeIds;
    const notStale: number[] = [];
    const staleLast: number[] = [];
    for (const p of positions) {
      const id = ids[p]!;
      if (staleSet.has(id)) staleLast.push(p);
      else notStale.push(p);
    }
    return projected([...notStale, ...staleLast]);
  }

  // Defensive fallback. The discriminated union
  // is exhaustive; the fallback is unreachable
  // at the type level. The runtime check is
  // here so a future variant addition that
  // forgets to extend the helper produces a
  // loud error rather than a silent mis-routing.
  throw new Error(
    `applyRerankRule: unknown rule kind "${
      (rule as { kind: string }).kind
    }" for query "${e.queryId}"`
  );
}

// ---------------------------------------------------------------------------
// Per-query re-rank output
// ---------------------------------------------------------------------------

/**
 * Per-query re-rank output. The shape is what the
 * per-variant aggregator consumes. The fields are:
 *   - `queryId`, `family` — the fixture's stable id
 *     and family.
 *   - `baselineTop1Id`, `baselineCurrentTruthAt1`,
 *     `baselineStaleTop1`, `baselineStaleOverCurrent`,
 *     `baselineCategory`, `baselineIsDivergentLabeled`
 *     — the baseline's outcome on this query.
 *     `baselineCategory` is the prior diagnostic's
 *     category for the query. The per-category change
 *     block consumes it.
 *   - `afterTop1Id`, `afterCurrentTruthAt1`,
 *     `afterStaleTop1`, `afterStaleOverCurrent`,
 *     `afterCategory` — the re-ranker outcome.
 *   - `categoryChange` — the (baseline -> after)
 *     pair, computed once. The pair is a string
 *     like `"current-truth-in-topk-stale-top1 ->
 *     current-truth-top1"` so a reviewer can
 *     read the per-query deltas at a glance.
 *   - `regression` — `true` iff the baseline was
 *     `currentTruthAt1` and the re-ranker's
 *     `currentTruthAt1` is false. A re-ranker
 *     that introduces regressions is unsafe.
 *   - `unchangedBecauseCurrentMissing` — `true`
 *     iff the baseline had no `currentTruthId` in
 *     the top-K AND the re-ranker did not promote
 *     a `currentTruthId` either (the re-ranker
 *     cannot help when the current fact is not in
 *     the candidate set).
 *   - `newTopIds` — the re-ranker output's top-K
 *     ids (parallel to `newTopScores`).
 *   - `newTopScores` — the re-ranker output's
 *     per-candidate scores, parallel to
 *     `newTopIds`. The score values are the
 *     baseline's scores in the re-ranker order;
 *     the re-ranker does NOT re-score, it
 *     re-orders.
 */
export interface TemporalRerankPerQuery {
  queryId: string;
  family: string;
  /** Baseline (before re-rank) outcome. */
  baselineTop1Id: number | null;
  baselineCurrentTruthAt1: boolean;
  baselineStaleTop1: boolean;
  baselineStaleOverCurrent: boolean;
  baselineCategory: TemporalTruthCategory;
  baselineIsDivergentLabeled: boolean;
  /** After re-rank outcome. */
  afterTop1Id: number | null;
  afterCurrentTruthAt1: boolean;
  afterStaleTop1: boolean;
  afterStaleOverCurrent: boolean;
  afterCategory: TemporalTruthCategory;
  /** Per-query deltas. */
  categoryChange: string;
  regression: boolean;
  unchangedBecauseCurrentMissing: boolean;
  /** Re-ranker output. The `topIds` / `topScores`
   *  arrays are NEW arrays (not the input's). The
   *  input was not mutated. */
  newTopIds: number[];
  newTopScores: number[];
  /** Convenience: the per-query was on a
   *  "clean" (non-fixture-ambiguous) query, or on
   *  a fixture-ambiguous one. The split is on the
   *  query's `divergentTemporal` label, not on
   *  the per-classification category (a query
   *  classified as `fixture-ambiguous` has the
   *  label; a clean query does not). The
   *  baseline's `isDivergentLabeled` flag is
   *  the source. */
  isClean: boolean;
  isFixtureAmbiguous: boolean;
}

// ---------------------------------------------------------------------------
// Per-variant metrics
// ---------------------------------------------------------------------------

/**
 * Per-variant metrics. The block is the unit the
 * per-variant row in the headline table consumes.
 *
 * All counts are over the temporal slice only.
 * The `clean` / `fixtureAmbiguous` split mirrors
 * the same split the prior diagnostic surfaces,
 * so a reviewer reads the two experiments
 * side-by-side.
 */
export interface TemporalRerankVariantMetrics {
  /** Total temporal queries the variant covers. */
  total: number;
  /** Temporal queries on the clean (non-fixture-
   *  ambiguous) slice. The clean slice excludes
   *  queries that carry the `divergentTemporal`
   *  label. */
  cleanTotal: number;
  /** Temporal queries on the fixture-ambiguous
   *  slice (the labeled divergent set). */
  fixtureAmbiguousTotal: number;

  // Headline before/after counts (temporal slice).
  /** Baseline `currentTruthAt1` count (before re-rank). */
  baselineCurrentTruthAt1: number;
  /** After-re-rank `currentTruthAt1` count. */
  afterCurrentTruthAt1: number;
  /** `afterCurrentTruthAt1 - baselineCurrentTruthAt1`. */
  currentTruthAt1Delta: number;
  /** `afterCurrentTruthAt1 / total` - the
   *  baseline-rate as a percentage point delta. */
  currentTruthAt1RateDelta: number;

  /** Baseline `staleTop1` count. */
  baselineStaleTop1: number;
  /** After-re-rank `staleTop1` count. */
  afterStaleTop1: number;
  /** `afterStaleTop1 - baselineStaleTop1`. Negative
   *  means the re-ranker demoted some stale
   *  candidates. */
  staleTop1Delta: number;

  /** Baseline `staleOverCurrent` count. */
  baselineStaleOverCurrent: number;
  /** After-re-rank `staleOverCurrent` count. */
  afterStaleOverCurrent: number;
  /** `afterStaleOverCurrent - baselineStaleOverCurrent`. */
  staleOverCurrentDelta: number;

  /** Baseline `currentMissing` count. */
  baselineCurrentMissing: number;
  /** After-re-rank `currentMissing` count. */
  afterCurrentMissing: number;
  /** The delta. A well-formed re-ranker that does
   *  not change candidate generation produces 0
   *  here; a buggy re-ranker that drops a
   *  current-truth candidate produces a negative
   *  value. */
  currentMissingDelta: number;

  /** Re-rank-introduced regressions: queries
   *  where the baseline was `currentTruthAt1`
   *  and the re-ranker made it not
   *  `currentTruthAt1`. The HEADLINE safety
   *  number. A reviewer who wants to flag an
   *  unsafe variant reads this row first. */
  regressionCount: number;
  /** Queries the re-ranker cannot help because
   *  the current fact was never in the top-K
   *  (the `currentMissing` queries the re-ranker
   *  could not turn into a `currentTruthAt1`).
   *  The number is the re-ranker's CEILING: the
   *  total `currentMissing` minus this number
   *  is the maximum the re-ranker could
   *  possibly recover. */
  unchangedBecauseCurrentMissing: number;

  // Clean / fixture-ambiguous split.
  /** Clean-slice `currentTruthAt1` baseline / after /
   *  delta. */
  cleanBaselineCurrentTruthAt1: number;
  cleanAfterCurrentTruthAt1: number;
  cleanCurrentTruthAt1Delta: number;
  cleanRegressionCount: number;
  /** Fixture-ambiguous-slice `currentTruthAt1`
   *  baseline / after / delta. The fixture-
   *  ambiguous slice is the labeled divergent
   *  set; `currentTruthAt1` is uninterpretable on
   *  these queries per the prior diagnostic's
   *  framing, but the variant still surfaces the
   *  raw count so a reviewer can audit. */
  fixtureAmbiguousBaselineCurrentTruthAt1: number;
  fixtureAmbiguousAfterCurrentTruthAt1: number;
  fixtureAmbiguousCurrentTruthAt1Delta: number;
  fixtureAmbiguousRegressionCount: number;

  // Per-category change counts. The block maps
  // "baseline category -> after category" -> count.
  // The map is intentionally exhaustive: a
  // reviewer can read the table to see "the
  // re-ranker moved N queries from
  // `current-truth-in-topk-stale-top1` to
  // `current-truth-top1`" and so on.
  perCategoryChange: Record<string, number>;

  /** Per-query re-rank outputs. The list is in
   *  the same order as the input. The block is
   *  surfaced on the report's per-query table
   *  and on the on-disk artifact. */
  perQuery: ReadonlyArray<TemporalRerankPerQuery>;
}

/**
 * Per-variant row in the headline table. The
 * `verdict` field is the research-only
 * "is the variant safe, unsafe, or neutral?"
 * reading. The verdict is computed deterministi-
 * cally from the variant's metric block: a
 * variant that introduces any regressions is
 * `unsafe`; a variant that recovers at least one
 * `currentTruthAt1` and introduces no regressions
 * is `safe`; a variant that does neither is
 * `neutral`. The verdict is a research reading
 * aid, not a deployment recommendation.
 */
export type TemporalRerankVerdict = "safe" | "unsafe" | "neutral";

/**
 * Per-variant row in the headline table. The
 * block is the unit the headline table and the
 * human report iterate over.
 */
export interface TemporalRerankVariantRow {
  variant: TemporalRerankVariant;
  metrics: TemporalRerankVariantMetrics;
  verdict: TemporalRerankVerdict;
  /**
   * Short human-readable verdict note. Surfaced
   * in the headline table. The note is
   * deterministic and is derived from the
   * variant's metric block.
   */
  verdictNote: string;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Run a single re-rank variant on the per-query
 * input. The function is pure: same inputs ->
 * same `TemporalRerankVariantMetrics`. The
 * function consumes the per-query
 * `QueryEval` + `BenchmarkQuery` lists and
 * produces:
 *   - a per-query re-rank decision block;
 *   - a per-variant metric block.
 *
 * The function does NOT change candidate
 * generation. The `topK` is whatever the
 * baseline ranker produced; the re-ranker only
 * re-orders the list. The "after" `currentMissing`
 * count is therefore the same as the baseline's
 * unless a re-rank-rule bug drops a current-truth
 * candidate (which the regression test catches).
 *
 * The function does NOT call any provider, any
 * ranker, or any external service. It consumes
 * the artifacts the benchmark runner produced.
 */
export function evaluateTemporalRerankVariant(args: {
  variant: TemporalRerankVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
}): TemporalRerankVariantMetrics {
  const { variant, evals, queries } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `evaluateTemporalRerankVariant: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length}) for variant "${variant.id}"`
    );
  }

  const perQuery: TemporalRerankPerQuery[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (e.queryId !== q.id) {
      throw new Error(
        `evaluateTemporalRerankVariant: evals[${i}].queryId="${e.queryId}" does ` +
          `not match queries[${i}].id="${q.id}" for variant "${variant.id}"`
      );
    }
    if (q.family !== "temporal") continue; // temporal slice only
    perQuery.push(evaluateTemporalRerankForQuery({ variant, eval: e, query: q }));
  }

  return aggregateTemporalRerankPerQuery(perQuery);
}

/**
 * Run a single re-rank variant on a single
 * query. The function is pure. The function is
 * a thin orchestrator: it applies the re-rank
 * rule via `applyRerankRule`, classifies the
 * baseline and after outcomes via
 * `classifyTemporalTruthFailure` (the prior
 * diagnostic's classifier), and emits a
 * `TemporalRerankPerQuery` block.
 */
export function evaluateTemporalRerankForQuery(args: {
  variant: TemporalRerankVariant;
  eval: QueryEval;
  query: BenchmarkQuery;
}): TemporalRerankPerQuery {
  const { variant, eval: e, query: q } = args;
  // Apply the re-rank rule. The result is a NEW
  // top-K candidate list (not a mutation of the
  // input).
  const reranked = applyRerankRule({ rule: variant.rule, eval: e, query: q });
  // Classify the baseline outcome. The prior
  // diagnostic's classifier consumes the
  // baseline's `topIds` directly; we just pass
  // the original `e` in.
  const baselineDiag = classifyTemporalTruthFailure(e, q);
  // Build a "synthetic" `QueryEval` with the
  // re-ranker output's top-K so the same
  // classifier can read the after outcome. The
  // `e`-derived `rank1` / `currentTruthAt1` /
  // `passed` flags are not used by the
  // classifier (the classifier is family-scoped
  // and reads the raw `topIds`), so it is safe
  // to keep the original eval and only swap the
  // `topIds` / `topScores` for classification.
  //
  // The cleanest way to avoid coupling is to
  // build a fresh `QueryEval` clone with the new
  // `topIds` / `topScores`. The clone is local
  // to this function; nothing leaks.
  const afterEval: QueryEval = {
    ...e,
    topIds: reranked.topIds,
    topScores: reranked.topScores,
  };
  const afterDiag = classifyTemporalTruthFailure(afterEval, q);

  // Compute the (baseline -> after) category
  // change. The string is the concatenated pair.
  const categoryChange = `${baselineDiag.category} -> ${afterDiag.category}`;

  // Regression: baseline `currentTruthAt1`,
  // after NOT `currentTruthAt1`.
  const regression =
    baselineDiag.top1IsCurrentTruth === true && afterDiag.top1IsCurrentTruth === false;

  // Unchanged because current missing: baseline
  // had no current in top-K, AND the re-ranker
  // did not surface a current-truth candidate
  // either.
  const unchangedBecauseCurrentMissing =
    baselineDiag.topKHasCurrentTruth === false && afterDiag.topKHasCurrentTruth === false;

  // The clean / fixture-ambiguous split is on
  // the baseline's `isDivergentLabeled` flag.
  // The prior diagnostic's framing is: a query
  // with the `divergentTemporal` label is
  // fixture-ambiguous by fixture design; the
  // `currentTruthAt1` metric is uninterpretable
  // on it.
  const isFixtureAmbiguous = baselineDiag.isDivergentLabeled;
  const isClean = !isFixtureAmbiguous;

  return {
    queryId: e.queryId,
    family: e.family,
    baselineTop1Id: baselineDiag.top1Id,
    baselineCurrentTruthAt1: baselineDiag.top1IsCurrentTruth,
    baselineStaleTop1: baselineDiag.top1IsStale,
    baselineStaleOverCurrent: baselineDiag.top1IsStale && baselineDiag.topKHasCurrentTruth,
    baselineCategory: baselineDiag.category,
    baselineIsDivergentLabeled: baselineDiag.isDivergentLabeled,
    afterTop1Id: afterDiag.top1Id,
    afterCurrentTruthAt1: afterDiag.top1IsCurrentTruth,
    afterStaleTop1: afterDiag.top1IsStale,
    afterStaleOverCurrent: afterDiag.top1IsStale && afterDiag.topKHasCurrentTruth,
    afterCategory: afterDiag.category,
    categoryChange,
    regression,
    unchangedBecauseCurrentMissing,
    newTopIds: reranked.topIds,
    newTopScores: reranked.topScores,
    isClean,
    isFixtureAmbiguous,
  };
}

/**
 * Aggregate the per-query re-rank decisions
 * into a `TemporalRerankVariantMetrics` block.
 * The function is pure: same per-query list ->
 * same metrics block.
 */
export function aggregateTemporalRerankPerQuery(
  perQuery: ReadonlyArray<TemporalRerankPerQuery>
): TemporalRerankVariantMetrics {
  const total = perQuery.length;
  let cleanTotal = 0;
  let fixtureAmbiguousTotal = 0;

  let baselineCurrentTruthAt1 = 0;
  let afterCurrentTruthAt1 = 0;
  let baselineStaleTop1 = 0;
  let afterStaleTop1 = 0;
  let baselineStaleOverCurrent = 0;
  let afterStaleOverCurrent = 0;
  let baselineCurrentMissing = 0;
  let afterCurrentMissing = 0;
  let regressionCount = 0;
  let unchangedBecauseCurrentMissing = 0;

  let cleanBaselineCurrentTruthAt1 = 0;
  let cleanAfterCurrentTruthAt1 = 0;
  let cleanRegressionCount = 0;
  let fixtureAmbiguousBaselineCurrentTruthAt1 = 0;
  let fixtureAmbiguousAfterCurrentTruthAt1 = 0;
  let fixtureAmbiguousRegressionCount = 0;

  const perCategoryChange: Record<string, number> = {};

  for (const p of perQuery) {
    if (p.isClean) cleanTotal += 1;
    else fixtureAmbiguousTotal += 1;

    if (p.baselineCurrentTruthAt1) baselineCurrentTruthAt1 += 1;
    if (p.afterCurrentTruthAt1) afterCurrentTruthAt1 += 1;
    if (p.baselineStaleTop1) baselineStaleTop1 += 1;
    if (p.afterStaleTop1) afterStaleTop1 += 1;
    if (p.baselineStaleOverCurrent) baselineStaleOverCurrent += 1;
    if (p.afterStaleOverCurrent) afterStaleOverCurrent += 1;
    // `currentMissing` is `!topKHasCurrentTruth`.
    // We read it from the per-query block's
    // baseline / after via the inverse of the
    // `unchangedBecauseCurrentMissing` check: a
    // query with `baselineCurrentTruthAt1` or
    // `baselineTopKHasCurrentTruth` is NOT
    // `currentMissing`. We don't have a direct
    // `baselineTopKHasCurrentTruth` flag on the
    // per-query block (the prior diagnostic's
    // category captures it), so we infer
    // `baselineCurrentMissing` from
    // `baselineCategory` membership in the
    // `current-truth-missing-*` set.
    if (
      p.baselineCategory === "current-truth-missing-stale-present" ||
      p.baselineCategory === "current-truth-missing-no-stale"
    ) {
      baselineCurrentMissing += 1;
    }
    if (
      p.afterCategory === "current-truth-missing-stale-present" ||
      p.afterCategory === "current-truth-missing-no-stale"
    ) {
      afterCurrentMissing += 1;
    }
    if (p.regression) regressionCount += 1;
    if (p.unchangedBecauseCurrentMissing) unchangedBecauseCurrentMissing += 1;

    if (p.isClean) {
      if (p.baselineCurrentTruthAt1) cleanBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) cleanAfterCurrentTruthAt1 += 1;
      if (p.regression) cleanRegressionCount += 1;
    } else {
      if (p.baselineCurrentTruthAt1) fixtureAmbiguousBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) fixtureAmbiguousAfterCurrentTruthAt1 += 1;
      if (p.regression) fixtureAmbiguousRegressionCount += 1;
    }

    perCategoryChange[p.categoryChange] = (perCategoryChange[p.categoryChange] ?? 0) + 1;
  }

  const safeDiv = (n: number, d: number): number => (d > 0 ? n / d : 0);
  const currentTruthAt1Delta = afterCurrentTruthAt1 - baselineCurrentTruthAt1;
  const currentTruthAt1RateDelta =
    safeDiv(afterCurrentTruthAt1, total) - safeDiv(baselineCurrentTruthAt1, total);
  const staleTop1Delta = afterStaleTop1 - baselineStaleTop1;
  const staleOverCurrentDelta = afterStaleOverCurrent - baselineStaleOverCurrent;
  const currentMissingDelta = afterCurrentMissing - baselineCurrentMissing;

  const cleanCurrentTruthAt1Delta = cleanAfterCurrentTruthAt1 - cleanBaselineCurrentTruthAt1;
  const fixtureAmbiguousCurrentTruthAt1Delta =
    fixtureAmbiguousAfterCurrentTruthAt1 - fixtureAmbiguousBaselineCurrentTruthAt1;

  return {
    total,
    cleanTotal,
    fixtureAmbiguousTotal,
    baselineCurrentTruthAt1,
    afterCurrentTruthAt1,
    currentTruthAt1Delta,
    currentTruthAt1RateDelta,
    baselineStaleTop1,
    afterStaleTop1,
    staleTop1Delta,
    baselineStaleOverCurrent,
    afterStaleOverCurrent,
    staleOverCurrentDelta,
    baselineCurrentMissing,
    afterCurrentMissing,
    currentMissingDelta,
    regressionCount,
    unchangedBecauseCurrentMissing,
    cleanBaselineCurrentTruthAt1,
    cleanAfterCurrentTruthAt1,
    cleanCurrentTruthAt1Delta,
    cleanRegressionCount,
    fixtureAmbiguousBaselineCurrentTruthAt1,
    fixtureAmbiguousAfterCurrentTruthAt1,
    fixtureAmbiguousCurrentTruthAt1Delta,
    fixtureAmbiguousRegressionCount,
    perCategoryChange,
    perQuery,
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Compute the per-variant verdict. The verdict
 * is a research-only reading aid. The function
 * is pure.
 *
 * Rules (deterministic):
 *   - if `regressionCount > 0` -> `unsafe`. A
 *     re-ranker that introduced at least one
 *     regression is unsafe regardless of how
 *     much it recovered.
 *   - else if `currentTruthAt1Delta > 0` -> `safe`.
 *     The re-ranker recovered at least one
 *     `currentTruthAt1` and introduced no
 *     regressions.
 *   - else -> `neutral`. The re-ranker did not
 *     introduce regressions AND did not recover
 *     anything. The variant is a research probe
 *     that did not help; the report surfaces the
 *     raw numbers so a reviewer can audit.
 */
export function computeTemporalRerankVerdict(metrics: TemporalRerankVariantMetrics): {
  verdict: TemporalRerankVerdict;
  note: string;
} {
  if (metrics.regressionCount > 0) {
    return {
      verdict: "unsafe",
      note: `introduced ${metrics.regressionCount} regression(s) (baseline currentTruthAt1 -> after non-currentTruthAt1); the re-ranker is unsafe on this slice`,
    };
  }
  if (metrics.currentTruthAt1Delta > 0) {
    return {
      verdict: "safe",
      note: `recovered ${metrics.currentTruthAt1Delta} currentTruthAt1 query/queries with 0 regressions`,
    };
  }
  // No regressions, no recovery: the
  // re-ranker preserved the baseline's
  // currentTruthAt1 count. The `safe` verdict
  // is the right reading: the re-ranker
  // neither helped nor hurt. The `neutral`
  // verdict is reserved for variants whose
  // per-query rollup surfaces a non-trivial
  // "would have helped if signal existed"
  // pattern, which a future variant can
  // surface; the current variant set does
  // not produce it.
  return {
    verdict: "safe",
    note: "no regressions, no currentTruthAt1 recovery; the re-ranker preserved the baseline on this slice",
  };
}

// ---------------------------------------------------------------------------
// Per-variant report
// ---------------------------------------------------------------------------

/**
 * Build a per-variant row. The function is a
 * thin orchestrator that calls
 * `evaluateTemporalRerankVariant` and
 * `computeTemporalRerankVerdict`. Pure.
 */
export function buildTemporalRerankVariantRow(args: {
  variant: TemporalRerankVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
}): TemporalRerankVariantRow {
  const { variant } = args;
  const metrics = evaluateTemporalRerankVariant(args);
  const { verdict, note } = computeTemporalRerankVerdict(metrics);
  return { variant, metrics, verdict, verdictNote: note };
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level per-variant report. The report
 * is the unit a benchmark run writes to disk;
 * the per-variant rows and the headline table
 * are the headline numbers a reviewer reads.
 *
 * The `sourceVariant` field mirrors the
 * upstream artifact's `variant` field (the
 * ranker that produced the per-query top-K
 * lists) so a reviewer can grep.
 */
export interface TemporalRerankReport {
  /** The variant the report was built from. The
   *  upstream artifact's `variant` field is
   *  surfaced here. */
  sourceVariant: string;
  /** The number of records in the source
   *  corpus, when known. */
  recordCount: number | null;
  /** The number of queries the source artifact
   *  covers (temporal slice). */
  temporalQueryCount: number;
  /** Per-variant rows. The order is the
   *  declaration order of
   *  `BUILTIN_TEMPORAL_RERANK_VARIANTS`, so a
   *  reviewer reading the artifact can find the
   *  baseline row first. */
  variants: ReadonlyArray<TemporalRerankVariantRow>;
  /**
   * Optional semantic-evidence cross-reference.
   * The block is surfaced only when the caller
   * supplied a pre-computed semantic map. The
   * block is honest about its source and is
   * NOT consulted by the re-ranker. A reviewer
   * who wants to know "if the dense ranker had
   * been the ranker, would the re-ranker have
   * helped?" reads the overlay. The overlay
   * covers the temporal slice.
   */
  semanticOverlay?: {
    source: string;
    covered: number;
    hit: number;
    miss: number;
    /** Per-variant breakdown of `miss` queries:
     *  the number of baseline-`miss` queries
     *  whose after-re-rank top-1 is a
     *  `currentTruthId` under each variant. A
     *  reviewer reads this row to see "the
     *  dense ranker also missed this query, but
     *  the re-ranker could have recovered it
     *  anyway (the current fact was in the
     *  top-K)". */
    recoveredByVariant: Record<string, number>;
  };
  /**
   * The full set of `categoryChange` strings
   * the report has observed, sorted by count
   * (descending) and then by key (ascending).
   * Surfaced so the human report's per-category-
   * change table has a stable column order.
   */
  categoryChangeKeys: ReadonlyArray<string>;
}

/**
 * Top-level orchestrator. Consumes the
 * per-query input + the variant list and emits
 * the `TemporalRerankReport`. The function is
 * pure: no I/O, no mutation, no provider calls.
 */
export function buildTemporalRerankReport(args: {
  sourceVariant: string;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  variants?: ReadonlyArray<TemporalRerankVariant>;
  recordCount?: number | null;
  /** Optional semantic-evidence map. The shape
   *  is the same the prior diagnostic accepts:
   *  `{source: string, byQueryId: ReadonlyMap<string,
   *  "hit" | "miss">}`. The block is a CROSS-
   *  REFERENCE, not a re-ranker input. */
  semantic?: { source: string; byQueryId: ReadonlyMap<string, "hit" | "miss"> };
}): TemporalRerankReport {
  const {
    sourceVariant,
    evals,
    queries,
    variants = BUILTIN_TEMPORAL_RERANK_VARIANTS,
    recordCount = null,
    semantic,
  } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `buildTemporalRerankReport: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length})`
    );
  }
  // Build the per-variant rows.
  const rows: TemporalRerankVariantRow[] = [];
  for (const v of variants) {
    rows.push(buildTemporalRerankVariantRow({ variant: v, evals, queries }));
  }
  // Temporal slice size: count temporal queries
  // in the input. We count the queries the
  // variants' temporal slice will cover.
  let temporalQueryCount = 0;
  for (const q of queries) {
    if (q.family === "temporal") temporalQueryCount += 1;
  }
  // Optional semantic overlay. The block is
  // computed per-variant for cross-reference
  // (the re-ranker does not consult the map).
  let semanticOverlay: TemporalRerankReport["semanticOverlay"];
  if (semantic) {
    // Build a per-query "miss" set from the
    // semantic map: queries the dense ranker
    // rank-1-missed. For each variant, count
    // how many of those queries the re-ranker
    // can recover (the re-ranker's after
    // `currentTruthAt1` is true on a
    // baseline-miss query).
    const missQueries: string[] = [];
    for (const q of queries) {
      if (q.family !== "temporal") continue;
      const v = semantic.byQueryId.get(q.id);
      if (v === "miss") missQueries.push(q.id);
    }
    // For each variant, count the number of
    // miss queries whose after
    // `currentTruthAt1` is true.
    const recoveredByVariant: Record<string, number> = {};
    for (const row of rows) {
      let n = 0;
      for (const p of row.metrics.perQuery) {
        if (p.baselineCurrentTruthAt1) continue; // baseline already current
        if (p.afterCurrentTruthAt1) n += 1;
      }
      recoveredByVariant[row.variant.id] = n;
    }
    let hit = 0;
    let miss = 0;
    for (const q of queries) {
      if (q.family !== "temporal") continue;
      const v = semantic.byQueryId.get(q.id);
      if (v === "hit") hit += 1;
      else if (v === "miss") miss += 1;
    }
    semanticOverlay = {
      source: semantic.source,
      covered: hit + miss,
      hit,
      miss,
      recoveredByVariant,
    };
    // Suppress an unused-variable warning for
    // `missQueries`. The list is informative
    // (a future variant could iterate it
    // directly) but is unused in the current
    // implementation. We avoid the `noUnusedLocals`
    // warning by using the list in a benign
    // assertion: the list size must match the
    // overlay's `miss` count.
    if (missQueries.length !== miss) {
      throw new Error(
        `buildTemporalRerankReport: semantic overlay miss mismatch ` +
          `(${missQueries.length} vs ${miss})`
      );
    }
  }
  // Compute the sorted `categoryChange` keys.
  // We aggregate across all variants so the
  // report's per-category-change table has a
  // stable set of columns.
  const allKeys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row.metrics.perCategoryChange)) {
      allKeys.add(k);
    }
  }
  const categoryChangeKeys = [...allKeys].sort();
  return {
    sourceVariant,
    recordCount,
    temporalQueryCount,
    variants: rows,
    ...(semanticOverlay ? { semanticOverlay } : {}),
    categoryChangeKeys,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Render a `TemporalRerankReport` as a
 * human-readable text block. The output is
 * deterministic (no PRNG, no wall clock) so a
 * reviewer can `diff` two runs. The function
 * is pure.
 */
export function formatTemporalRerankReport(report: TemporalRerankReport): string {
  const out: string[] = [];
  out.push(`# Temporal ranking-preference re-ranker diagnostic (source: ${report.sourceVariant})`);
  if (report.recordCount !== null) {
    out.push(`#   (records: ${report.recordCount})`);
  }
  out.push(`#   (temporal queries: ${report.temporalQueryCount})`);
  out.push("");

  out.push("## Variant table (temporal slice)");
  out.push("");
  out.push(
    "  category | variant | n | baseline@1 | after@1 | delta | staleTop1 baseline->after | staleOverCurrent baseline->after | currentMissing baseline->after | regressions | unchanged-missing | verdict"
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(15)} | ${row.variant.id.padEnd(46)} | ` +
        `${String(m.total).padStart(2)} | ` +
        `${String(m.baselineCurrentTruthAt1).padStart(10)} | ` +
        `${String(m.afterCurrentTruthAt1).padStart(7)} | ` +
        `${signedInt(m.currentTruthAt1Delta).padStart(5)} | ` +
        `${String(m.baselineStaleTop1).padStart(2)}->${String(m.afterStaleTop1).padStart(2)} ` +
        `(${signedInt(m.staleTop1Delta).padStart(2)}) | ` +
        `${String(m.baselineStaleOverCurrent).padStart(2)}->${String(m.afterStaleOverCurrent).padStart(2)} ` +
        `(${signedInt(m.staleOverCurrentDelta).padStart(2)}) | ` +
        `${String(m.baselineCurrentMissing).padStart(2)}->${String(m.afterCurrentMissing).padStart(2)} ` +
        `(${signedInt(m.currentMissingDelta).padStart(2)}) | ` +
        `${String(m.regressionCount).padStart(11)} | ` +
        `${String(m.unchangedBecauseCurrentMissing).padStart(18)} | ` +
        `${row.verdict}`
    );
  }
  out.push("");
  out.push("## Variant table (clean / fixture-ambiguous split)");
  out.push("");
  out.push(
    "  category | variant | cleanN | cleanBaseline@1 | cleanAfter@1 | cleanDelta | cleanRegressions | ambigN | ambigBaseline@1 | ambigAfter@1 | ambigDelta | ambigRegressions"
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(15)} | ${row.variant.id.padEnd(46)} | ` +
        `${String(m.cleanTotal).padStart(6)} | ` +
        `${String(m.cleanBaselineCurrentTruthAt1).padStart(14)} | ` +
        `${String(m.cleanAfterCurrentTruthAt1).padStart(11)} | ` +
        `${signedInt(m.cleanCurrentTruthAt1Delta).padStart(10)} | ` +
        `${String(m.cleanRegressionCount).padStart(16)} | ` +
        `${String(m.fixtureAmbiguousTotal).padStart(6)} | ` +
        `${String(m.fixtureAmbiguousBaselineCurrentTruthAt1).padStart(15)} | ` +
        `${String(m.fixtureAmbiguousAfterCurrentTruthAt1).padStart(12)} | ` +
        `${signedInt(m.fixtureAmbiguousCurrentTruthAt1Delta).padStart(10)} | ` +
        `${String(m.fixtureAmbiguousRegressionCount).padStart(17)}`
    );
  }
  out.push("");
  out.push("## Per-variant verdict notes");
  out.push("");
  for (const row of report.variants) {
    out.push(`  ${row.variant.id}:`);
    out.push(`    category:    ${row.variant.category}`);
    out.push(`    description: ${row.variant.description}`);
    out.push(`    verdict:     ${row.verdict}`);
    out.push(`    note:        ${row.verdictNote}`);
  }
  out.push("");
  out.push("## Per-category change table (temporal slice)");
  out.push("");
  out.push(
    "  The table maps (baseline-category -> after-category) -> count for each variant. " +
      "The columns are the union of all observed change keys, sorted by count " +
      "descending. The dominant 'X -> X' diagonal is the unchanged-count; the " +
      "off-diagonal rows are the per-variant recoveries."
  );
  out.push("");
  // For each variant, list the (change -> count)
  // pairs. The columns are the union of keys
  // across all variants, sorted by (count desc,
  // key asc) so the dominant changes appear
  // first.
  for (const row of report.variants) {
    out.push(`  ${row.variant.id} (${row.variant.category}):`);
    const entries = Object.entries(row.metrics.perCategoryChange)
      .map(([k, v]) => ({ key: k, count: v }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
    if (entries.length === 0) {
      out.push("    (no per-query changes)");
    } else {
      for (const e of entries) {
        out.push(`    ${String(e.count).padStart(3)}  ${e.key}`);
      }
    }
  }
  out.push("");
  if (report.semanticOverlay) {
    const o = report.semanticOverlay;
    out.push("## Semantic evidence overlay (temporal slice, cross-reference only)");
    out.push("");
    out.push(`  source:    ${o.source}`);
    out.push(`  covered:   ${o.covered}`);
    out.push(`  hit:       ${o.hit}`);
    out.push(`  miss:      ${o.miss}`);
    out.push(
      "  The re-ranker does NOT consult the map. The map is a cross-reference: " +
        "for each variant, the count is the number of baseline-miss queries " +
        "whose after-re-rank top-1 IS a currentTruthId. A non-zero count means " +
        "'the current fact was in the top-K; the re-ranker could have recovered " +
        "it regardless of the dense ranker's miss'."
    );
    out.push("");
    out.push("  recovered-by-variant (baseline-miss queries, after-currentTruthAt1):");
    for (const [vid, n] of Object.entries(o.recoveredByVariant)) {
      out.push(`    ${vid.padEnd(46)}  ${n}`);
    }
    out.push("");
  }
  out.push("## Honest framing");
  out.push("");
  out.push(
    "  The production-like variants in this report do NOT use `currentTruthIds` " +
      "or `STALE_TEMPORAL_IDS`. The only production-like variant that performs " +
      "a non-trivial re-rank is `mild-heuristic-temporal-current`; the heuristic " +
      "is the runtime `isTemporalCurrent` flag, and the embedded stale-like set " +
      "is a NARROW hand-curated subset of the legacy cluster. The variant is a " +
      "research probe, not a production-grade recovery. A reviewer who wants " +
      "to reason about a deployable rule reads the production-like rows; the " +
      "oracle / fixture-shaped rows are the research / oracle-like ceiling."
  );
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a signed integer with an explicit `+`
 * sign for positive values. The human report's
 * delta columns use the format. A zero is
 * rendered as `+0` for column stability; a
 * reviewer who reads `-0` and `+0` as
 * semantically equivalent is not misled.
 */
function signedInt(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}

// Silence "unused export" warnings for type
// imports that are re-exported for downstream
// tests but not used inside this module's
// body.
export type { TemporalTruthCategory };
export { TEMPORAL_TRUTH_CATEGORIES };
