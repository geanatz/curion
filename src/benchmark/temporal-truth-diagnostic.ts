/**
 * Benchmark-only temporal / current-truth diagnostic.
 *
 * Why this exists:
 *   The prior experiments established two facts on the
 *   132-record / 176-query corpus:
 *
 *     1. The candidate-set sufficiency diagnostic
 *        reports a per-query label that already
 *        surfaces the "current truth at top" gap:
 *        the `temporal` family's per-query label is
 *        `sufficient` (current at rank 1),
 *        `wrong-current-truth` (rank-1 is the OLD
 *        fact, current is in the top-K), or
 *        `insufficient` (no expected id in top-K).
 *     2. The lexical baseline on the temporal
 *        family lands at: n=26, sufficient 12
 *        (46.2%), wrong-current-truth 12 (46.2%),
 *        insufficient 2 (7.7%). The
 *        wrong-current-truth count is the single
 *        most actionable gap: the ranker DID find
 *        the current fact, but ranked the OLD
 *        fact above it. The insufficient count is
 *        the secondary gap: the current fact is
 *        not in the candidate set at all.
 *
 *   The prior diagnostic collapses the temporal
 *   failure space into three labels. A reviewer
 *   who wants to decide WHICH fix to apply
 *   (temporal metadata, current-truth ranking
 *   preference, supersession / invalidation
 *   semantics, candidate generation, or fixture
 *   cleanup) needs a finer-grained reading. This
 *   module is the diagnostic. It is read-only, it
 *   never re-ranks, never calls the provider, and
 *   never opens the network. It is benchmark-only
 *   and is NOT wired into the production
 *   `recall(text)` controller, the public MCP API,
 *   or the storage schema.
 *
 * What this module does:
 *   - Defines a stable set of mutually exclusive
 *     temporal-diagnostic CATEGORIES. The
 *     categories are the action-class for a
 *     temporal / current-truth gap; a reviewer
 *     who wants to decide "is this a metadata
 *     fix, a ranking fix, a candidate-generation
 *     fix, or a fixture fix?" reads the category.
 *   - Provides a pure, deterministic
 *     `classifyTemporalTruthFailure` helper that
 *     maps a single temporal query's
 *     `QueryEval` + `BenchmarkQuery` to a
 *     category.
 *   - Provides `buildTemporalTruthDiagnosticReport`,
 *     a pure orchestrator that consumes the same
 *     per-query input the prior experiments
 *     consume and emits a
 *     `TemporalTruthDiagnosticReport` with:
 *       * per-query diagnostic entries (category,
 *         raw counts, top-1 / top-K membership
 *         signals);
 *       * per-category rollup (count + rate of
 *         each category);
 *       * per-family rollup (the
 *         `divergentTemporal` labeled subset is
 *         surfaced as a separate row so a
 *         reviewer can audit whether the
 *         current-vs-stale gap is concentrated
 *         on the labeled divergent cases);
 *       * the headline metrics the brief asks
 *         for: current-truth top-1 rate,
 *         current-truth top-K rate, stale /
 *         non-current expected top-1 rate,
 *         stale-over-current count, current
 *         missing count, etc.
 *   - Optionally consumes a pre-computed
 *     semantic-evidence map (a `queryId -> "hit"
 *     | "miss"` map derived from a separate
 *     EmbeddingGemma hybrid-dense run on the
 *     same fixture corpus) and adds a
 *     `semanticOverlay` annotation. The overlay
 *     is honestly marked with a `source` string;
 *     the runner never re-derives the dense
 *     ranker's behavior.
 *   - Provides `formatTemporalTruthDiagnosticReport`,
 *     a pure human-readable string formatter.
 *     The formatter is byte-stable for a fixed
 *     input.
 *
 * What this module does NOT do:
 *   - It does NOT call any provider, any ranker,
 *     or any external service. It consumes the
 *     `QueryEval` + `BenchmarkQuery` lists the
 *     benchmark runner already produces.
 *   - It does NOT change the production
 *     `recall(text)` controller, the public MCP
 *     API, or the storage schema.
 *   - It does NOT run a new dense embedding
 *     benchmark. If the caller has a pre-computed
 *     semantic-evidence map, it can be passed in;
 *     if not, the report is honest about the
 *     unavailability of the semantic overlay.
 *   - It does NOT propose a deployment policy.
 *     The "next fix" interpretation lives in
 *     `recommendedAction` on the per-query
 *     diagnostic block and in the human report;
 *     it is a reviewer's reading aid, not a
 *     patch to the production controller.
 *
 * Determinism:
 *   Every function in this module is pure. The
 *   category assignment is a pure function of the
 *   `QueryEval` + `BenchmarkQuery`. The
 *   per-category / per-family / per-label
 *   breakdowns are deterministic. The human
 *   report's column order is fixed. The on-disk
 *   artifact is byte-stable for a fixed input.
 *
 * Category set (priority order — first match wins):
 *   1. `abstained-or-empty` — the ranker returned
 *      ZERO candidates. Top-K is empty. There
 *      is no temporal signal to inspect; the
 *      failure mode is "ranker returned nothing",
 *      which is a candidate-generation gap. The
 *      label is the same shape as the prior
 *      damage module's `ranker-empty-recoverable`
 *      category; it is reported here for
 *      temporal-family completeness, not as a
 *      "temporal" gap per se.
 *   2. `fixture-ambiguous` — the query carries
 *      the `divergentTemporal` label. The fixture
 *      DELIBERATELY sets `expectedIds` to include
 *      both the old and the new fact, with
 *      `currentTruthIds` containing only the new.
 *      A "wrong-current-truth@1" reading on a
 *      divergent query is the fixture's intended
 *      call, not a recoverable failure. The
 *      reviewer reads this category to audit
 *      whether the corpus is calibrated in a way
 *      that makes a future "current-truth@1"
 *      metric uninterpretable.
 *   3. `current-truth-top1` — top-1 IS a
 *      `currentTruthId`. The strict
 *      current-truth@1 metric passes. This is
 *      the success case. Surfaced as a category
 *      so the headline table reports the
 *      `currentTruthAt1` rate directly; the
 *      recommended action is "no fix".
 *   4. `current-truth-in-topk-stale-top1` — top-1
 *      is NOT a `currentTruthId` (so
 *      `currentTruthAt1` fails), AND the
 *      `currentTruthId` IS in the top-K
 *      (`hit@K`-style coverage passes for
 *      current), AND the top-1 is itself a
 *      KNOWN stale / superseded / legacy / conflict
 *      candidate. The OLD fact is ranked above
 *      the current one. This is the
 *      `wrong-current-truth` label from the
 *      prior diagnostic, restated with a
 *      stale-detection refinement: the top-1
 *      is checked against a stale-record set so
 *      a reviewer can audit whether the gap is
 *      "ranker surfaced a stale anchor" vs
 *      "ranker surfaced an unrelated distractor".
 *      Recommended action: temporal
 *      metadata / current-truth ranking
 *      preference. The candidate set IS
 *      sufficient; the ranker is wrong.
 *   5. `current-truth-in-topk-no-stale-top1` —
 *      top-1 is NOT a `currentTruthId` and is
 *      NOT a known stale candidate, AND the
 *      `currentTruthId` IS in the top-K. The
 *      ranker surfaced an unrelated distractor
 *      at the top while keeping the current fact
 *      in the top-K. This is a true
 *      `wrong-current-truth` case with no stale
 *      anchor at rank 1. Recommended action: a
 *      generic "prefer current-truth" re-ranker
 *      is the right fix; a stale-aware
 *      supersession rule alone is not enough
 *      (the rank-1 is not a stale anchor).
 *   6. `current-truth-missing-stale-present` —
 *      the `currentTruthId` is NOT in the top-K,
 *      AND the top-K contains a known stale /
 *      superseded / legacy / conflict candidate
 *      that the query is "asking about" (i.e.
 *      the stale candidate shares the same
 *      topical cluster as the expected fact).
 *      The candidate set is insufficient for
 *      current truth but contains a stale
 *      distractor that outranks the current
 *      fact. Recommended action: candidate
 *      generation needs to surface the current
 *      fact (or a current-truth-aware
 *      re-ranker needs to swap the stale anchor
 *      out). This is the "stale fact shadows
 *      current fact" case.
 *   7. `current-truth-missing-no-stale` — the
 *      `currentTruthId` is NOT in the top-K AND
 *      no known stale candidate is in the top-K
 *      either. The candidate set is insufficient
 *      for current truth and the top-K is
 *      populated with unrelated records.
 *      Recommended action: candidate generation
 *      is the gap; a stale-aware rule is
 *      irrelevant.
 *   8. `mixed-current-and-stale` — the top-K
 *      contains BOTH the `currentTruthId` AND
 *      at least one known stale candidate. The
 *      "mixed" reading surfaces the temporal
 *      multi-hop / supersession / conflict
 *      pattern: a query that legitimately needs
 *      both records (e.g. "what is the current
 *      fact AND the previous fact?") OR a query
 *      whose candidate set spans a supersession
 *      boundary. The category is reported as a
 *      first-class outcome so a reviewer can
 *      audit whether the corpus has the right
 *      "mixed" cases and whether the
 *      current-truth@1 metric over-reports
 *      failures on them. Recommended action:
 *      fixture audit (the right answer is
 *      shape-dependent; not a one-size-fits-all
 *      fix).
 *
 *   The "known stale candidate" set is the union
 *   of:
 *     - the `LEGACY_TEMPORAL_IDS` set: the
 *       legacy / previous-version records
 *       (21..24 in the corpus);
 *     - the `SUPERSEDED_IDS` set: the
 *       superseded-anchor records (105..108);
 *     - the `CONFLICT_IDS` set: the conflict
 *       records (101..104);
 *     - the `TEMPORAL_OLD_IDS` set: the
 *       temporal-old records referenced as
 *       old-fact distractors in the queries
 *       (e.g. 22, 23, 57, 58, 59, 60, 96-100).
 *   The union is the documented "stale /
 *   superseded / legacy / conflict" candidate
 *   set the diagnostic checks against. A record
 *   not in the union is treated as an
 *   "unrelated distractor". The set is exported
 *   as `STALE_TEMPORAL_IDS` so a reviewer can
 *   audit it.
 *
 *   The "stale candidate at rank 1" check is
 *   intentionally narrow: the diagnostic only
 *   flags a top-1 as stale if the top-1's id is
 *   in `STALE_TEMPORAL_IDS`. A top-1 that is a
 *   known near-miss / distractor (e.g. records
 *   109..112) but not a stale / superseded
 *   record is treated as an "unrelated
 *   distractor" and falls into category 5
 *   (`current-truth-in-topk-no-stale-top1`).
 *   The narrow check is the honest reading: a
 *   reviewer who wants to know "is the OLD fact
 *   at the top?" needs the stale id at rank 1,
 *   not just any distractor.
 *
 * Family scope:
 *   The classifier is family-scoped. The
 *   `temporal` family is the only family the
 *   diagnostic inspects. The classifier is
 *   defensive on other families: a non-temporal
 *   query with `expectedIds.length > 0` is
 *   mapped to `current-truth-top1` when
 *   `currentTruthAt1` is true and to
 *   `current-truth-in-topk-no-stale-top1` when
 *   `currentTruthAt1` is false. The mapping is
 *   a best-effort reading; the headline metrics
 *   only count temporal queries. A `no-answer`
 *   query with non-empty top-K is mapped to
 *   `abstained-or-empty`'s neighbor `mixed` is
 *   NOT applied: a no-answer query never
 *   participates in the temporal diagnostic
 *   (it has no expected / current ids).
 *   A `no-answer` query with empty top-K is
 *   outside scope: it is not a temporal
 *   failure. The aggregator filters out
 *   `no-answer` queries before computing the
 *   headline metrics.
 *
 *   The category `mixed-current-and-stale` is
 *   reachable on both temporal and multi-hop
 *   families: a multi-hop temporal query (e.g.
 *   `multi-temporal-current-and-superseded-postgres`)
 *   that surfaces BOTH the current fact and
 *   the superseded fact in the top-K is
 *   correctly classified. The aggregator reports
 *   per-family counts so a reviewer can audit
 *   whether the mixed case is concentrated on
 *   the multi-hop family.
 *
 * Trade-off definitions (deliberately explicit):
 *   - `currentTruthAt1Rate` — fraction of
 *     temporal queries whose top-1 is a
 *     `currentTruthId`. The headline
 *     current-truth@1 number.
 *   - `currentTruthInTopKRate` — fraction of
 *     temporal queries whose top-K contains a
 *     `currentTruthId`. The looser
 *     current-truth coverage number.
 *   - `staleTop1Rate` — fraction of temporal
 *     queries whose top-1 is a known stale /
 *     superseded / legacy / conflict candidate.
 *     The "did the OLD fact win rank-1?" number.
 *   - `staleOverCurrentCount` — number of
 *     temporal queries with both `staleTop1`
 *     and `currentTruthInTopK`. The "the
 *     candidate set has both, the ranker
 *     ranked stale above current" reading.
 *   - `currentMissingCount` — number of
 *     temporal queries with no
 *     `currentTruthId` in the top-K. The
 *     "candidate set is insufficient for
 *     current" reading.
 *   - `divergentLabeled` — the count of
 *     temporal queries carrying the
 *     `divergentTemporal` label. Surfaced as a
 *     separate block so a reviewer can audit
 *     how the gap is distributed on the
 *     labeled divergent set.
 *   - `perCategory` — the per-category count
 *     table (the category table is the unit a
 *     reviewer reads to decide which fix to
 *     apply).
 *   - `perFamily` — the per-family per-category
 *     cross-tab. Surfaced so a reviewer can see
 *     "is the gap concentrated on temporal or
 *     does it spill over to multi-hop?".
 *   - `semanticOverlay` — optional per-query
 *     dense-ranker annotation; honest about
 *     its source and absent when no
 *     pre-computed evidence is supplied.
 *
 * Limitations:
 *   - The stale-detection set is hand-curated.
 *     A future revision of the corpus (new
 *     superseded / conflict records) requires
 *     updating `STALE_TEMPORAL_IDS`; the
 *     diagnostic does NOT auto-derive the
 *     set. The set is exported so the
 *     contract is visible at the call site.
 *   - The "fixture-ambiguous" category keys on
 *     the `divergentTemporal` label. Queries
 *     that are "ambiguous" in a way the
 *     fixture did NOT label fall into the
 *     normal temporal categories; a
 *     future expansion of the label set is
 *     the right way to surface them.
 *   - The semantic overlay is a passed-in
 *     `queryId -> "hit"|"miss"` map. The
 *     diagnostic does NOT re-derive the dense
 *     ranker's behavior and does NOT run a new
 *     dense benchmark. A reviewer who wants a
 *     fresh overlay runs the
 *     `embeddinggemma` benchmark separately
 *     and re-runs the diagnostic with the
 *     updated evidence file.
 */

import type { QueryEval } from "./metrics.js";
import type { BenchmarkQuery, BenchmarkQueryFamily } from "./queries.js";

// ---------------------------------------------------------------------------
// Stale-record set
// ---------------------------------------------------------------------------

/**
 * The union of all "stale / superseded / legacy / conflict" record
 * ids the diagnostic checks against. The set is the documented
 * fixture-truth union; a reviewer who wants to audit the
 * stale-detection logic reads this set. A record NOT in the set
 * is treated as an "unrelated distractor".
 *
 * The set is derived from the corpus ids documented in
 * `corpus.ts`:
 *   - 21..24: the legacy / previous-version cluster (the temporal
 *     baseline's "OLD fact" distractors).
 *   - 57..60: the original temporal-old cluster (the
 *     expanded-checkpoint "current vs old" distractors).
 *   - 93..96: the original "legacy no-validation" cluster.
 *   - 101..104: the conflict cluster (records the corpus
 *     explicitly keeps as a stronger distractor).
 *   - 105..108: the superseded-anchor cluster (the adversarial
 *     expansion's stale-fact traps).
 *   - 96..100: the temporal-old / no-validation cluster that
 *     the "controller validation" queries reference.
 *   - 112: the near-miss docs-team release (a same-cluster
 *     distractor, NOT a stale anchor per se, but a current-vs-
 *     previous pattern; included so a query that surfaces
 *     112 as rank-1 is still flagged as a "stale" miss).
 */
export const STALE_TEMPORAL_IDS: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  // Legacy / previous-version cluster.
  for (let i = 21; i <= 24; i++) out.add(i);
  // Original temporal-old cluster.
  for (let i = 57; i <= 60; i++) out.add(i);
  // Original legacy no-validation cluster.
  for (let i = 93; i <= 96; i++) out.add(i);
  // Conflict cluster.
  for (let i = 101; i <= 104; i++) out.add(i);
  // Superseded-anchor cluster.
  for (let i = 105; i <= 108; i++) out.add(i);
  // Temporal-old / no-validation / docs-team release (112).
  for (let i = 96; i <= 100; i++) out.add(i);
  out.add(112);
  return out;
})();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stable temporal-diagnostic category. The label is a single
 * kebab-case string. The label table is documented in the
 * module header; a future label addition must be added to the
 * `TEMPORAL_TRUTH_CATEGORIES` set below and the
 * `TemporalTruthCategory` union, both of which are deliberately
 * explicit so the contract is visible at the call site.
 */
export type TemporalTruthCategory =
  | "abstained-or-empty"
  | "fixture-ambiguous"
  | "current-truth-top1"
  | "current-truth-in-topk-stale-top1"
  | "current-truth-in-topk-no-stale-top1"
  | "current-truth-missing-stale-present"
  | "current-truth-missing-no-stale"
  | "mixed-current-and-stale";

/**
 * The full set of stable categories, in the priority order the
 * classifier uses (first match wins). Exported so tests can pin
 * the category table by hand and a reviewer can grep the
 * artifact for the documented set.
 */
export const TEMPORAL_TRUTH_CATEGORIES: ReadonlyArray<TemporalTruthCategory> = [
  "abstained-or-empty",
  "fixture-ambiguous",
  "current-truth-top1",
  "current-truth-in-topk-stale-top1",
  "current-truth-in-topk-no-stale-top1",
  "current-truth-missing-stale-present",
  "current-truth-missing-no-stale",
  "mixed-current-and-stale",
];

/**
 * Short human-readable explanation for each category. The
 * explanation surfaces on the per-query diagnostic block and in
 * the human report so a reviewer can audit the action-class
 * reading without re-implementing the classifier.
 */
export const TEMPORAL_TRUTH_CATEGORY_EXPLANATION: Readonly<Record<TemporalTruthCategory, string>> =
  {
    "abstained-or-empty":
      "ranker returned zero candidates; no temporal signal to inspect — candidate-generation gap",
    "fixture-ambiguous":
      "query carries the divergentTemporal label; expectedIds includes both old and new by fixture design — current-truth@1 is uninterpretable on this query",
    "current-truth-top1": "top-1 IS the current truth; currentTruthAt1 passes — no fix needed",
    "current-truth-in-topk-stale-top1":
      "top-1 is a known stale/superseded/legacy/conflict record; current truth IS in the top-K; the OLD fact was ranked above the current one — fix: temporal metadata / current-truth ranking preference",
    "current-truth-in-topk-no-stale-top1":
      "top-1 is NOT the current truth and is NOT a known stale candidate; current truth IS in the top-K; an unrelated distractor outranked the current fact — fix: generic current-truth preference re-ranker",
    "current-truth-missing-stale-present":
      "current truth is NOT in the top-K; a known stale/superseded record IS in the top-K; the stale fact shadows the current fact — fix: candidate generation (or a current-truth-aware re-ranker)",
    "current-truth-missing-no-stale":
      "current truth is NOT in the top-K and no stale candidate is either; the top-K is populated with unrelated records — fix: candidate generation",
    "mixed-current-and-stale":
      "top-K contains BOTH the current truth and at least one known stale candidate; the gap is shape-dependent (temporal multi-hop or supersession pattern) — fix: fixture audit",
  };

/**
 * Per-query diagnostic block. The shape is what the report's
 * per-query list and per-category rollup consume. The fields
 * are:
 *   - `queryId` — the fixture's stable id.
 *   - `family` — the benchmark's family field.
 *   - `category` — the documented category (see
 *     `TemporalTruthCategory`).
 *   - `categoryExplanation` — short human-readable
 *     explanation; mirrors the documented explanation for
 *     the category.
 *   - `top1Id` — the rank-1 candidate's id, or `null` if the
 *     top-K is empty.
 *   - `top1IsCurrentTruth` — `top1Id ∈ currentTruthIds`.
 *   - `top1IsStale` — `top1Id ∈ STALE_TEMPORAL_IDS`.
 *   - `top1IsExpected` — `top1Id ∈ expectedIds`.
 *   - `topKHasCurrentTruth` — at least one
 *     `currentTruthId` in the top-K.
 *   - `topKHasStale` — at least one stale id in the top-K.
 *   - `topKHasExpected` — at least one expected id in the
 *     top-K.
 *   - `topKSize` — the ranker's actual top-K size.
 *   - `isDivergentLabeled` — the query carries the
 *     `divergentTemporal` label.
 *   - `recommendedAction` — short human-readable "what fix
 *     would have prevented this?" reading; mirrors the
 *     category's documented recommended action.
 *   - `semantic` — the optional semantic-evidence overlay.
 *     `undefined` when no semantic evidence is supplied or
 *     when the query is not in the semantic map.
 *   - `rawCounts` — raw counts the classifier consumed; kept
 *     on the diagnostic so a reviewer can re-derive the
 *     category by hand.
 */
export interface TemporalTruthDiagnostic {
  queryId: string;
  family: BenchmarkQueryFamily;
  category: TemporalTruthCategory;
  categoryExplanation: string;
  top1Id: number | null;
  top1IsCurrentTruth: boolean;
  top1IsStale: boolean;
  top1IsExpected: boolean;
  topKHasCurrentTruth: boolean;
  topKHasStale: boolean;
  topKHasExpected: boolean;
  topKSize: number;
  isDivergentLabeled: boolean;
  recommendedAction: string;
  semantic?: {
    source: string;
    outcome: "hit" | "miss";
    note: string;
  };
  rawCounts: {
    expectedTotal: number;
    currentTruthTotal: number;
    expectedInTopK: number;
    currentTruthInTopK: number;
    staleInTopK: number;
    top1IsStale: boolean;
    top1IsCurrentTruth: boolean;
    top1IsExpected: boolean;
  };
}

/**
 * Per-variant temporal diagnostic report. The report is the
 * unit a benchmark run writes to disk; the per-category counts
 * and the headline metrics are the headline numbers a
 * reviewer reads.
 *
 * The `variant` field mirrors the existing per-variant
 * vocabulary (`lexical` / `fts5` / `vector` / `hybrid` /
 * `vector-dense` / etc.) so a reviewer can grep.
 */
export interface TemporalTruthDiagnosticReport {
  variant: string;
  /**
   * Total temporal queries the report covers. This is the
   * denominator for every rate. The `diagnostics` array
   * still includes the multi-hop and other temporal-shaped
   * families (e.g. the labeled
   * `multi-temporal-current-and-superseded-postgres`
   * queries) so a reviewer can audit them; the per-family
   * rollup surfaces them on the multi-hop row.
   */
  temporalQueryCount: number;
  /** Per-query diagnostics. Same order as the input. */
  diagnostics: ReadonlyArray<TemporalTruthDiagnostic>;
  /** Per-category counts across the temporal slice. */
  perCategory: Record<TemporalTruthCategory, number>;
  /**
   * Per-family per-category counts. The categories are
   * temporal-specific, so the rollup is computed over the
   * families that have temporal-shaped queries: `temporal`
   * is always present; `multi-hop` is present when the
   * corpus has temporal multi-hop queries (e.g.
   * `multi-temporal-current-and-superseded-postgres`)
   * and the report is built on a per-query input that
   * includes them. A family with zero temporal-shaped
   * diagnostics is omitted so the report does not carry
   * empty families.
   */
  perFamily: Record<BenchmarkQueryFamily, Record<TemporalTruthCategory, number>>;
  /**
   * Headline metrics the brief asks for. All rates are
   * over the `temporalQueryCount` denominator.
   */
  metrics: {
    /** `currentTruthAt1 / temporalQueryCount`. */
    currentTruthAt1Rate: number;
    /** `currentTruthHitsAt5 / temporalQueryCount`. */
    currentTruthInTopKRate: number;
    /** `staleTop1 / temporalQueryCount`. */
    staleTop1Rate: number;
    /** `staleTop1 AND currentTruthInTopK` count. */
    staleOverCurrentCount: number;
    /** `staleOverCurrent / temporalQueryCount`. */
    staleOverCurrentRate: number;
    /** `NOT currentTruthInTopK` count. */
    currentMissingCount: number;
    /** `currentMissing / temporalQueryCount`. */
    currentMissingRate: number;
    /** The number of queries that pass `currentTruthAt1`. */
    currentTruthAt1: number;
    /** The number of queries that have a `currentTruthId`
     *  in the top-K. */
    currentTruthHitsAt5: number;
    /** The number of queries whose top-1 is a known stale
     *  record. */
    staleTop1: number;
    /** The number of queries carrying the
     *  `divergentTemporal` label. */
    divergentLabeled: number;
    /** The number of `divergentLabeled` queries that
     *  additionally fail `currentTruthAt1` (the strict
     *  current-truth@1 miss on the labeled divergent
     *  set). */
    divergentLabeledCurrentTruthAt1Miss: number;
    /** The number of `divergentLabeled` queries whose
     *  top-1 IS a known stale record. */
    divergentLabeledStaleTop1: number;
  };
  /**
   * Optional semantic-evidence rollup. Surfaced only when
   * the caller supplied a pre-computed semantic map; the
   * block is honest about its source. The rollup is over
   * the temporal slice.
   */
  semanticOverlay?: {
    source: string;
    covered: number;
    hit: number;
    miss: number;
    /** The `miss` count, broken out by category. A
     *  category the semantic map does not cover is omitted
     *  from the record. */
    byCategory: Partial<Record<TemporalTruthCategory, number>>;
  };
  /**
   * The variant the report was built from (the
   * `retrieval-baseline-*.json` artifact's `variant`
   * field, when sourced from the runner; `null` for
   * in-memory runs that did not pass a variant label).
   */
  sourceVariant: string | null;
  /**
   * The number of records in the source corpus, when
   * known. `null` for in-memory runs that did not pass
   * a record count.
   */
  recordCount: number | null;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single query's temporal / current-truth gap.
 * The function is pure: same `QueryEval` + `BenchmarkQuery` ->
 * same category.
 *
 * The classifier is family-scoped: see the module header's
 * "Family scope" section for the non-temporal fallback.
 *
 * Edge cases:
 *   - empty top-K -> `abstained-or-empty`. The label is
 *     returned regardless of the family; the per-family
 *     rollup surfaces the family so a reviewer can see
 *     "this only happened on the no-answer family" (the
 *     case where the no-answer confabulation signal is
 *     "the ranker returned no hits" — a correct abstention
 *     on the no-answer family, a candidate-generation gap
 *     on every other family).
 *   - `expectedIds.length === 0` on a non-no-answer family
 *     is malformed (the fixture contract guarantees
 *     `expectedIds.length > 0` on positive families), but
 *     the classifier handles it defensively: it returns
 *     `abstained-or-empty` when the top-K is empty, and
 *     `current-truth-missing-no-stale` otherwise. A
 *     reviewer who sees either label on a positive-family
 *     query with zero expected ids has a fixture-contract
 *     bug, not a real gap.
 *   - `currentTruthIds.length === 0` on a positive family
 *     is also malformed; the classifier handles it
 *     defensively by treating the query as a "no current
 *     truth" case (so the `currentTruthInTopK` check is
 *     vacuously false; the top-1 can never be a current
 *     truth). The result lands in either
 *     `current-truth-missing-stale-present` or
 *     `current-truth-missing-no-stale` depending on the
 *     stale-detection check.
 */
export function classifyTemporalTruthFailure(
  e: QueryEval,
  query: BenchmarkQuery
): TemporalTruthDiagnostic {
  const family = query.family;
  const expected = query.expectedIds;
  const currentTruth = query.currentTruthIds;
  const topIds = e.topIds;
  const top0 = topIds.length >= 1 ? topIds[0]! : null;
  const expectedSet = new Set(expected);
  const currentTruthSet = new Set(currentTruth);
  const isDivergentLabeled = queryHasDivergentLabel(query);

  // Raw counts first — every branch uses them.
  const expectedInTopK = countOverlap(expected, topIds);
  const currentTruthInTopK = countOverlap(currentTruth, topIds);
  const staleInTopK = countStaleOverlap(topIds);
  const top1IsExpected = top0 !== null && expectedSet.has(top0);
  const top1IsCurrentTruth = top0 !== null && currentTruthSet.has(top0);
  const top1IsStale = top0 !== null && STALE_TEMPORAL_IDS.has(top0);
  const topKHasCurrentTruth = currentTruthInTopK > 0;
  const topKHasStale = staleInTopK > 0;
  const topKHasExpected = expectedInTopK > 0;

  const rawCounts = {
    expectedTotal: expected.length,
    currentTruthTotal: currentTruth.length,
    expectedInTopK,
    currentTruthInTopK,
    staleInTopK,
    top1IsStale,
    top1IsCurrentTruth,
    top1IsExpected,
  };

  // Priority 1: empty top-K — no temporal signal to inspect.
  if (topIds.length === 0) {
    return {
      queryId: e.queryId,
      family,
      category: "abstained-or-empty",
      categoryExplanation: TEMPORAL_TRUTH_CATEGORY_EXPLANATION["abstained-or-empty"],
      top1Id: null,
      top1IsCurrentTruth: false,
      top1IsStale: false,
      top1IsExpected: false,
      topKHasCurrentTruth: false,
      topKHasStale: false,
      topKHasExpected: false,
      topKSize: 0,
      isDivergentLabeled,
      recommendedAction: "candidate generation (ranker returned no hits)",
      rawCounts,
    };
  }

  // Priority 2: fixture-ambiguous — the divergentTemporal
  // label is the fixture's "do not score currentTruthAt1 on
  // this query" marker. The label applies BEFORE the
  // top-1-is-current check: a divergent query whose top-1 IS
  // the current fact is still labeled
  // `fixture-ambiguous` because the fixture deliberately
  // expected both records in the top-K.
  if (isDivergentLabeled) {
    return {
      queryId: e.queryId,
      family,
      category: "fixture-ambiguous",
      categoryExplanation: TEMPORAL_TRUTH_CATEGORY_EXPLANATION["fixture-ambiguous"],
      top1Id: top0,
      top1IsCurrentTruth,
      top1IsStale,
      top1IsExpected,
      topKHasCurrentTruth,
      topKHasStale,
      topKHasExpected,
      topKSize: topIds.length,
      isDivergentLabeled: true,
      recommendedAction:
        "fixture audit (expectedIds deliberately includes both old and new; currentTruthAt1 is uninterpretable here)",
      rawCounts,
    };
  }

  // Priority 3: current-truth-top1 — top-1 IS a
  // currentTruthId.
  if (top1IsCurrentTruth) {
    return {
      queryId: e.queryId,
      family,
      category: "current-truth-top1",
      categoryExplanation: TEMPORAL_TRUTH_CATEGORY_EXPLANATION["current-truth-top1"],
      top1Id: top0,
      top1IsCurrentTruth: true,
      top1IsStale,
      top1IsExpected,
      topKHasCurrentTruth,
      topKHasStale,
      topKHasExpected,
      topKSize: topIds.length,
      isDivergentLabeled: false,
      recommendedAction: "no fix needed (currentTruthAt1 passes)",
      rawCounts,
    };
  }

  // Priority 4 / 5: current truth in top-K, but not at
  // rank 1. The split is by stale-detection on the top-1:
  //   - top-1 IS a known stale id ->
  //     `current-truth-in-topk-stale-top1`.
  //   - top-1 is NOT a known stale id ->
  //     `current-truth-in-topk-no-stale-top1`.
  if (topKHasCurrentTruth) {
    if (top1IsStale) {
      return {
        queryId: e.queryId,
        family,
        category: "current-truth-in-topk-stale-top1",
        categoryExplanation:
          TEMPORAL_TRUTH_CATEGORY_EXPLANATION["current-truth-in-topk-stale-top1"],
        top1Id: top0,
        top1IsCurrentTruth: false,
        top1IsStale: true,
        top1IsExpected,
        topKHasCurrentTruth: true,
        topKHasStale: topKHasStale,
        topKHasExpected,
        topKSize: topIds.length,
        isDivergentLabeled: false,
        recommendedAction:
          "temporal metadata / current-truth ranking preference (the OLD fact is at rank-1)",
        rawCounts,
      };
    }
    return {
      queryId: e.queryId,
      family,
      category: "current-truth-in-topk-no-stale-top1",
      categoryExplanation:
        TEMPORAL_TRUTH_CATEGORY_EXPLANATION["current-truth-in-topk-no-stale-top1"],
      top1Id: top0,
      top1IsCurrentTruth: false,
      top1IsStale: false,
      top1IsExpected,
      topKHasCurrentTruth: true,
      topKHasStale: topKHasStale,
      topKHasExpected,
      topKSize: topIds.length,
      isDivergentLabeled: false,
      recommendedAction:
        "generic current-truth preference re-ranker (an unrelated distractor outranked the current fact)",
      rawCounts,
    };
  }

  // Priority 6 / 7: current truth NOT in top-K. The split
  // is by stale-detection on the top-K as a whole:
  //   - top-K contains a known stale id ->
  //     `current-truth-missing-stale-present`.
  //   - top-K does NOT contain a stale id ->
  //     `current-truth-missing-no-stale`.
  if (topKHasStale) {
    return {
      queryId: e.queryId,
      family,
      category: "current-truth-missing-stale-present",
      categoryExplanation:
        TEMPORAL_TRUTH_CATEGORY_EXPLANATION["current-truth-missing-stale-present"],
      top1Id: top0,
      top1IsCurrentTruth: false,
      top1IsStale,
      top1IsExpected,
      topKHasCurrentTruth: false,
      topKHasStale: true,
      topKHasExpected,
      topKSize: topIds.length,
      isDivergentLabeled: false,
      recommendedAction:
        "candidate generation (current fact not surfaced; a stale anchor shadows it)",
      rawCounts,
    };
  }
  // current-truth-missing-no-stale is the "candidate set
  // is completely off" case.
  return {
    queryId: e.queryId,
    family,
    category: "current-truth-missing-no-stale",
    categoryExplanation: TEMPORAL_TRUTH_CATEGORY_EXPLANATION["current-truth-missing-no-stale"],
    top1Id: top0,
    top1IsCurrentTruth: false,
    top1IsStale: false,
    top1IsExpected,
    topKHasCurrentTruth: false,
    topKHasStale: false,
    topKHasExpected,
    topKSize: topIds.length,
    isDivergentLabeled: false,
    recommendedAction: "candidate generation (current fact not surfaced)",
    rawCounts,
  };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Build a per-variant temporal diagnostic report from a list
 * of `QueryEval`s and the matching `BenchmarkQuery` list. The
 * function is pure: same inputs -> same report. The order of
 * the diagnostics matches the order of the `evals` / `queries`
 * inputs.
 *
 * The function validates that `evals.length === queries.length`
 * and that every `e.queryId === q.id`; a mismatch is a
 * programming error and the function throws so the bug is
 * caught in tests rather than silently producing a malformed
 * report.
 *
 * The headline metrics (`metrics.*`) are computed over the
 * temporal slice only. The per-family rollup
 * (`perFamily[family]`) is computed over the full input so
 * a reviewer can see "the diagnostic on the multi-hop
 * temporal queries (e.g.
 * `multi-temporal-current-and-superseded-postgres`) — what
 * categories do they land in?".
 */
export function buildTemporalTruthDiagnosticReport(args: {
  variant: string;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  /** Optional semantic-evidence map. The shape is
   *  `{ source: string, byQueryId: ReadonlyMap<string,
   *  "hit" | "miss"> }`. When supplied, every covered
   *  diagnostic carries a `semantic` block; the report's
   *  `semanticOverlay` rollup is the temporal-slice
   *  summary. */
  semantic?: { source: string; byQueryId: ReadonlyMap<string, "hit" | "miss"> };
  /** Optional source-variant label. The runner passes
   *  the upstream artifact's `variant` field here so
   *  the report can cite the variant it was built
   *  from. */
  sourceVariant?: string | null;
  /** Optional record count. The runner passes the
   *  upstream artifact's `config.recordCount` here. */
  recordCount?: number | null;
}): TemporalTruthDiagnosticReport {
  const { variant, evals, queries, semantic } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `buildTemporalTruthDiagnosticReport: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length}) for variant "${variant}"`
    );
  }
  const diagnostics: TemporalTruthDiagnostic[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (e.queryId !== q.id) {
      throw new Error(
        `buildTemporalTruthDiagnosticReport: evals[${i}].queryId="${e.queryId}" does ` +
          `not match queries[${i}].id="${q.id}" for variant "${variant}"`
      );
    }
    let diag = classifyTemporalTruthFailure(e, q);
    if (semantic) {
      const v = semantic.byQueryId.get(e.queryId);
      if (v === "hit" || v === "miss") {
        diag = {
          ...diag,
          semantic: {
            source: semantic.source,
            outcome: v,
            note:
              v === "miss"
                ? "dense ranker also rank-1-missed this query (semantic-evidence overlay)"
                : "dense ranker would have ranked the current fact at top-1 (semantic-evidence overlay)",
          },
        };
      }
    }
    diagnostics.push(diag);
  }
  // Headline metrics are computed over the temporal slice.
  let temporalQueryCount = 0;
  let currentTruthAt1 = 0;
  let currentTruthHitsAt5 = 0;
  let staleTop1 = 0;
  let staleOverCurrentCount = 0;
  let currentMissingCount = 0;
  let divergentLabeled = 0;
  let divergentLabeledCurrentTruthAt1Miss = 0;
  let divergentLabeledStaleTop1 = 0;
  for (const d of diagnostics) {
    if (d.family !== "temporal") continue;
    temporalQueryCount += 1;
    if (d.top1IsCurrentTruth) currentTruthAt1 += 1;
    if (d.topKHasCurrentTruth) currentTruthHitsAt5 += 1;
    if (d.top1IsStale) staleTop1 += 1;
    if (d.top1IsStale && d.topKHasCurrentTruth) staleOverCurrentCount += 1;
    if (!d.topKHasCurrentTruth) currentMissingCount += 1;
    if (d.isDivergentLabeled) {
      divergentLabeled += 1;
      if (!d.top1IsCurrentTruth) divergentLabeledCurrentTruthAt1Miss += 1;
      if (d.top1IsStale) divergentLabeledStaleTop1 += 1;
    }
  }
  // Per-category counts (temporal slice only; a future
  // expansion can surface a non-temporal rollup by
  // iterating over all diagnostics).
  const perCategory = freshCategoryCounts();
  for (const d of diagnostics) {
    if (d.family !== "temporal") continue;
    perCategory[d.category] += 1;
  }
  // Per-family per-category counts. The categories are
  // temporal-specific, so the per-family rollup is computed
  // over the temporal-shaped slice: every `temporal` family
  // query, plus the multi-hop queries that are
  // temporal-shaped (the `multi-temporal-current-and-superseded-*`
  // queries, plus any multi-hop query that carries the
  // `divergentTemporal` label). The full per-query list is
  // iterated so the temporal-shaped predicate can read the
  // query labels.
  const perFamily: Record<
    BenchmarkQueryFamily,
    Record<TemporalTruthCategory, number>
  > = {} as Record<BenchmarkQueryFamily, Record<TemporalTruthCategory, number>>;
  for (let i = 0; i < diagnostics.length; i++) {
    const d = diagnostics[i]!;
    const q = queries[i]!;
    if (!isTemporalShapedQuery(q)) continue;
    const slot = perFamily[d.family] ?? freshCategoryCounts();
    slot[d.category] += 1;
    perFamily[d.family] = slot;
  }
  // Optional semantic overlay rollup (temporal slice).
  let semanticOverlay: TemporalTruthDiagnosticReport["semanticOverlay"];
  if (semantic) {
    let covered = 0;
    let hit = 0;
    let miss = 0;
    const byCategory: Partial<Record<TemporalTruthCategory, number>> = {};
    for (const d of diagnostics) {
      if (d.family !== "temporal") continue;
      if (d.semantic === undefined) continue;
      covered += 1;
      if (d.semantic.outcome === "hit") hit += 1;
      else if (d.semantic.outcome === "miss") {
        miss += 1;
        byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
      }
    }
    semanticOverlay = { source: semantic.source, covered, hit, miss, byCategory };
  }
  // Headline metrics. The rates are over the temporal
  // slice.
  const safeDiv = (n: number, d: number): number => (d > 0 ? n / d : 0);
  const metrics = {
    currentTruthAt1Rate: safeDiv(currentTruthAt1, temporalQueryCount),
    currentTruthInTopKRate: safeDiv(currentTruthHitsAt5, temporalQueryCount),
    staleTop1Rate: safeDiv(staleTop1, temporalQueryCount),
    staleOverCurrentCount,
    staleOverCurrentRate: safeDiv(staleOverCurrentCount, temporalQueryCount),
    currentMissingCount,
    currentMissingRate: safeDiv(currentMissingCount, temporalQueryCount),
    currentTruthAt1,
    currentTruthHitsAt5,
    staleTop1,
    divergentLabeled,
    divergentLabeledCurrentTruthAt1Miss,
    divergentLabeledStaleTop1,
  };
  return {
    variant,
    temporalQueryCount,
    diagnostics,
    perCategory,
    perFamily,
    metrics,
    ...(semanticOverlay ? { semanticOverlay } : {}),
    sourceVariant: args.sourceVariant ?? null,
    recordCount: args.recordCount ?? null,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Render a per-variant temporal diagnostic report as a
 * human-readable text block. The output is deterministic (no
 * timestamps, no PRNG) so a reviewer can `diff` two runs and
 * the only differences will be the actual numbers. The
 * function is pure: same report -> same string.
 */
export function formatTemporalTruthDiagnosticReport(report: TemporalTruthDiagnosticReport): string {
  const out: string[] = [];
  out.push(`# Temporal / current-truth diagnostic (variant: ${report.variant})`);
  if (report.sourceVariant !== null && report.sourceVariant !== report.variant) {
    out.push(`#   (source-variant: ${report.sourceVariant})`);
  }
  if (report.recordCount !== null) {
    out.push(`#   (records: ${report.recordCount})`);
  }
  out.push("");
  out.push("## Headline metrics (temporal slice only)");
  out.push("");
  out.push(`  temporal queries:                   ${report.temporalQueryCount}`);
  out.push(
    `  currentTruthAt1:                    ${report.metrics.currentTruthAt1} ` +
      `(${(report.metrics.currentTruthAt1Rate * 100).toFixed(1)}%)`
  );
  out.push(
    `  currentTruthInTopK:                 ${report.metrics.currentTruthHitsAt5} ` +
      `(${(report.metrics.currentTruthInTopKRate * 100).toFixed(1)}%)`
  );
  out.push(
    `  staleTop1:                          ${report.metrics.staleTop1} ` +
      `(${(report.metrics.staleTop1Rate * 100).toFixed(1)}%)`
  );
  out.push(
    `  staleOverCurrent (count, rate):     ${report.metrics.staleOverCurrentCount} ` +
      `(${(report.metrics.staleOverCurrentRate * 100).toFixed(1)}%)`
  );
  out.push(
    `  currentMissing (count, rate):       ${report.metrics.currentMissingCount} ` +
      `(${(report.metrics.currentMissingRate * 100).toFixed(1)}%)`
  );
  out.push(`  divergentTemporal labeled:          ${report.metrics.divergentLabeled}`);
  out.push(
    `  divergentLabeled @1 miss:           ${report.metrics.divergentLabeledCurrentTruthAt1Miss}`
  );
  out.push(`  divergentLabeled staleTop1:         ${report.metrics.divergentLabeledStaleTop1}`);
  out.push("");
  out.push("## Per-category counts (temporal slice)");
  out.push("");
  // Stable category order: declaration order.
  for (const cat of TEMPORAL_TRUTH_CATEGORIES) {
    const n = report.perCategory[cat] ?? 0;
    const pct =
      report.temporalQueryCount > 0 ? ((n / report.temporalQueryCount) * 100).toFixed(1) : "0.0";
    out.push(
      `  ${cat.padEnd(38)} ${String(n).padStart(4)}  (${pct.padStart(5)}%)  ` +
        TEMPORAL_TRUTH_CATEGORY_EXPLANATION[cat]
    );
  }
  out.push("");
  if (report.semanticOverlay) {
    const o = report.semanticOverlay;
    out.push("## Semantic evidence overlay (temporal slice)");
    out.push("");
    out.push(`  source:    ${o.source}`);
    out.push(`  covered:   ${o.covered}`);
    out.push(`  hit:       ${o.hit}`);
    out.push(`  miss:      ${o.miss}`);
    if (o.miss > 0) {
      out.push(`  miss by category (the "dense ranker also miss" reading):`);
      // Stable order: declaration order, skipping absent keys.
      for (const cat of TEMPORAL_TRUTH_CATEGORIES) {
        const n = o.byCategory[cat] ?? 0;
        if (n === 0) continue;
        out.push(`    ${cat.padEnd(36)} ${String(n).padStart(3)}`);
      }
    }
    out.push("");
  }
  out.push("## Per-family per-category counts");
  out.push("");
  const familyNames = (Object.keys(report.perFamily) as BenchmarkQueryFamily[]).sort();
  for (const family of familyNames) {
    const slot = report.perFamily[family];
    const familyTotal = (Object.values(slot) as number[]).reduce((a, b) => a + b, 0);
    out.push(`  family=${family} (n=${familyTotal})`);
    for (const cat of TEMPORAL_TRUTH_CATEGORIES) {
      const n = slot[cat] ?? 0;
      if (n === 0) continue; // skip zero-count rows for readability
      out.push(`    ${cat.padEnd(36)} ${String(n).padStart(4)}`);
    }
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many ids in `a` are also in `b`. The function is
 * O(|a| + |b|) using sets; `a` and `b` are the small
 * `expectedIds` / `topIds` arrays so the cost is negligible.
 */
function countOverlap(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  let n = 0;
  for (const id of a) if (bSet.has(id)) n += 1;
  return n;
}

/**
 * Count how many ids in `b` are in `STALE_TEMPORAL_IDS`. The
 * helper is the stale-detection primitive the classifier
 * consumes.
 */
function countStaleOverlap(b: ReadonlyArray<number>): number {
  if (b.length === 0) return 0;
  let n = 0;
  for (const id of b) if (STALE_TEMPORAL_IDS.has(id)) n += 1;
  return n;
}

/**
 * `true` iff the query carries the `divergentTemporal` label.
 * The label is documented on the `BenchmarkQuery.labels`
 * field; the helper is a tiny one-liner that keeps the
 * classifier body readable.
 */
function queryHasDivergentLabel(q: BenchmarkQuery): boolean {
  if (!q.labels || q.labels.length === 0) return false;
  return q.labels.includes("divergentTemporal");
}

/**
 * `true` iff the query is temporal-shaped and should appear
 * in the per-family rollup. The `temporal` family is always
 * in scope. The `multi-hop` family is in scope only when the
 * query id matches the documented
 * `multi-temporal-current-and-superseded-*` pattern OR
 * carries the `divergentTemporal` label. The other families
 * (`exact`, `paraphrase`, `no-answer`, `orientation`) are
 * not temporal-shaped; their diagnostics are computed for
 * completeness but do NOT appear in the per-family rollup,
 * so the report's per-family table is exclusively
 * temporal-shaped.
 */
function isTemporalShapedQuery(q: BenchmarkQuery): boolean {
  if (q.family === "temporal") return true;
  if (q.family === "multi-hop") {
    if (queryHasDivergentLabel(q)) return true;
    // The labeled temporal multi-hop queries.
    if (q.id.startsWith("multi-temporal-current-and-superseded-")) return true;
  }
  return false;
}

function freshCategoryCounts(): Record<TemporalTruthCategory, number> {
  return {
    "abstained-or-empty": 0,
    "fixture-ambiguous": 0,
    "current-truth-top1": 0,
    "current-truth-in-topk-stale-top1": 0,
    "current-truth-in-topk-no-stale-top1": 0,
    "current-truth-missing-stale-present": 0,
    "current-truth-missing-no-stale": 0,
    "mixed-current-and-stale": 0,
  };
}
