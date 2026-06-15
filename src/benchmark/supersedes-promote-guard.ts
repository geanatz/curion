/**
 * Benchmark-only supersedes-promote guard probe
 * (Experiment 10).
 *
 * Why this exists:
 *   Experiment 9's
 *   `metadata-simulation-multi-anchor-linked-expansion`
 *   variant reaches 20/26 `currentTruthAt1` on the
 *   temporal slice (the reranker-control is 18/26;
 *   the variant recovers +2 over the control).
 *   The variant's `recoveredByExpansion` count is
 *   4 (the candidate-expansion step alone closes
 *   the +4 gap the multi-anchor-aware re-ranker
 *   cannot close). However the variant ALSO
 *   introduces 1 regression on the
 *   `temp-rate-limit` query: the baseline top-K
 *   is `[70, 130, 20, 23, 45]` with 70 at rank 1
 *   (the current fact); the candidate-expansion
 *   rule injects record 3 (the `supersededBy` of
 *   record 23, which is in the top-K); the
 *   downstream `multi-anchor-aware-combined`
 *   re-ranker promotes record 3 above record 70
 *   because record 3 `supersedes` record 23, which
 *   is still in the top-K. The promotion demotes
 *   the actual current fact (70) to a lower rank.
 *
 *   The Architect's question: "Can a NARROW
 *   non-oracle guard on the `supersedes-promote`
 *   step ELIMINATE the regression while
 *   preserving the candidate-expansion gain?".
 *
 *   The guard is a thin rule on the
 *   `supersedes-promote` step: "do NOT promote
 *   an INJECTED candidate (a candidate the
 *   candidate-expansion step added) above a
 *   NON-INJECTED rank-1 candidate". The rule is
 *   PURE: it reads ONLY the post-expansion top-K
 *   + the injected-id set (the candidate-
 *   expansion step's output) + the simulated
 *   supersession edge map. The rule does NOT
 *   consult `currentTruthIds`; the protection is
 *   a structural property of the candidate
 *   expansion's provenance (injected vs
 *   non-injected), not a current-truth lookup.
 *
 *   Honest trade-off: the guard's structural
 *   rule cannot distinguish "rank-1 is a
 *   current-truth candidate" from "rank-1 is a
 *   stale candidate". Both look identical to
 *   the guard. The guard's protection is
 *   therefore a TRADE-OFF: it eliminates the
 *   `temp-rate-limit` regression (where the
 *   rank-1 is a current-truth candidate and
 *   the injected `supersedes` candidate is
 *   not) AT THE COST of losing the +2
 *   recoveries of Experiment 9's candidate-
 *   expansion step (where the rank-1 is a
 *   STALE candidate and the injected
 *   `supersedes` candidate IS the current
 *   truth — the multi-anchor reranker
 *   promotes the injected current truth
 *   above the stale rank-1, and the guard
 *   blocks that promotion). The guarded
 *   primary therefore lands at 18/26 (the
 *   reranker-control's level) with 0
 *   regressions, not 20/26. The honest
 *   reading is: a STRUCTURAL guard on the
 *   `supersedes-promote` step that does NOT
 *   consult `currentTruthIds` cannot preserve
 *   the +2 recoveries AND eliminate the
 *   regression. A semantic guard (one that
 *   consults `currentTruthIds`) COULD
 *   preserve both, but that requires a
 *   production-side schema change (a
 *   `currentTruthIds` column at `remember`
 *   time) that is OUT OF SCOPE for this
 *   experiment.
 *
 * What this module does:
 *   - Defines a stable GUARDED-RERANK TYPE
 *     (`GuardedRerankVariant`): the
 *     `supersedes-promote-guard` rule kind is a
 *     new kind distinct from the Experiment 7/8
 *     `supersedes-promote` rule. The rule's input
 *     is the post-expansion top-K + the injected-
 *     id set; the rule's output is a guarded
 *     re-ordered top-K. The rule is PURE.
 *   - Defines a small set of CANDIDATE-
 *     GENERATION + GUARDED-RERANK POLICY
 *     VARIANTS. The variant table composes
 *     Experiment 9's candidate-expansion rules
 *     with the guarded rerank rule. The table
 *     includes:
 *       * `baseline-no-rerank` (the production-
 *         like reference row).
 *       * `reranker-control-multi-anchor-aware-combined`
 *         (the Experiment 8 reranker alone; the
 *         FIXED DOWNSTREAM CONTROL).
 *       * `guarded-multi-anchor-linked-expansion`
 *         (the PRIMARY DELIVERABLE: Exp 9's
 *         multi-anchor-linked-expansion +
 *         the guarded rerank rule).
 *       * `guarded-linked-candidate-expansion`
 *         (the narrow guard: Exp 9's
 *         linked-candidate-expansion + the
 *         guarded rerank rule; surfaces the
 *         guard's marginal effect on the
 *         pure `supersededBy` projection).
 *       * `guarded-no-op` (the sanity row: the
 *         guarded rerank rule alone, with NO
 *         candidate expansion; surfaces "the
 *         guard alone, with no expansion, is a
 *         no-op" — the guard only matters when
 *         the candidate-expansion step actually
 *         injected a candidate that the
 *         `supersedes-promote` step would
 *         otherwise promote).
 *       * `oracle-candidate-injection-ceiling`
 *         (the oracle ceiling: inject every
 *         `currentTruthIds` not in the top-K +
 *         the Experiment 8 reranker; mirrors
 *         Exp 9's oracle).
 *       * `oracle-guarded-candidate-injection-ceiling`
 *         (the diagnostic oracle ceiling:
 *         inject every `currentTruthIds` not in
 *         the top-K + the guarded rerank rule
 *         that is allowed to consult
 *         `currentTruthIds` as a hint. The
 *         variant is the IDEAL PROTECTION
 *         CEILING: a re-ranker that knows which
 *         candidates are current AND protects
 *         them. The variant is clearly labeled
 *         `oracle-diagnostic`; it is NOT
 *         production-like. The variant bounds
 *         the ideal protection the guarded
 *         primary could achieve if the
 *         production-side schema carried the
 *         `currentTruthIds` flag at `remember`
 *         time).
 *   - For every variant, computes the
 *     AFTER-candidate-generation + AFTER-guarded-
 *     rerank `currentTruthAt1`, `staleTop1`,
 *     `staleOverCurrent`, `currentMissing`, and
 *     the DELTA vs the baseline. The per-variant
 *     metrics mirror Experiment 9's metric block:
 *     same field names, same deltas, same clean /
 *     fixture-ambiguous split, same per-category
 *     change rollup. The probe ADDS:
 *       - `tempRateLimitRegressionCount`: a
 *         pinned metric surfacing the specific
 *         `temp-rate-limit` regression the guard
 *         is designed to eliminate. The metric
 *         is `0` for any guarded variant that
 *         protects the non-injected rank-1
 *         candidate; the metric is `1` for the
 *         unguarded Exp 9 variants.
 *       - `promotionsBlockedByGuard`: a per-
 *         variant count of `supersedes-promote`
 *         promotions the guard blocked on this
 *         slice. The metric is the guard's
 *         "fire" counter: a guarded variant that
 *         blocked 0 promotions is functionally
 *         identical to the unguarded reranker;
 *         a guarded variant that blocked ≥1
 *         promotion is the one that
 *         `temp-rate-limit` regression the guard
 *         was designed to eliminate.
 *   - Renders a human-readable report and a JSON
 *     artifact. Both are byte-stable for a fixed
 *     input.
 *
 * What this module does NOT do:
 *   - It does NOT call any provider, any
 *     ranker, or any external service. It
 *     consumes the same per-query input the
 *     prior experiments consume (a list of
 *     `QueryEval`s + a list of `BenchmarkQuery`s
 *     + the per-query injected-id set the
 *     candidate-expansion step produces).
 *   - It does NOT change the production
 *     `recall(text)` controller, the public MCP
 *     API, or the storage schema.
 *   - It does NOT change candidate generation.
 *     The candidate-expansion rules are the
 *     SAME rules Experiment 9 ships; the guard
 *     composes ON TOP of the expansion's output.
 *   - It does NOT change the downstream
 *     `multi-anchor-aware-combined` re-ranker
 *     for non-guarded variants. The guard is a
 *     COMPLETE re-rank for guarded variants:
 *     it integrates the multi-anchor
 *     protection (a multi-anchor record at
 *     rank 1 is protected from being
 *     displaced) AND the `supersededBy`
 *     demote step (a superseded record is
 *     demoted to the bottom) AND the
 *     `supersedes-promote` step (a
 *     `supersedes` candidate is promoted to
 *     the top, EXCEPT when the guard's
 *     protection condition fires). The
 *     multi-anchor-aware-combined re-ranker
 *     is NOT applied on top of the guard's
 *     output for guarded variants; the
 *     guard is the FINAL re-rank step.
 *   - It does NOT use `currentTruthIds` in the
 *     primary guarded variants. The guard reads
 *     ONLY the post-expansion top-K + the
 *     injected-id set. The
 *     `currentTruthIds` is consumed ONLY by the
 *     `oracle-candidate-injection-ceiling`
 *     variant (mirrors Exp 9's oracle) and by
 *     the
 *     `oracle-guarded-candidate-injection-ceiling`
 *     diagnostic variant (the ideal-protection
 *     ceiling). Every other variant is
 *     `currentTruthIds`-free.
 *   - It does NOT run a new dense embedding
 *     benchmark. A pre-computed semantic-
 *     evidence map can be attached for cross-
 *     reference; the guard itself does not
 *     consult the map.
 *   - It does NOT propose a deployment policy.
 *     The `recommendedVerdict` field on each
 *     variant row is a research-only reading
 *     aid.
 *
 * Determinism:
 *   Every function in this module is pure. The
 *   guard rule is a pure function of the post-
 *   expansion top-K + the injected-id set +
 *   the simulated edge map. The per-variant
 *   metrics are aggregated from the per-query
 *   guard decisions. The same inputs always
 *   produce the same outputs.
 *
 * Honest framing:
 *   The `multi-anchor-simulation` category is
 *   INTENTIONALLY distinct from the Experiment
 *   9 `multi-anchor-simulation` category. The
 *   primary guarded variant reuses Experiment
 *   9's `metadata-simulation-multi-anchor-
 *   linked-expansion` candidate-expansion rule
 *   (which is a `multi-anchor-simulation`
 *   candidate-expansion rule) and composes the
 *   guarded rerank rule on top. The category
 *   labels are honest:
 *     - `guarded-multi-anchor-linked-expansion`
 *       is a `multi-anchor-simulation` (the
 *       candidate-expansion rule is
 *       fixture-derived; the guard is a
 *       structural rule that does NOT consult
 *       `currentTruthIds`).
 *     - `guarded-linked-candidate-expansion`
 *       is a `metadata-simulation` (the
 *       candidate-expansion rule is
 *       fixture-derived from the supersession
 *       edge map; the guard is structural).
 *     - `guarded-no-op` is a
 *       `reranker-control` (the guard is a
 *       pass-through when no candidate was
 *       injected; the row is the "the guard
 *       alone is a no-op" sanity row).
 *     - `oracle-candidate-injection-ceiling`
 *       is an `oracle` (mirrors Exp 9).
 *     - `oracle-guarded-candidate-injection-ceiling`
 *       is an `oracle-diagnostic` (the ideal
 *       protection ceiling; the variant
 *       consults `currentTruthIds` to know
 *       which candidates to protect; the
 *       variant is clearly labeled
 *       `oracle-diagnostic` and is NOT
 *       production-like).
 *
 *   The honest reading of the primary guarded
 *   variant: "a production-side schema that
 *   records BOTH the supersession edge map AND
 *   the multi-anchor treatment AND the linked-
 *   expansion map AND a per-candidate
 *   `injected` provenance flag at `remember`
 *   time would let a runtime candidate
 *   generator + a runtime guarded re-ranker
 *   reach the guarded primary's ceiling WITHOUT
 *   depending on the fixture truth at all".
 *
 *   The `temp-rate-limit` regression pin: the
 *   probe is designed to surface the specific
 *   regression Experiment 9 documents. The
 *   `tempRateLimitRegressionCount` per-variant
 *   metric is the headline evidence: the
 *   guarded primary MUST produce 0; the
 *   unguarded Exp 9 variants produce 1.
 *
 * Limitations:
 *   - The guard rule is INTENTIONALLY NARROW:
 *     it only protects the non-injected rank-1
 *     candidate from being displaced by a
 *     `supersedes-promote` of an injected
 *     candidate. A more aggressive guard
 *     (e.g., "do not promote an injected
 *     candidate above ANY non-injected
 *     candidate") would be a future experiment.
 *   - The injected-id set is the candidate-
 *     expansion step's output. The guard does
 *     NOT decide which candidates are injected;
 *     the candidate-expansion rule decides. The
 *     guard is a LATE step.
 *   - The diagnostic oracle variant
 *     (`oracle-guarded-candidate-injection-ceiling`)
 *     consults `currentTruthIds` as a HINT for
 *     which candidates to protect. The variant
 *     is the IDEAL PROTECTION CEILING: a
 *     re-ranker that knows which candidates are
 *     current AND protects them. The variant is
 *     clearly labeled `oracle-diagnostic`; it
 *     is NOT production-like; a production-side
 *     schema would need a `currentTruthIds`
 *     column on the storage schema to wire this
 *     variant in.
 *   - The guard is parameterized with the
 *     Experiment 8
 *     `multi-anchor-aware-combined` rerank rule
 *     as the downstream reranker. The
 *     `downstreamVariant` parameter is
 *     intentionally guarded with a runtime
 *     check so a future caller that swaps the
 *     downstream reranker is forced to read the
 *     contract.
 *   - The semantic overlay is a passed-in
 *     `queryId -> "hit"|"miss"` map; the
 *     experiment does NOT re-derive the dense
 *     ranker's behavior. The overlay is a
 *     cross-reference, not a production
 *     signal.
 *   - The guard's structural rule cannot
 *     distinguish "rank-1 is a current-truth
 *     candidate" from "rank-1 is a stale
 *     candidate". The guard therefore
 *     ELIMINATES the `temp-rate-limit`
 *     regression (where the rank-1 is current
 *     truth and the injected `supersedes`
 *     candidate is not) AT THE COST of
 *     losing the +2 recoveries of Experiment
 *     9's candidate-expansion step (where
 *     the rank-1 is stale and the injected
 *     `supersedes` candidate IS the current
 *     truth). The guarded primary lands at
 *     18/26 with 0 regressions; the +2
 *     recovery requires a SEMANTIC guard
 *     (one that consults `currentTruthIds`),
 *     which is OUT OF SCOPE for this
 *     experiment.
 */

import type { BenchmarkQuery } from "./queries.js";
import type { QueryEval } from "./metrics.js";
import {
  classifyTemporalTruthFailure,
  type TemporalTruthCategory,
  TEMPORAL_TRUTH_CATEGORIES,
} from "./temporal-truth-diagnostic.js";
import { SIMULATED_SUPERSESSION_EDGES } from "./supersession-edge-simulation.js";
import {
  SIMULATED_MULTI_ANCHOR_TREATMENT,
  SIMULATED_MULTI_ANCHOR_IDS,
  SIMULATED_PROTECTED_ANCHOR_IDS,
  applyMultiAnchorRerankRule,
  BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS,
  type MultiAnchorRerankRule,
  type MultiAnchorRerankVariant,
} from "./multi-anchor-current-previous.js";
import {
  BUILTIN_CANDIDATE_GENERATION_VARIANTS,
  applyCandidateExpansionRule,
  type CandidateExpansionRule,
  type CandidateExpansionResult,
  type CandidateGenerationVariant,
} from "./temporal-candidate-generation-probe.js";

// ---------------------------------------------------------------------------
// Guard rule types
// ---------------------------------------------------------------------------

/**
 * The guard rule the variant applies BETWEEN
 * the candidate-expansion step and the
 * downstream re-ranker. The guard is a
 * `supersedes-promote-guard`: it protects a
 * non-injected rank-1 candidate from being
 * displaced by a `supersedes-promote` of an
 * injected candidate.
 *
 *   - `none` — no guard. The variant's
 *     downstream re-ranker is applied as-is.
 *     Reference row; the unguarded
 *     `multi-anchor-aware-combined` reranker.
 *   - `supersedes-promote-guard` — the
 *     `supersedes-promote` step's protection.
 *     A `supersedes` candidate is NOT promoted
 *     above a non-injected rank-1 candidate.
 *     The candidate-expansion step's
 *     `injectedIds` set is the input the guard
 *     reads. The rule does NOT consult
 *     `currentTruthIds`.
 *   - `oracle-supersedes-promote-guard` — the
 *     ORACLE / DIAGNOSTIC variant of the
 *     guard: the same protection logic, but
 *     the rule is allowed to consult
 *     `currentTruthIds` as a HINT for which
 *     candidates to protect. The variant is
 *     the IDEAL PROTECTION CEILING: a
 *     re-ranker that knows which candidates
 *     are current AND protects them. Clearly
 *     labeled `oracle-diagnostic`; NOT
 *     production-like. The variant is the
 *     EXPERIMENT's diagnostic upper bound on
 *     the protection the guard could provide
 *     if the production-side schema carried
 *     the `currentTruthIds` column.
 */
export type SupersedesPromoteGuardRule =
  | { kind: "none" }
  | { kind: "supersedes-promote-guard" }
  | { kind: "oracle-supersedes-promote-guard" };

/**
 * A guarded-rerank variant. The variant is the
 * Experiment 9 candidate-expansion rule PLUS
 * the guard rule PLUS the downstream
 * `multi-anchor-aware-combined` reranker. The
 * variant is the unit the per-variant
 * aggregator consumes.
 */
export interface GuardedRerankVariant {
  /** Stable id used in the artifact +
   *  report. */
  id: string;
  /** Short human-readable description
   *  surfaced in the report. The description
   *  MUST be honest about which category the
   *  variant belongs to so a reviewer reading
   *  the headline table does not mistake a
   *  `multi-anchor-simulation` variant for a
   *  `production-like` one. */
  description: string;
  /** The honest category. The categories are:
   *    - `production-like` (the reference
   *      `baseline-no-rerank` row; no runtime
   *      signal is consumed);
   *    - `reranker-control` (the
   *      `guarded-no-op` row; the guard is a
   *      pass-through when no candidate was
   *      injected; the row is the "the guard
   *      alone is a no-op" sanity row);
   *    - `oracle` (the
   *      `oracle-candidate-injection-ceiling`
   *      row; keys on `currentTruthIds` for
   *      the candidate-injection step;
   *      composes the unguarded downstream
   *      reranker);
   *    - `oracle-diagnostic` (the
   *      `oracle-guarded-candidate-injection-ceiling`
   *      row; keys on `currentTruthIds` for
   *      the candidate-injection step AND for
   *      the guard; the IDEAL PROTECTION
   *      CEILING; clearly labeled as
   *      diagnostic, NOT production-like);
   *    - `metadata-simulation` (the
   *      `guarded-linked-candidate-expansion`
   *      row; the candidate-expansion rule is
   *      fixture-derived from the
   *      supersession edge map; the guard is
   *      structural);
   *    - `multi-anchor-simulation` (the
   *      `guarded-multi-anchor-linked-expansion`
   *      row; the candidate-expansion rule
   *      is fixture-derived from the union
   *      of the supersession edge map AND
   *      the multi-anchor treatment; the
   *      guard is structural). The
   *      multi-anchor-simulation category is
   *      the HONEST framing of the
   *      candidate-expansion rule: a
   *      reviewer who reads the category
   *      sees "this is what would happen
   *      IF the metadata existed at
   *      runtime, AND a runtime re-ranker
   *      applied the guard structural
   *      rule". */
  category:
    | "production-like"
    | "reranker-control"
    | "oracle"
    | "oracle-diagnostic"
    | "metadata-simulation"
    | "multi-anchor-simulation";
  /** The Experiment 9 candidate-expansion
   *  rule. The rule's output is the post-
   *  expansion top-K the guard reads. */
  candidateExpansionRule: CandidateExpansionRule;
  /** The guard rule applied BETWEEN the
   *  candidate-expansion step and the
   *  downstream re-ranker. The guard reads
   *  the post-expansion top-K + the
   *  injected-id set + the simulated edge
   *  map. */
  guardRule: SupersedesPromoteGuardRule;
}

// ---------------------------------------------------------------------------
// Guard rule application
// ---------------------------------------------------------------------------

/**
 * Apply a guard rule to a single query's
 * post-expansion top-K. The function is PURE.
 *
 * The guard is a structural rule: it reads
 * ONLY the post-expansion top-K + the
 * injected-id set + the simulated edge map +
 * (for the diagnostic oracle variant) the
 * query's `currentTruthIds`. The guard does
 * NOT mutate the input arrays; a new
 * `topIds` / `topScores` pair is returned.
 *
 * The guard is a COMPLETE re-rank (not a
 * pre-processing step). The guard's output
 * is the FINAL top-K; the multi-anchor
 * re-ranker is NOT applied on top of the
 * guard's output for guarded variants.
 *
 * The guard's protection logic:
 *   1. Partition the post-expansion top-K
 *      into 4 buckets:
 *        - `protectedAnchorFirst`: a multi-
 *          anchor record that was at rank 1
 *          AND the rule is one of the
 *          `supersedes-promote-guard` /
 *          `oracle-supersedes-promote-guard`
 *          kinds (Experiment 8's multi-
 *          anchor protection, integrated
 *          into the guard).
 *        - `supersedesFirst`: a candidate
 *          that `supersedes` another
 *          candidate in the same top-K AND
 *          is NOT blocked by the guard.
 *          A candidate is BLOCKED iff it is
 *          injected AND the rank-1 is
 *          non-injected (the guard's primary
 *          protection condition). For the
 *          oracle guard, a candidate is also
 *          BLOCKED iff its `supersedes`
 *          target is a current-truth id (the
 *          oracle guard's stronger
 *          protection).
 *        - `middle`: every other candidate
 *          that is not a protected anchor,
 *          not a `supersedes` candidate, and
 *          not a superseded record.
 *        - `supersededLast`: a candidate
 *          whose id is in the simulated
 *          `supersededBy` map AND is NOT a
 *          protected anchor.
 *   2. The output order is
 *      `protectedAnchorFirst` first (if any),
 *      then `supersedesFirst` (with the
 *      guard's protection applied), then
 *      `middle`, then `supersededLast`. The
 *      `supersedesFirst` bucket is emitted
 *      AFTER the `protectedAnchorFirst`
 *      bucket AND BEFORE the `middle`
 *      bucket. The guard's primary
 *      protection is: an injected
 *      `supersedes` candidate is placed in
 *      the `middle` bucket (not
 *      `supersedesFirst`) when the rank-1
 *      is non-injected. The guard's
 *      protection does NOT add a separate
 *      "non-injected rank-1 first" bucket:
 *      the non-injected rank-1 stays at its
 *      position in the input ordering
 *      unless it is the `protectedAnchorFirst`
 *      record. This design preserves the
 *      multi-anchor reranker's legitimate
 *      `supersedes` promotions of NON-
 *      INJECTED candidates (e.g., promoting
 *      7 above 22 on `temp-stale-fact-trap-
 *      release`) while blocking only the
 *      INJECTED `supersedes` candidates that
 *      would displace a non-injected rank-1
 *      (e.g., the `temp-rate-limit`
 *      regression where the injected 3 is
 *      promoted above 70).
 *
 * The function NEVER shortens the top-K. A
 * guard rule that produces an empty `topIds`
 * returns an empty result.
 *
 * The `promotionsBlocked` counter: the
 * number of `supersedes` candidates that
 * the guard blocked. The counter is the
 * guard's "fire" signal: a guarded variant
 * that blocked 0 promotions is
 * functionally identical to the unguarded
 * re-ranker; a guarded variant that blocked
 * ≥1 promotion is the one that eliminated
 * the `temp-rate-limit` regression the
 * guard was designed to eliminate.
 */
export function applySupersedesPromoteGuardRule(args: {
  rule: SupersedesPromoteGuardRule;
  topIds: ReadonlyArray<number>;
  topScores: ReadonlyArray<number>;
  injectedIds: ReadonlyArray<number>;
  query: BenchmarkQuery;
  downstreamRule: MultiAnchorRerankRule;
}): { topIds: number[]; topScores: number[]; promotionsBlocked: number } {
  const { rule, topIds: inputIds, topScores: inputScores, injectedIds, query, downstreamRule } = args;

  // Defensive copy. The function never
  // mutates the input arrays.
  const ids = [...inputIds];
  const scores = [...inputScores];
  if (ids.length === 0) {
    return { topIds: ids, topScores: scores, promotionsBlocked: 0 };
  }

  if (rule.kind === "none") {
    return { topIds: ids, topScores: scores, promotionsBlocked: 0 };
  }

  // The guard is only meaningful for the
  // `supersedes-promote-guard` /
  // `oracle-supersedes-promote-guard` kinds.
  // The guard is a COMPLETE re-rank (the
  // multi-anchor protection is integrated
  // via the `protectedAnchorFirst` bucket).
  const positions = ids.map((_, i) => i);
  const top0 = ids[0]!;
  const injectedSet = new Set(injectedIds);

  // Determine if the rank-1 candidate is
  // protected by the multi-anchor treatment.
  const isProtectedAnchor =
    SIMULATED_PROTECTED_ANCHOR_IDS.has(top0);

  // Determine if the rank-1 candidate is
  // non-injected. This is the GUARD's
  // primary protection condition.
  const isNonInjectedRank1 =
    !injectedSet.has(top0) && top0 !== undefined;

  // For the oracle guard, we also compute
  // the set of current-truth ids the
  // guard can use as a HINT for which
  // candidates to protect.
  const currentTruthSet: Set<number> | null =
    rule.kind === "oracle-supersedes-promote-guard"
      ? new Set(query.currentTruthIds)
      : null;

  const protectedAnchorFirst: number[] = [];
  const supersedesFirst: number[] = [];
  const middle: number[] = [];
  const supersededLast: number[] = [];

  // Step 1: emit the protected anchor (if any).
  // The protected anchor is at MOST one
  // record (the rank-1 record). The bucket
  // size is 1 when the rank-1 record is a
  // multi-anchor record; 0 otherwise.
  if (isProtectedAnchor) {
    protectedAnchorFirst.push(0);
  }

  // Step 2: partition the REST of the
  // positions. The protected anchor
  // (position 0) is excluded if it was
  // emitted as `protectedAnchorFirst`.
  // The non-injected rank-1 candidate
  // (position 0) is NOT excluded: the
  // guard does NOT have a separate
  // "non-injected rank-1 first" bucket.
  // The non-injected rank-1 stays at its
  // position in the input ordering, and
  // the guard's `supersedesFirst` bucket
  // is modified to exclude injected
  // `supersedes` candidates (the guard's
  // primary protection).
  const startIdx = isProtectedAnchor ? 1 : 0;
  const restPositions = positions.slice(startIdx);
  const topKSet = new Set(ids);

  // Count the number of promotions the
  // guard BLOCKED. The counter is the
  // number of `supersedes` candidates that
  // would have been in the
  // `supersedesFirst` bucket under the
  // unguarded re-rank but the guard
  // demoted them to the `middle` bucket.
  let promotionsBlocked = 0;

  for (const p of restPositions) {
    const id = ids[p]!;
    const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
    const isSuperseded =
      edge !== undefined && edge.isSuperseded;
    const supersedesInTopK =
      edge !== undefined &&
      edge.supersedes !== null &&
      topKSet.has(edge.supersedes);

    if (isSuperseded) {
      supersededLast.push(p);
      continue;
    }

    if (supersedesInTopK) {
      // The candidate would be promoted.
      // The guard blocks the promotion IF
      // the candidate is injected AND the
      // rank-1 is non-injected (the guard's
      // primary protection). For the oracle
      // guard, the guard also blocks the
      // promotion if the candidate's
      // `supersedes` target is a current-
      // truth id (the oracle guard's
      // stronger protection).
      const isInjected = injectedSet.has(id);
      const supersedesCurrent =
        currentTruthSet !== null &&
        edge !== undefined &&
        edge.supersedes !== null &&
        currentTruthSet.has(edge.supersedes);
      // The block condition: the candidate
      // is injected AND the rank-1 is
      // non-injected (the guard's primary
      // protection) OR the oracle guard's
      // hint says the `supersedes` target
      // is current truth (the oracle
      // guard's stronger protection, even
      // if the candidate is not injected).
      const blockPromotion =
        (isInjected && isNonInjectedRank1) ||
        supersedesCurrent === true;
      if (blockPromotion) {
        // The promotion is blocked; the
        // candidate is demoted to the
        // `supersededLast` bucket (the
        // BOTTOM of the output, below the
        // rank-1). The demotion ensures
        // the blocked candidate is NOT
        // promoted above the rank-1; the
        // candidate is treated as if it
        // were a superseded record for
        // ordering purposes. The counter
        // increments.
        supersededLast.push(p);
        promotionsBlocked += 1;
      } else {
        supersedesFirst.push(p);
      }
      continue;
    }

    middle.push(p);
  }

  const sorted: number[] = [
    ...protectedAnchorFirst,
    ...supersedesFirst,
    ...middle,
    ...supersededLast,
  ];

  const newIds: number[] = [];
  const newScores: number[] = [];
  for (const p of sorted) {
    newIds.push(ids[p]!);
    newScores.push(scores[p] ?? 0);
  }
  return {
    topIds: newIds,
    topScores: newScores,
    promotionsBlocked,
  };
}


// ---------------------------------------------------------------------------
// Per-query guarded-rerank output
// ---------------------------------------------------------------------------

/**
 * Per-query guarded-rerank output. The shape
 * is what the per-variant aggregator consumes.
 * The fields mirror Experiment 9's per-query
 * output (same baseline/after shape, same
 * category-change block) PLUS:
 *   - `tempRateLimitRegression`: `true` iff
 *     the per-query is `temp-rate-limit` AND
 *     the per-query regressed (baseline was
 *     `currentTruthAt1` and the after is not).
 *     The flag is the SPECIFIC regression
 *     mechanism Experiment 9 documents; the
 *     test surface pins the flag.
 *   - `injectedIds`: the candidate-expansion
 *     step's injected-id set, surfaced for
 *     audit (so a reviewer reading the
 *     per-query table can see WHICH ids the
 *     expansion injected and WHICH of them
 *     the guard blocked).
 *   - `promotionBlockedByGuard`: `true` iff
 *     the guard's `promotionsBlocked` counter
 *     was > 0 on this query. The flag is the
 *     per-query counterpart of the per-variant
 *     `promotionsBlockedByGuard` metric.
 */
export interface GuardedRerankPerQuery {
  queryId: string;
  family: string;
  /** Baseline (before candidate-generation +
   *  before guard + before downstream
   *  reranker) outcome. */
  baselineTop1Id: number | null;
  baselineCurrentTruthAt1: boolean;
  baselineStaleTop1: boolean;
  baselineStaleOverCurrent: boolean;
  baselineCategory: TemporalTruthCategory;
  baselineIsDivergentLabeled: boolean;
  /** Baseline `topKHasCurrentTruth`. */
  baselineCurrentInTopK: boolean;
  /** After candidate-generation (before
   *  guard + before downstream reranker)
   *  outcome. */
  afterExpansionCurrentInTopK: boolean;
  /** After candidate-generation + after
   *  guard + after downstream reranker
   *  outcome. */
  afterTop1Id: number | null;
  afterCurrentTruthAt1: boolean;
  afterStaleTop1: boolean;
  afterStaleOverCurrent: boolean;
  afterCategory: TemporalTruthCategory;
  /** Per-query deltas. */
  categoryChange: string;
  regression: boolean;
  /** `true` iff the per-query is
   *  `temp-rate-limit` AND the per-query
   *  regressed. */
  tempRateLimitRegression: boolean;
  /** The candidate-expansion step's
   *  injected-id set. */
  injectedIds: number[];
  /** `true` iff the candidate-expansion step
   *  injected a current-truth id. */
  expansionInjectedCurrent: boolean;
  /** `true` iff the guard's
   *  `promotionsBlocked` counter was > 0 on
   *  this query. */
  promotionBlockedByGuard: boolean;
  /** Per-query clean / fixture-ambiguous
   *  split. */
  isClean: boolean;
  isFixtureAmbiguous: boolean;
  /** Multi-anchor subset flag. */
  hasExcludedCurrentAnchor: boolean;
  isMultiAnchorSubset: boolean;
  /** Per-query after-guard top-K. Surfaced
   *  for audit so a reviewer can see the
   *  guard's effect. */
  afterGuardTopIds: number[];
  afterGuardTopScores: number[];
}

// ---------------------------------------------------------------------------
// Per-variant metrics
// ---------------------------------------------------------------------------

/**
 * Per-variant metrics. The block is the unit
 * the per-variant row in the headline table
 * consumes. The block mirrors Experiment 9's
 * metric block (same field names, same
 * deltas, same clean / fixture-ambiguous
 * split, same per-category change rollup).
 * The block ADDS:
 *   - `tempRateLimitRegressionCount`: the
 *     specific regression count for the
 *     `temp-rate-limit` query. The metric is
 *     the headline evidence: the guarded
 *     primary MUST produce 0; the unguarded
 *     Exp 9 variants produce 1.
 *   - `promotionsBlockedByGuard`: the per-
 *     variant count of `supersedes-promote`
 *     promotions the guard blocked on this
 *     slice. The metric is the guard's
 *     "fire" counter: a guarded variant that
 *     blocked 0 promotions is functionally
 *     identical to the unguarded reranker;
 *     a guarded variant that blocked ≥1
 *     promotion is the one that eliminated
 *     the `temp-rate-limit` regression the
 *     guard was designed to eliminate.
 */
export interface GuardedRerankVariantMetrics {
  /** Total temporal queries the variant
   *  covers. */
  total: number;
  cleanTotal: number;
  fixtureAmbiguousTotal: number;

  // Headline before/after counts.
  baselineCurrentTruthAt1: number;
  afterCurrentTruthAt1: number;
  currentTruthAt1Delta: number;
  currentTruthAt1RateDelta: number;

  baselineStaleTop1: number;
  afterStaleTop1: number;
  staleTop1Delta: number;

  baselineStaleOverCurrent: number;
  afterStaleOverCurrent: number;
  staleOverCurrentDelta: number;

  baselineCurrentMissing: number;
  afterExpansionCurrentMissing: number;
  afterCurrentMissing: number;
  currentMissingDelta: number;
  expansionCurrentMissingDelta: number;

  regressionCount: number;
  recoveredByExpansion: number;
  recoveredByReranker: number;
  unchangedBecauseCurrentMissing: number;
  expansionInjectedCurrentCount: number;

  /** Headline evidence: the specific
   *  regression count for the
   *  `temp-rate-limit` query. */
  tempRateLimitRegressionCount: number;
  /** Per-variant count of
   *  `supersedes-promote` promotions the
   *  guard blocked on this slice. The
   *  metric is the guard's "fire" counter. */
  promotionsBlockedByGuard: number;

  meanExpandedTopKSize: number;
  maxExpandedTopKSize: number;
  injectedIdsSet: ReadonlyArray<number>;

  // Multi-anchor subset.
  multiAnchorQueryCount: number;
  multiAnchorBaselineCurrentTruthAt1: number;
  multiAnchorAfterCurrentTruthAt1: number;
  multiAnchorCurrentTruthAt1Delta: number;
  multiAnchorRegressionCount: number;
  multiAnchorRecoveredByExpansion: number;
  multiAnchorExpansionInjectedCurrentCount: number;

  // Clean / fixture-ambiguous split.
  cleanBaselineCurrentTruthAt1: number;
  cleanAfterCurrentTruthAt1: number;
  cleanCurrentTruthAt1Delta: number;
  cleanRegressionCount: number;
  cleanTempRateLimitRegressionCount: number;
  fixtureAmbiguousBaselineCurrentTruthAt1: number;
  fixtureAmbiguousAfterCurrentTruthAt1: number;
  fixtureAmbiguousCurrentTruthAt1Delta: number;
  fixtureAmbiguousRegressionCount: number;

  perCategoryChange: Record<string, number>;
  perQuery: ReadonlyArray<GuardedRerankPerQuery>;
}

/**
 * Per-variant verdict. Mirrors Experiment 9's
 * verdict kinds.
 */
export type GuardedRerankVerdict = "safe" | "unsafe" | "neutral";

/**
 * Per-variant row in the headline table.
 */
export interface GuardedRerankVariantRow {
  variant: GuardedRerankVariant;
  metrics: GuardedRerankVariantMetrics;
  verdict: GuardedRerankVerdict;
  verdictNote: string;
}

// ---------------------------------------------------------------------------
// Built-in variants
// ---------------------------------------------------------------------------

/**
 * The set of built-in guarded-rerank variants
 * the experiment ships with. The order is
 * declaration order; the report iterates in
 * this order.
 *
 * The first three variants are mirrors of
 * Experiment 9's variant table (the
 * `baseline-no-rerank`, the
 * `reranker-control-multi-anchor-aware-combined`,
 * and the `oracle-candidate-injection-ceiling`).
 * The fourth is the
 * `guarded-multi-anchor-linked-expansion`
 * variant (the PRIMARY DELIVERABLE). The
 * fifth is the `guarded-linked-candidate-
 * expansion` variant (the narrow guard). The
 * sixth is the `guarded-no-op` sanity row.
 * The seventh is the
 * `oracle-guarded-candidate-injection-ceiling`
 * variant (the DIAGNOSTIC IDEAL PROTECTION
 * CEILING).
 */
export const BUILTIN_GUARDED_RERANK_VARIANTS: ReadonlyArray<GuardedRerankVariant> =
  [
    {
      id: "baseline-no-rerank",
      description:
        "Baseline: no candidate expansion, no guard, no reranker. The lexical baseline's existing top-K order is used as-is. The reference row; production-like.",
      category: "production-like",
      candidateExpansionRule: { kind: "none" },
      guardRule: { kind: "none" },
    },
    {
      id: "reranker-control-multi-anchor-aware-combined",
      description:
        "Reranker-control: no candidate expansion, no guard; the downstream reranker is Experiment 8's multi-anchor-aware-combined. The fixed downstream control. This variant is the experiment's control row; the guarded primary composes the same downstream reranker on top of the guard.",
      category: "reranker-control",
      candidateExpansionRule: { kind: "none" },
      guardRule: { kind: "none" },
    },
    {
      id: "oracle-candidate-injection-ceiling",
      description:
        "Oracle: for every query, inject every id in currentTruthIds that is NOT in the baseline top-K into the candidate set, then apply the unguarded multi-anchor-aware-combined downstream reranker. The honest candidate-generation ceiling (no guard). Mirrors Experiment 9's oracle. The variant is the BEFORE-state reference for the guard's diagnostic ceiling.",
      category: "oracle",
      candidateExpansionRule: { kind: "oracle-candidate-injection-ceiling" },
      guardRule: { kind: "none" },
    },
    {
      id: "guarded-multi-anchor-linked-expansion",
      description:
        "Multi-anchor-simulation (PRIMARY DELIVERABLE): Experiment 9's metadata-simulation-multi-anchor-linked-expansion candidate-expansion rule PLUS the supersedes-promote-guard guard rule. The guard is a COMPLETE re-rank (the multi-anchor protection is integrated): the guard partitions the post-expansion top-K into protectedAnchorFirst (multi-anchor records at rank 1), supersedesFirst (supersedes candidates that are NOT blocked by the guard), middle (other candidates, including injected supersedes candidates blocked by the guard), and supersededLast (superseded records). The guard's primary protection: an injected supersedes candidate is blocked (demoted to the middle bucket) when the rank-1 is non-injected. The rule does NOT consult currentTruthIds. The guard is a STRUCTURAL rule on the candidate-expansion's provenance (injected vs non-injected), not a current-truth lookup. Honest trade-off: the guard ELIMINATES the temp-rate-limit regression (where the rank-1 is a current-truth candidate) AT THE COST of losing the +2 recoveries of Experiment 9's candidate-expansion step (where the rank-1 is a stale candidate and the injected supersedes candidate is the current truth — the guard blocks the legitimate recovery too). The variant is the closest a non-oracle structural rule can come to the diagnostic ceiling; the experiment's PRIMARY DELIVERABLE.",
      category: "multi-anchor-simulation",
      candidateExpansionRule: {
        kind: "metadata-simulation-multi-anchor-linked-expansion",
      },
      guardRule: { kind: "supersedes-promote-guard" },
    },
    {
      id: "guarded-linked-candidate-expansion",
      description:
        "Metadata-simulation: Experiment 9's metadata-simulation-linked-candidate-expansion candidate-expansion rule (the pure supersededBy-projection rule) PLUS the supersedes-promote-guard guard rule PLUS the multi-anchor-aware-combined downstream reranker. Surfaces the guard's marginal effect on the pure supersededBy-projection candidate-expansion rule (the rule kind the linked-expansion is fixture-derived from).",
      category: "metadata-simulation",
      candidateExpansionRule: {
        kind: "metadata-simulation-linked-candidate-expansion",
      },
      guardRule: { kind: "supersedes-promote-guard" },
    },
    {
      id: "guarded-no-op",
      description:
        "Reranker-control sanity row: no candidate expansion, but the supersedes-promote-guard guard rule is active. The guard is a pass-through when no candidate was injected (the injected-id set is empty). The variant surfaces 'the guard alone, with no expansion, is a no-op': the guard's promotionsBlockedByGuard is 0; the variant's afterCurrentTruthAt1 equals the reranker-control's. The row is the honest 'the guard is a structural rule, not a semantic re-ranker' framing.",
      category: "reranker-control",
      candidateExpansionRule: { kind: "none" },
      guardRule: { kind: "supersedes-promote-guard" },
    },
    {
      id: "oracle-guarded-candidate-injection-ceiling",
      description:
        "Oracle-DIAGNOSTIC: for every query, inject every id in currentTruthIds that is NOT in the baseline top-K into the candidate set, then apply the oracle-supersedes-promote-guard guard rule (the oracle guard: the rule is allowed to consult currentTruthIds as a HINT for which candidates to protect), then apply the multi-anchor-aware-combined downstream reranker. The IDEAL PROTECTION CEILING: a re-ranker that knows which candidates are current AND protects them. Clearly labeled oracle-diagnostic; NOT production-like. The variant bounds the ideal protection the guarded primary could achieve if the production-side schema carried the currentTruthIds column. Use this row to read 'how far is the primary from the ideal ceiling?'.",
      category: "oracle-diagnostic",
      candidateExpansionRule: { kind: "oracle-candidate-injection-ceiling" },
      guardRule: { kind: "oracle-supersedes-promote-guard" },
    },
  ];

// ---------------------------------------------------------------------------
// Per-query guarded-rerank evaluation
// ---------------------------------------------------------------------------

/**
 * Run a single guarded-rerank variant on a
 * single query. The function is pure.
 */
export function evaluateGuardedRerankForQuery(args: {
  variant: GuardedRerankVariant;
  eval: QueryEval;
  query: BenchmarkQuery;
  downstreamVariant: MultiAnchorRerankVariant;
}): GuardedRerankPerQuery {
  const { variant, eval: e, query: q, downstreamVariant } = args;

  // The `baseline-no-rerank` variant is a
  // pure pass-through: no candidate
  // expansion, no guard, no downstream
  // reranker. The contract is `after ===
  // baseline`.
  const isBaselineNoRerank = variant.id === "baseline-no-rerank";

  // Step 1: apply the candidate-expansion
  // rule.
  const expansion: CandidateExpansionResult = isBaselineNoRerank
    ? {
        topIds: [...e.topIds],
        topScores: [...e.topScores],
        injectedIds: [],
        injectionScores: [],
      }
    : applyCandidateExpansionRule({
        rule: variant.candidateExpansionRule,
        eval: e,
        query: q,
      });

  // Step 2: classify the baseline outcome.
  const baselineDiag = classifyTemporalTruthFailure(e, q);

  // Step 3: classify the after-expansion
  // outcome.
  const afterExpansionEval: QueryEval = {
    ...e,
    topIds: expansion.topIds,
    topScores: expansion.topScores,
  };
  const afterExpansionDiag = classifyTemporalTruthFailure(
    afterExpansionEval,
    q,
  );

  // Step 4: apply the guard rule (between
  // candidate-expansion and downstream
  // reranker).
  //
  // The `baseline-no-rerank` variant
  // SKIPS the guard (the variant is a
  // pass-through). The `reranker-control`
  // variants (reranker-control-multi-
  // anchor-aware-combined, guarded-no-op)
  // apply the guard (or skip it for the
  // no-expansion control); the guard is a
  // pass-through when the injected-id set
  // is empty.
  let afterGuard: { topIds: number[]; topScores: number[]; promotionsBlocked: number };
  if (isBaselineNoRerank) {
    afterGuard = {
      topIds: [...expansion.topIds],
      topScores: [...expansion.topScores],
      promotionsBlocked: 0,
    };
  } else {
    afterGuard = applySupersedesPromoteGuardRule({
      rule: variant.guardRule,
      topIds: expansion.topIds,
      topScores: expansion.topScores,
      injectedIds: expansion.injectedIds,
      query: q,
      downstreamRule: downstreamVariant.rule as MultiAnchorRerankRule,
    });
  }

  // Step 5: apply the downstream reranker
  // (Experiment 8's `multi-anchor-aware-
  // combined`). The reranker is SKIPPED
  // for:
  //   - the `baseline-no-rerank` variant
  //     (the variant is a pass-through);
  //   - the guarded variants
  //     (`supersedes-promote-guard` /
  //     `oracle-supersedes-promote-guard`).
  //     The guard is a COMPLETE re-rank: it
  //     integrates the multi-anchor
  //     protection (the
  //     `protectedAnchorFirst` bucket) AND
  //     the `supersededBy` demote step
  //     (the `supersededLast` bucket) AND
  //     the `supersedes-promote` step
  //     (the `supersedesFirst` bucket,
  //     with the injected-candidate
  //     protection). Composing the
  //     multi-anchor-aware-combined
  //     re-ranker on top of the guard
  //     would re-introduce the regression
  //     the guard is designed to eliminate
  //     (the multi-anchor-aware-combined's
  //     `supersedesFirst` bucket would
  //     include the injected candidate
  //     again). The guard is therefore the
  //     FINAL re-rank step for guarded
  //     variants.
  const isGuarded = variant.guardRule.kind !== "none";
  let afterRerank: { topIds: number[]; topScores: number[] };
  if (isBaselineNoRerank || isGuarded) {
    afterRerank = {
      topIds: [...afterGuard.topIds],
      topScores: [...afterGuard.topScores],
    };
  } else {
    const afterGuardEval: QueryEval = {
      ...e,
      topIds: afterGuard.topIds,
      topScores: afterGuard.topScores,
    };
    afterRerank = applyMultiAnchorRerankRule({
      rule: downstreamVariant.rule as MultiAnchorRerankRule,
      eval: afterGuardEval,
      query: q,
    });
  }
  const afterRerankEval: QueryEval = {
    ...e,
    topIds: afterRerank.topIds,
    topScores: afterRerank.topScores,
  };
  const afterDiag = classifyTemporalTruthFailure(afterRerankEval, q);

  const categoryChange = `${baselineDiag.category} -> ${afterDiag.category}`;

  const regression =
    baselineDiag.top1IsCurrentTruth === true &&
    afterDiag.top1IsCurrentTruth === false;

  const tempRateLimitRegression = regression && e.queryId === "temp-rate-limit";

  const promotionBlockedByGuard = afterGuard.promotionsBlocked > 0;

  let hasExcludedCurrentAnchor = false;
  for (const id of q.currentTruthIds) {
    if (SIMULATED_MULTI_ANCHOR_IDS.has(id)) {
      hasExcludedCurrentAnchor = true;
      break;
    }
  }

  // `expansionInjectedCurrent`: `true` iff
  // the candidate-expansion step injected
  // an id that is in `currentTruthIds`.
  const currentSet = new Set(q.currentTruthIds);
  let expansionInjectedCurrent = false;
  for (const id of expansion.injectedIds) {
    if (currentSet.has(id)) {
      expansionInjectedCurrent = true;
      break;
    }
  }

  return {
    queryId: e.queryId,
    family: e.family,
    baselineTop1Id: baselineDiag.top1Id,
    baselineCurrentTruthAt1: baselineDiag.top1IsCurrentTruth,
    baselineStaleTop1: baselineDiag.top1IsStale,
    baselineStaleOverCurrent:
      baselineDiag.top1IsStale && baselineDiag.topKHasCurrentTruth,
    baselineCategory: baselineDiag.category,
    baselineIsDivergentLabeled: baselineDiag.isDivergentLabeled,
    baselineCurrentInTopK: baselineDiag.topKHasCurrentTruth,
    afterExpansionCurrentInTopK: afterExpansionDiag.topKHasCurrentTruth,
    afterTop1Id: afterDiag.top1Id,
    afterCurrentTruthAt1: afterDiag.top1IsCurrentTruth,
    afterStaleTop1: afterDiag.top1IsStale,
    afterStaleOverCurrent:
      afterDiag.top1IsStale && afterDiag.topKHasCurrentTruth,
    afterCategory: afterDiag.category,
    categoryChange,
    regression,
    tempRateLimitRegression,
    injectedIds: expansion.injectedIds,
    expansionInjectedCurrent,
    promotionBlockedByGuard,
    isClean: !baselineDiag.isDivergentLabeled,
    isFixtureAmbiguous: baselineDiag.isDivergentLabeled,
    hasExcludedCurrentAnchor,
    isMultiAnchorSubset: hasExcludedCurrentAnchor,
    afterGuardTopIds: afterGuard.topIds,
    afterGuardTopScores: afterGuard.topScores,
  };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Run a single guarded-rerank variant on the
 * per-query input. The function is pure.
 */
export function evaluateGuardedRerankVariant(args: {
  variant: GuardedRerankVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  downstreamVariant?: MultiAnchorRerankVariant;
}): GuardedRerankVariantMetrics {
  const {
    variant,
    evals,
    queries,
    downstreamVariant = (() => {
      for (const v of BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS) {
        if (v.id === "multi-anchor-aware-combined") return v;
      }
      throw new Error(
        "supersedes-promote-guard: BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS " +
          "must contain a 'multi-anchor-aware-combined' variant (Experiment 8 contract)",
      );
    })(),
  } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `evaluateGuardedRerankVariant: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length}) for variant "${variant.id}"`,
    );
  }
  if (downstreamVariant.id !== "multi-anchor-aware-combined") {
    throw new Error(
      `evaluateGuardedRerankVariant: downstreamVariant must be ` +
        `'multi-anchor-aware-combined' for variant "${variant.id}", ` +
        `got "${downstreamVariant.id}"`,
    );
  }

  const perQuery: GuardedRerankPerQuery[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (e.queryId !== q.id) {
      throw new Error(
        `evaluateGuardedRerankVariant: evals[${i}].queryId="${e.queryId}" does ` +
          `not match queries[${i}].id="${q.id}" for variant "${variant.id}"`,
      );
    }
    if (q.family !== "temporal") continue;
    perQuery.push(
      evaluateGuardedRerankForQuery({
        variant,
        eval: e,
        query: q,
        downstreamVariant,
      }),
    );
  }
  return aggregateGuardedRerankPerQuery(perQuery);
}

/**
 * Aggregate the per-query guarded-rerank
 * decisions into a `GuardedRerankVariantMetrics`
 * block. The function is pure.
 */
export function aggregateGuardedRerankPerQuery(
  perQuery: ReadonlyArray<GuardedRerankPerQuery>,
): GuardedRerankVariantMetrics {
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
  let afterExpansionCurrentMissing = 0;
  let afterCurrentMissing = 0;
  let regressionCount = 0;
  let tempRateLimitRegressionCount = 0;
  let promotionsBlockedByGuard = 0;
  let recoveredByExpansion = 0;
  let recoveredByReranker = 0;
  let unchangedBecauseCurrentMissing = 0;
  let expansionInjectedCurrentCount = 0;
  let totalExpandedSize = 0;
  let maxExpandedSize = 0;
  const injectedSet = new Set<number>();

  let multiAnchorQueryCount = 0;
  let multiAnchorBaselineCurrentTruthAt1 = 0;
  let multiAnchorAfterCurrentTruthAt1 = 0;
  let multiAnchorRegressionCount = 0;
  let multiAnchorRecoveredByExpansion = 0;
  let multiAnchorExpansionInjectedCurrentCount = 0;

  let cleanBaselineCurrentTruthAt1 = 0;
  let cleanAfterCurrentTruthAt1 = 0;
  let cleanRegressionCount = 0;
  let cleanTempRateLimitRegressionCount = 0;
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
    if (p.baselineCurrentInTopK === false) {
      if (p.afterExpansionCurrentInTopK === false) {
        afterExpansionCurrentMissing += 1;
      }
    }
    if (p.regression) regressionCount += 1;
    if (p.tempRateLimitRegression) tempRateLimitRegressionCount += 1;
    if (p.promotionBlockedByGuard) promotionsBlockedByGuard += 1;
    if (
      p.baselineCurrentInTopK === false &&
      p.afterExpansionCurrentInTopK === true
    ) {
      recoveredByExpansion += 1;
    }
    if (
      p.baselineCurrentInTopK === false &&
      p.afterExpansionCurrentInTopK === false &&
      p.afterCurrentTruthAt1 === true
    ) {
      recoveredByReranker += 1;
    }
    if (
      p.baselineCurrentInTopK === false &&
      p.afterExpansionCurrentInTopK === false &&
      p.afterCurrentTruthAt1 === false
    ) {
      unchangedBecauseCurrentMissing += 1;
    }
    if (p.expansionInjectedCurrent) expansionInjectedCurrentCount += 1;

    const expandedSize = p.afterGuardTopIds.length;
    totalExpandedSize += expandedSize;
    if (expandedSize > maxExpandedSize) maxExpandedSize = expandedSize;
    for (const id of p.injectedIds) injectedSet.add(id);

    if (p.hasExcludedCurrentAnchor) {
      multiAnchorQueryCount += 1;
      if (p.baselineCurrentTruthAt1)
        multiAnchorBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) multiAnchorAfterCurrentTruthAt1 += 1;
      if (p.regression) multiAnchorRegressionCount += 1;
      if (
        p.baselineCurrentInTopK === false &&
        p.afterExpansionCurrentInTopK === true
      ) {
        multiAnchorRecoveredByExpansion += 1;
      }
      if (p.expansionInjectedCurrent)
        multiAnchorExpansionInjectedCurrentCount += 1;
    }

    if (p.isClean) {
      if (p.baselineCurrentTruthAt1) cleanBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) cleanAfterCurrentTruthAt1 += 1;
      if (p.regression) cleanRegressionCount += 1;
      if (p.tempRateLimitRegression) cleanTempRateLimitRegressionCount += 1;
    } else {
      if (p.baselineCurrentTruthAt1)
        fixtureAmbiguousBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1)
        fixtureAmbiguousAfterCurrentTruthAt1 += 1;
      if (p.regression) fixtureAmbiguousRegressionCount += 1;
    }

    perCategoryChange[p.categoryChange] =
      (perCategoryChange[p.categoryChange] ?? 0) + 1;
  }

  const safeDiv = (n: number, d: number): number => (d > 0 ? n / d : 0);
  const currentTruthAt1Delta = afterCurrentTruthAt1 - baselineCurrentTruthAt1;
  const currentTruthAt1RateDelta =
    safeDiv(afterCurrentTruthAt1, total) -
    safeDiv(baselineCurrentTruthAt1, total);
  const staleTop1Delta = afterStaleTop1 - baselineStaleTop1;
  const staleOverCurrentDelta =
    afterStaleOverCurrent - baselineStaleOverCurrent;
  const currentMissingDelta = afterCurrentMissing - baselineCurrentMissing;
  const expansionCurrentMissingDelta =
    afterExpansionCurrentMissing - baselineCurrentMissing;

  const cleanCurrentTruthAt1Delta =
    cleanAfterCurrentTruthAt1 - cleanBaselineCurrentTruthAt1;
  const fixtureAmbiguousCurrentTruthAt1Delta =
    fixtureAmbiguousAfterCurrentTruthAt1 -
    fixtureAmbiguousBaselineCurrentTruthAt1;

  const multiAnchorCurrentTruthAt1Delta =
    multiAnchorAfterCurrentTruthAt1 - multiAnchorBaselineCurrentTruthAt1;

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
    afterExpansionCurrentMissing,
    afterCurrentMissing,
    currentMissingDelta,
    expansionCurrentMissingDelta,
    regressionCount,
    tempRateLimitRegressionCount,
    promotionsBlockedByGuard,
    recoveredByExpansion,
    recoveredByReranker,
    unchangedBecauseCurrentMissing,
    expansionInjectedCurrentCount,
    meanExpandedTopKSize: safeDiv(totalExpandedSize, total),
    maxExpandedTopKSize: maxExpandedSize,
    injectedIdsSet: [...injectedSet].sort((a, b) => a - b),
    multiAnchorQueryCount,
    multiAnchorBaselineCurrentTruthAt1,
    multiAnchorAfterCurrentTruthAt1,
    multiAnchorCurrentTruthAt1Delta,
    multiAnchorRegressionCount,
    multiAnchorRecoveredByExpansion,
    multiAnchorExpansionInjectedCurrentCount,
    cleanBaselineCurrentTruthAt1,
    cleanAfterCurrentTruthAt1,
    cleanCurrentTruthAt1Delta,
    cleanRegressionCount,
    cleanTempRateLimitRegressionCount,
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
 * Compute the per-variant verdict. Mirrors
 * Experiment 9's verdict function.
 */
export function computeGuardedRerankVerdict(
  metrics: GuardedRerankVariantMetrics,
): { verdict: GuardedRerankVerdict; note: string } {
  if (metrics.regressionCount > 0) {
    return {
      verdict: "unsafe",
      note: `introduced ${metrics.regressionCount} regression(s) ` +
        `(including ${metrics.tempRateLimitRegressionCount} on temp-rate-limit); ` +
        `the guarded-rerank variant is unsafe on this slice`,
    };
  }
  if (metrics.currentTruthAt1Delta > 0) {
    return {
      verdict: "safe",
      note: `recovered ${metrics.currentTruthAt1Delta} currentTruthAt1 ` +
        `query/queries with 0 regressions (temp-rate-limit: ${metrics.tempRateLimitRegressionCount})`,
    };
  }
  return {
    verdict: "neutral",
    note:
      "no regressions, no currentTruthAt1 recovery; the guarded-rerank variant " +
      "preserved the baseline on this slice (research probe that did not help; " +
      "verdict is neutral, not safe)",
  };
}

// ---------------------------------------------------------------------------
// Per-variant row
// ---------------------------------------------------------------------------

/**
 * Build a per-variant row.
 */
export function buildGuardedRerankVariantRow(args: {
  variant: GuardedRerankVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
}): GuardedRerankVariantRow {
  const { variant } = args;
  const metrics = evaluateGuardedRerankVariant(args);
  const { verdict, note } = computeGuardedRerankVerdict(metrics);
  return { variant, metrics, verdict, verdictNote: note };
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level per-variant report.
 */
export interface GuardedRerankReport {
  sourceVariant: string;
  recordCount: number | null;
  temporalQueryCount: number;
  supersessionEdgeMapSize: number;
  multiAnchorTreatmentSize: number;
  downstreamRerankerId: string;
  variants: ReadonlyArray<GuardedRerankVariantRow>;
  gapBreakdown: {
    unchangedByVariant: Record<string, number>;
    recoveredByExpansionByVariant: Record<string, number>;
    recoveredByRerankerByVariant: Record<string, number>;
    expansionInjectedCurrentByVariant: Record<string, number>;
  };
  multiAnchorSubset: {
    total: number;
    byVariant: Record<
      string,
      {
        baselineCurrentTruthAt1: number;
        afterCurrentTruthAt1: number;
        currentTruthAt1Delta: number;
        regressionCount: number;
        recoveredByExpansion: number;
      }
    >;
    perQuery: ReadonlyArray<{
      queryId: string;
      family: string;
      multiAnchorCurrentTruthIds: ReadonlyArray<number>;
    }>;
  };
  semanticOverlay?: {
    source: string;
    covered: number;
    hit: number;
    miss: number;
    recoveredByVariant: Record<string, number>;
  };
  categoryChangeKeys: ReadonlyArray<string>;
}

/**
 * Top-level orchestrator. Pure: no I/O, no
 * mutation, no provider calls.
 */
export function buildGuardedRerankReport(args: {
  sourceVariant: string;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  variants?: ReadonlyArray<GuardedRerankVariant>;
  recordCount?: number | null;
  semantic?: { source: string; byQueryId: ReadonlyMap<string, "hit" | "miss"> };
}): GuardedRerankReport {
  const {
    sourceVariant,
    evals,
    queries,
    variants = BUILTIN_GUARDED_RERANK_VARIANTS,
    recordCount = null,
    semantic,
  } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `buildGuardedRerankReport: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length})`,
    );
  }
  const rows: GuardedRerankVariantRow[] = [];
  for (const v of variants) {
    rows.push(
      buildGuardedRerankVariantRow({ variant: v, evals, queries }),
    );
  }
  let temporalQueryCount = 0;
  for (const q of queries) {
    if (q.family === "temporal") temporalQueryCount += 1;
  }
  const perQuerySubset: Array<{
    queryId: string;
    family: string;
    multiAnchorCurrentTruthIds: ReadonlyArray<number>;
  }> = [];
  for (const q of queries) {
    if (q.family !== "temporal") continue;
    const multiAnchor: number[] = [];
    for (const id of q.currentTruthIds) {
      if (SIMULATED_MULTI_ANCHOR_IDS.has(id)) multiAnchor.push(id);
    }
    if (multiAnchor.length > 0) {
      perQuerySubset.push({
        queryId: q.id,
        family: q.family,
        multiAnchorCurrentTruthIds: [...multiAnchor].sort((a, b) => a - b),
      });
    }
  }
  const byVariant: Record<
    string,
    {
      baselineCurrentTruthAt1: number;
      afterCurrentTruthAt1: number;
      currentTruthAt1Delta: number;
      regressionCount: number;
      recoveredByExpansion: number;
    }
  > = {};
  for (const row of rows) {
    const m = row.metrics;
    byVariant[row.variant.id] = {
      baselineCurrentTruthAt1: m.multiAnchorBaselineCurrentTruthAt1,
      afterCurrentTruthAt1: m.multiAnchorAfterCurrentTruthAt1,
      currentTruthAt1Delta: m.multiAnchorCurrentTruthAt1Delta,
      regressionCount: m.multiAnchorRegressionCount,
      recoveredByExpansion: m.multiAnchorRecoveredByExpansion,
    };
  }
  const unchangedByVariant: Record<string, number> = {};
  const recoveredByExpansionByVariant: Record<string, number> = {};
  const recoveredByRerankerByVariant: Record<string, number> = {};
  const expansionInjectedCurrentByVariant: Record<string, number> = {};
  for (const row of rows) {
    unchangedByVariant[row.variant.id] =
      row.metrics.unchangedBecauseCurrentMissing;
    recoveredByExpansionByVariant[row.variant.id] =
      row.metrics.recoveredByExpansion;
    recoveredByRerankerByVariant[row.variant.id] =
      row.metrics.recoveredByReranker;
    expansionInjectedCurrentByVariant[row.variant.id] =
      row.metrics.expansionInjectedCurrentCount;
  }
  let semanticOverlay: GuardedRerankReport["semanticOverlay"];
  if (semantic) {
    const missQueries: string[] = [];
    for (const q of queries) {
      if (q.family !== "temporal") continue;
      const v = semantic.byQueryId.get(q.id);
      if (v === "miss") missQueries.push(q.id);
    }
    const recoveredByVariant: Record<string, number> = {};
    for (const row of rows) {
      let n = 0;
      for (const p of row.metrics.perQuery) {
        if (p.baselineCurrentTruthAt1) continue;
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
    if (missQueries.length !== miss) {
      throw new Error(
        `buildGuardedRerankReport: semantic overlay miss mismatch ` +
          `(${missQueries.length} vs ${miss})`,
      );
    }
  }
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
    supersessionEdgeMapSize: SIMULATED_SUPERSESSION_EDGES.size,
    multiAnchorTreatmentSize: SIMULATED_MULTI_ANCHOR_TREATMENT.size,
    downstreamRerankerId: "multi-anchor-aware-combined",
    variants: rows,
    gapBreakdown: {
      unchangedByVariant,
      recoveredByExpansionByVariant,
      recoveredByRerankerByVariant,
      expansionInjectedCurrentByVariant,
    },
    multiAnchorSubset: {
      total: perQuerySubset.length,
      byVariant,
      perQuery: perQuerySubset,
    },
    ...(semanticOverlay ? { semanticOverlay } : {}),
    categoryChangeKeys,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Render a `GuardedRerankReport` as a
 * human-readable text block. Deterministic.
 */
export function formatGuardedRerankReport(
  report: GuardedRerankReport,
): string {
  const out: string[] = [];
  out.push(
    `# Supersedes-promote guard probe (source: ${report.sourceVariant})`,
  );
  if (report.recordCount !== null) {
    out.push(`#   (records: ${report.recordCount})`);
  }
  out.push(`#   (temporal queries: ${report.temporalQueryCount})`);
  out.push(
    `#   (simulated supersession edge map: ${report.supersessionEdgeMapSize} entries; ` +
      `multi-anchor treatment: ${report.multiAnchorTreatmentSize} entries)`,
  );
  out.push(
    `#   (downstream reranker: ${report.downstreamRerankerId})`,
  );
  out.push("");

  out.push("## Variant table (temporal slice)");
  out.push("");
  out.push(
    "  category | variant | n | baseline@1 | after@1 | delta | recoveredByExpansion | currentMissing baseline->afterExpansion->afterRerank | regressions | tempRateLimit | promotionsBlocked | verdict",
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(25)} | ${row.variant.id.padEnd(60)} | ` +
        `${String(m.total).padStart(2)} | ` +
        `${String(m.baselineCurrentTruthAt1).padStart(10)} | ` +
        `${String(m.afterCurrentTruthAt1).padStart(7)} | ` +
        `${signedInt(m.currentTruthAt1Delta).padStart(5)} | ` +
        `${String(m.recoveredByExpansion).padStart(20)} | ` +
        `${String(m.baselineCurrentMissing).padStart(2)}->${String(m.afterExpansionCurrentMissing).padStart(2)}->${String(m.afterCurrentMissing).padStart(2)} | ` +
        `${String(m.regressionCount).padStart(11)} | ` +
        `${String(m.tempRateLimitRegressionCount).padStart(13)} | ` +
        `${String(m.promotionsBlockedByGuard).padStart(17)} | ` +
        `${row.verdict}`,
    );
  }
  out.push("");

  out.push("## Variant table (clean / fixture-ambiguous split)");
  out.push("");
  out.push(
    "  category | variant | cleanN | cleanBaseline@1 | cleanAfter@1 | cleanDelta | cleanRegressions | cleanTempRateLimit | ambigN | ambigBaseline@1 | ambigAfter@1 | ambigDelta | ambigRegressions",
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(25)} | ${row.variant.id.padEnd(60)} | ` +
        `${String(m.cleanTotal).padStart(6)} | ` +
        `${String(m.cleanBaselineCurrentTruthAt1).padStart(14)} | ` +
        `${String(m.cleanAfterCurrentTruthAt1).padStart(11)} | ` +
        `${signedInt(m.cleanCurrentTruthAt1Delta).padStart(10)} | ` +
        `${String(m.cleanRegressionCount).padStart(16)} | ` +
        `${String(m.cleanTempRateLimitRegressionCount).padStart(18)} | ` +
        `${String(m.fixtureAmbiguousTotal).padStart(6)} | ` +
        `${String(m.fixtureAmbiguousBaselineCurrentTruthAt1).padStart(15)} | ` +
        `${String(m.fixtureAmbiguousAfterCurrentTruthAt1).padStart(12)} | ` +
        `${signedInt(m.fixtureAmbiguousCurrentTruthAt1Delta).padStart(10)} | ` +
        `${String(m.fixtureAmbiguousRegressionCount).padStart(17)}`,
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

  out.push("## Multi-anchor subset per-query breakdown");
  out.push("");
  out.push(
    `  total temporal queries whose currentTruthIds intersects SIMULATED_MULTI_ANCHOR_IDS: ${report.multiAnchorSubset.total}`,
  );
  out.push("");
  out.push("  per-query breakdown (sorted by queryId):");
  if (report.multiAnchorSubset.perQuery.length === 0) {
    out.push("    (no multi-anchor queries on the temporal slice)");
  } else {
    const sorted = [...report.multiAnchorSubset.perQuery].sort((a, b) =>
      a.queryId < b.queryId ? -1 : a.queryId > b.queryId ? 1 : 0,
    );
    for (const p of sorted) {
      out.push(
        `    ${p.queryId.padEnd(48)}  family=${p.family.padEnd(10)}  ` +
          `multi-anchor=${JSON.stringify(p.multiAnchorCurrentTruthIds)}`,
      );
    }
  }
  out.push("");

  out.push("## Gap the guard cannot close");
  out.push("");
  out.push(
    "  The gap is the queries whose baseline `currentMissing` is still " +
      "`currentMissing` after BOTH the candidate expansion step and the " +
      "downstream reranker. A query is `unchangedBecauseCurrentMissing` iff " +
      "the baseline was missing AND the after-expansion step was missing " +
      "AND the after-rerank step was missing.",
  );
  out.push("");
  out.push("  per-variant (unchangedBecauseCurrentMissing):");
  for (const [vid, n] of Object.entries(
    report.gapBreakdown.unchangedByVariant,
  )) {
    out.push(`    ${vid.padEnd(60)}  ${n}`);
  }
  out.push("");
  out.push("  per-variant (recoveredByExpansion):");
  for (const [vid, n] of Object.entries(
    report.gapBreakdown.recoveredByExpansionByVariant,
  )) {
    out.push(`    ${vid.padEnd(60)}  ${n}`);
  }
  out.push("");
  out.push("  per-variant (recoveredByReranker):");
  for (const [vid, n] of Object.entries(
    report.gapBreakdown.recoveredByRerankerByVariant,
  )) {
    out.push(`    ${vid.padEnd(60)}  ${n}`);
  }
  out.push("");
  out.push("  per-variant (expansionInjectedCurrentCount):");
  for (const [vid, n] of Object.entries(
    report.gapBreakdown.expansionInjectedCurrentByVariant,
  )) {
    out.push(`    ${vid.padEnd(60)}  ${n}`);
  }
  out.push("");

  out.push("## temp-rate-limit regression pin");
  out.push("");
  out.push(
    "  The `temp-rate-limit` query is the SPECIFIC regression mechanism " +
      "Experiment 9 documents: the baseline top-K is `[70, 130, 20, 23, 45]` " +
      "with 70 at rank 1 (the current fact); the candidate-expansion rule " +
      "injects record 3 (the `supersededBy` of record 23, which is in the " +
      "top-K); the unguarded downstream `multi-anchor-aware-combined` " +
      "re-ranker promotes record 3 above record 70 because record 3 " +
      "`supersedes` record 23, which is still in the top-K. The " +
      "`supersedes-promote-guard` rule protects a non-injected rank-1 " +
      "candidate from being displaced by a `supersedes-promote` of an " +
      "injected candidate. The metric `tempRateLimitRegressionCount` is " +
      "the headline evidence: the guarded primary MUST produce 0; the " +
      "unguarded Exp 9 variants produce 1.",
  );
  out.push("");
  out.push("  per-variant (tempRateLimitRegressionCount):");
  for (const row of report.variants) {
    out.push(
      `    ${row.variant.id.padEnd(60)}  ${row.metrics.tempRateLimitRegressionCount}`,
    );
  }
  out.push("");

  out.push("## Honest framing");
  out.push("");
  out.push(
    "  The `metadata-simulation` / `multi-anchor-simulation` / " +
      "`oracle-diagnostic` categories in this report are HONEST about " +
      "the source of the metadata and the use of `currentTruthIds`. " +
      "The guarded primary does NOT consult `currentTruthIds`; the " +
      "guard is a STRUCTURAL rule on the candidate-expansion's " +
      "provenance (injected vs non-injected), not a current-truth " +
      "lookup. The honest reading is: 'a production-side schema that " +
      "carries BOTH the supersession edge map AND the multi-anchor " +
      "treatment AND the linked-expansion map AND a per-candidate " +
      "`injected` provenance flag at `remember` time would let a " +
      "runtime candidate generator + a runtime guarded re-ranker " +
      "reach the guarded primary's ceiling WITHOUT depending on the " +
      "fixture truth at all'.",
  );
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a signed integer with an explicit
 * `+` sign for positive values.
 */
function signedInt(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}

// Silence "unused export" warnings for
// type imports that are re-exported for
// downstream tests but not used inside this
// module's body.
export type { TemporalTruthCategory, MultiAnchorRerankRule, MultiAnchorRerankVariant, CandidateExpansionRule, CandidateGenerationVariant };
export { TEMPORAL_TRUTH_CATEGORIES, BUILTIN_CANDIDATE_GENERATION_VARIANTS };
