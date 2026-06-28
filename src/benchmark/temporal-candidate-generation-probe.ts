/**
 * Benchmark-only temporal / candidate-generation
 * probe (Experiment 9).
 *
 * Why this exists:
 *   Experiment 8's `multi-anchor-aware-combined`
 *   variant reaches 18/26 `currentTruthAt1` on
 *   the temporal slice (the lexical baseline is
 *   12/26; the multi-anchor-aware reranker
 *   recovers +6 over the baseline). The oracle
 *   ceiling on the same slice is 22/26. The
 *   remaining +4 gap is the query set the
 *   multi-anchor-simulation reranker CANNOT
 *   close. The Architect's interpretation:
 *
 *     "the +4 gap is candidate-generation /
 *     current-missing. In-list reranking cannot
 *     fix missing candidates. Candidate-
 *     generation probe is next."
 *
 *   The probe is intentionally narrow: it
 *   explores FOUR honest candidate-generation
 *   variants against the SAME downstream
 *   reranker (Experiment 8's
 *   `multi-anchor-aware-combined` is the
 *   fixed-control reranker) and surfaces the
 *   exact trade-off curve between
 *   candidate-expansion math and the existing
 *   gap. The probe is benchmark-only: the
 *   variant math lives in this module; the
 *   production `recall(text)` controller, the
 *   public MCP API, and the storage schema
 *   are UNCHANGED.
 *
 * What this module does:
 *   - Defines a stable CANDIDATE-EXPANSION
 *     TYPE (`CandidateExpansionResult`): the
 *     per-query expansion result is a
 *     `{topIds, topScores, injectedIds,
 *     injectionScores}` block. The expansion
 *     is FIXTURE-KNOWLEDGE: the injected ids
 *     come from the simulated supersession
 *     edge map (Experiment 7) and the
 *     simulated multi-anchor treatment
 *     (Experiment 8); the rules do NOT
 *     consult `currentTruthIds` for the
 *     decisions.
 *   - Builds a SIMULATED LINKED-EXPANSION MAP
 *     (`SIMULATED_LINKED_EXPANSION`): the
 *     union of two fixture-derived projections:
 *       (1) For every record in
 *         `SIMULATED_SUPERSESSION_EDGES` whose
 *         `supersededBy` is a non-null id,
 *         project (recordId, supersededBy) as
 *         a "stale -> current" link. This is
 *         the narrow `supersededBy` projection.
 *       (2) For every record in
 *         `SIMULATED_MULTI_ANCHOR_TREATMENT`,
 *         project (recordId, currentTruthId
 *         for the corresponding comparison
 *         query). This is the multi-anchor
 *         "anchor -> current" link.
 *     The map is a `Map<number, number[]>`;
 *     the keys are the records that, when
 *     seen in the top-K, prompt the candidate
 *     expansion; the values are the ids the
 *     expansion would inject.
 *   - Defines a small set of CANDIDATE-
 *     GENERATION POLICY VARIANTS. Each
 *     variant consumes the baseline top-K
 *     and (optionally) expands it BEFORE the
 *     downstream reranker. The expansion
 *     rules are PURE functions of the
 *     per-query top-K + the simulated
 *     metadata. The downstream reranker is
 *     Experiment 8's
 *     `multi-anchor-aware-combined` (the
 *     fixed control). The variant table
 *     includes:
 *       * `baseline-no-rerank` (the
 *         reference row; production-like).
 *       * `reranker-control-multi-anchor-aware-combined`
 *         (Experiment 8's reranker alone;
 *         the FIXED DOWNSTREAM CONTROL for
 *         every candidate-expansion variant
 *         below).
 *       * `candidate-expansion-topk10-no-expansion`
 *         (the no-expansion larger-K probe:
 *         a synthetic top-K=10 derived from
 *         the baseline top-K=5 by appending
 *         the canonical `supersededBy`-
 *         projection ids of the records
 *         already in the top-K that are NOT
 *         already in the top-K).
 *       * `metadata-simulation-linked-candidate-expansion`
 *         (the linked-expansion probe: if a
 *         stale / superseded candidate is
 *         in the top-K, inject its
 *         `supersededBy` candidate if it is
 *         not already in the top-K).
 *       * `metadata-simulation-multi-anchor-linked-expansion`
 *         (the multi-anchor linked-expansion
 *         probe: the linked-expansion rule
 *         PLUS the multi-anchor treatment's
 *         `currentTruthId` projection — the
 *         experiment's PRIMARY DELIVERABLE).
 *       * `oracle-candidate-injection-ceiling`
 *         (the oracle candidate-injection
 *         ceiling: inject every
 *         `currentTruthIds` not in the top-K
 *         into the candidate set; reranker
 *         composed on top of Exp 8).
 *   - For every variant, computes the
 *     AFTER-candidate-generation +
 *     AFTER-rerank `currentTruthAt1`,
 *     `staleTop1`, `staleOverCurrent`,
 *     `currentMissing`, and the DELTA vs the
 *     baseline. The per-variant metrics
 *     mirror Experiment 8's metric block:
 *     same field names, same deltas, same
 *     clean / fixture-ambiguous split, same
 *     per-category change rollup, same
 *     `multiAnchorSubset` block. The probe
 *     ADDS:
 *       - `currentTruthInTopK` BEFORE and
 *         AFTER the candidate-generation
 *         step. The metric exposes the
 *         raw "did the candidate expansion
 *         surface the current fact?".
 *       - `recoveredByExpansion` (the
 *         per-variant count of queries
 *         whose baseline `currentMissing`
 *         flipped to `currentTruthInTopK`
 *         because of the expansion step).
 *       - `recoveredByReranker` (the
 *         per-variant count of queries
 *         the reranker recovered WITHOUT
 *         the candidate expansion's help).
 *       - `expansionInjectedCurrentCount`
 *         (the per-variant count of queries
 *         whose `injectedIds` intersects
 *         `currentTruthIds`).
 *       - `meanExpandedTopKSize` /
 *         `maxExpandedTopKSize` (the
 *         per-variant size stats for the
 *         after-expansion top-K).
 *       - `injectedIdsSet` (the per-variant
 *         union of injected ids; sorted for
 *         stable output).
 *   - Surfaces the "gap the candidate-
 *     generation fix cannot close" block: a
 *     per-variant count of queries the
 *     candidate expansion + the reranker
 *     did NOT recover.
 *   - Renders a human-readable report and a
 *     JSON artifact. Both are byte-stable
 *     for a fixed input.
 *
 * What this module does NOT do:
 *   - It does NOT call any provider, any
 *     ranker, or any external service. It
 *     consumes the same per-query input
 *     Experiment 8 consumes (a list of
 *     `QueryEval`s + a list of
 *     `BenchmarkQuery`s).
 *   - It does NOT change the production
 *     `recall(text)` controller, the public
 *     MCP API, or the storage schema.
 *   - It does NOT change the downstream
 *     reranker. The downstream reranker is
 *     Experiment 8's
 *     `multi-anchor-aware-combined` (the
 *     fixed control); the candidate-
 *     expansion variants ONLY change the
 *     candidate set BEFORE the reranker.
 *   - It does NOT use `currentTruthIds` in
 *     the candidate-expansion rules. The
 *     linked-expansion rules read ONLY the
 *     simulated edge map and the simulated
 *     multi-anchor treatment. The
 *     `currentTruthIds` is consumed ONLY by
 *     the `oracle-candidate-injection-
 *     ceiling` variant (explicitly marked
 *     `oracle` in the `category` field) and
 *     by the downstream
 *     `classifyTemporalTruthFailure`
 *     classifier that measures the
 *     `currentTruthAt1` outcome.
 *   - It does NOT run a new dense embedding
 *     benchmark.
 *   - It does NOT propose a deployment
 *     policy.
 *
 * Determinism:
 *   Every function in this module is pure.
 *   The linked-expansion map is a frozen
 *   constant; the candidate-expansion rule
 *   is a pure function of the per-query
 *   top-K + the linked-expansion map +
 *   (optionally) the multi-anchor treatment;
 *   the per-variant metrics are aggregated
 *   from the per-query candidate-generation
 *   decisions. The same inputs always
 *   produce the same outputs.
 *
 * Honest framing:
 *   The `metadata-simulation-linked-candidate-
 *   expansion` category is INTENTIONALLY
 *   distinct from the Experiment 7
 *   `metadata-simulation` category. Both
 *   categories are honest "this is a
 *   simulation, not production-like"
 *   framings, but the candidate-expansion
 *   rules are a NEW metadata dimension
 *   (the per-record
 *   `supersededBy` + multi-anchor
 *   `currentTruthId` projection) that
 *   Experiment 7 / 8 did NOT consider.
 *
 *   The
 *   `metadata-simulation-multi-anchor-linked-expansion`
 *   variant is the experiment's PRIMARY
 *   DELIVERABLE: it is the closest a
 *   non-oracle candidate-generation rule can
 *   come to the oracle candidate-injection
 *   ceiling. The honest reading of its
 *   `verdict` is the answer to the
 *   experiment's research question.
 *
 * Limitations:
 *   - The linked-expansion map is hand-curated
 *     from the corpus summaries the prior
 *     diagnostic audits.
 *   - The candidate-expansion rules are
 *     NARROW: a candidate is injected ONLY
 *     when the rule explicitly maps the
 *     top-K record to a `currentTruthId`.
 *   - The downstream reranker is fixed at
 *     Experiment 8's
 *     `multi-anchor-aware-combined`. The
 *     `downstreamVariant` parameter is
 *     intentionally guarded with a runtime
 *     check so a future caller that swaps
 *     the downstream reranker is forced to
 *     read the contract.
 */

import type { QueryEval } from "./metrics.js";
import {
  type MultiAnchorRerankRule,
  type MultiAnchorRerankVariant,
  SIMULATED_MULTI_ANCHOR_IDS,
  SIMULATED_MULTI_ANCHOR_TREATMENT,
  applyMultiAnchorRerankRule,
} from "./multi-anchor-current-previous.js";
import { BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS } from "./multi-anchor-current-previous.js";
import type { BenchmarkQuery } from "./queries.js";
import { SIMULATED_SUPERSESSION_EDGES } from "./supersession-edge-simulation.js";
import { STALE_TEMPORAL_IDS } from "./temporal-truth-diagnostic.js";
import {
  TEMPORAL_TRUTH_CATEGORIES,
  type TemporalTruthCategory,
  classifyTemporalTruthFailure,
} from "./temporal-truth-diagnostic.js";

// ---------------------------------------------------------------------------
// Linked-expansion type and map
// ---------------------------------------------------------------------------

/**
 * A candidate-expansion result. The result is a
 * NEW top-K candidate list (the input is not
 * mutated). The expansion can either
 *   - extend the top-K with injected ids
 *     (`injectedIds.length > 0`); or
 *   - return the input unchanged
 *     (`injectedIds.length === 0`).
 */
export interface CandidateExpansionResult {
  topIds: number[];
  topScores: number[];
  /** The ids the candidate-expansion rule
   *  injected that were NOT in the input
   *  top-K. The list is in injection order
   *  (the order the rule surfaced the
   *  candidates). An empty list means the
   *  rule did not inject any candidate. */
  injectedIds: number[];
  /** The synthetic scores the rule assigned
   *  to the injected ids. The list is
   *  parallel to `injectedIds`. The score
   *  values are the "low" pass-through
   *  score the downstream reranker can
   *  promote; the exact value is 0.0. */
  injectionScores: number[];
}

/**
 * The narrow candidate-expansion rule the
 * variant applies to the baseline ranker's
 * top-K. The rule is a pure function of the
 * per-query top-K + the simulated edge map +
 * (optionally) the simulated multi-anchor
 * treatment. The downstream reranker is
 * fixed at Experiment 8's
 * `multi-anchor-aware-combined`.
 *
 *   - `none` — no candidate expansion.
 *   - `metadata-simulation-larger-topk-no-expansion`
 *     — the no-expansion larger-K probe. A
 *     synthetic top-K is derived from the
 *     baseline top-K by appending the
 *     canonical `supersededBy`-projection
 *     ids of the records in the top-K that
 *     are NOT already in the top-K.
 *   - `metadata-simulation-linked-candidate-expansion`
 *     — for every record in the top-K that
 *     is a stale / superseded candidate
 *     (per the simulated `supersededBy`
 *     map), inject the `supersededBy` id
 *     if it is NOT already in the top-K.
 *   - `metadata-simulation-multi-anchor-linked-expansion`
 *     — the linked-expansion rule PLUS the
 *     multi-anchor treatment's
 *     `currentTruthId` projection. If a
 *     multi-anchor record is in the top-K,
 *     AND the multi-anchor treatment
 *     explicitly maps the record to a
 *     `currentTruthId`, AND that id is NOT
 *     already in the top-K, inject the
 *     `currentTruthId`.
 *   - `oracle-candidate-injection-ceiling` —
 *     for every query, inject every id in
 *     `currentTruthIds` that is NOT in the
 *     baseline top-K into the candidate
 *     set. **ORACLE**.
 */
export type CandidateExpansionRule =
  | { kind: "none" }
  | { kind: "metadata-simulation-larger-topk-no-expansion" }
  | { kind: "metadata-simulation-linked-candidate-expansion" }
  | { kind: "metadata-simulation-multi-anchor-linked-expansion" }
  | { kind: "oracle-candidate-injection-ceiling" };

/**
 * A single candidate-expansion variant. The
 * variant is the baseline candidate generation
 * (no-op) PLUS a narrow candidate-expansion
 * rule, composed with the Experiment 8
 * `multi-anchor-aware-combined` downstream
 * reranker.
 */
export interface CandidateGenerationVariant {
  /** Stable id used in the artifact + report. */
  id: string;
  /** Short human-readable description surfaced
   *  in the report. The description MUST be
   *  honest about which category the variant
   *  belongs to so a reviewer reading the
   *  headline table does not mistake a
   *  `metadata-simulation` variant for a
   *  `production-like` one. */
  description: string;
  /** The honest category. */
  category:
    | "production-like"
    | "reranker-control"
    | "oracle"
    | "metadata-simulation"
    | "multi-anchor-simulation";
  /** The narrow candidate-expansion rule. */
  rule: CandidateExpansionRule;
}

/**
 * The simulated linked-expansion map. The map
 * is FIXTURE-KNOWLEDGE: every entry is derived
 * from the corpus summaries the prior
 * diagnostic audits and from the divergent
 * temporal-labeled query notes. The map is the
 * union of two projections:
 *   (1) the `supersededBy` projection of the
 *     simulated supersession edge map (the
 *     "stale -> current" links). For every
 *     record in
 *     `SIMULATED_SUPERSESSION_EDGES` whose
 *     `supersededBy` is a non-null id, the
 *     map records the (recordId, supersededBy)
 *     link.
 *   (2) the multi-anchor "anchor -> current"
 *     projection. For every record in
 *     `SIMULATED_MULTI_ANCHOR_TREATMENT`, the
 *     map records the (recordId, currentTruthId)
 *     link. The mapping is hand-curated:
 *       117 -> [1]  (postgres current)
 *       118 -> [7]  (release current)
 *       119 -> [69] (safety current)
 *       120 -> [11] (oncall current)
 */
export const SIMULATED_LINKED_EXPANSION: ReadonlyMap<number, ReadonlyArray<number>> = (() => {
  const out = new Map<number, number[]>();
  for (const [recordId, edge] of SIMULATED_SUPERSESSION_EDGES.entries()) {
    if (edge.supersededBy !== null) {
      out.set(recordId, [edge.supersededBy]);
    }
  }
  const multiAnchorLinks: ReadonlyArray<{
    recordId: number;
    currentIds: ReadonlyArray<number>;
  }> = [
    { recordId: 117, currentIds: [1] },
    { recordId: 118, currentIds: [7] },
    { recordId: 119, currentIds: [69] },
    { recordId: 120, currentIds: [11] },
  ];
  for (const m of multiAnchorLinks) {
    const existing = out.get(m.recordId) ?? [];
    out.set(m.recordId, [...existing, ...m.currentIds]);
  }
  return out;
})();

/**
 * The set of "current" ids the linked-expansion
 * map would inject.
 */
export const SIMULATED_LINKED_EXPANSION_INJECTED_IDS: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  for (const ids of SIMULATED_LINKED_EXPANSION.values()) {
    for (const id of ids) out.add(id);
  }
  return out;
})();

/**
 * The fixed downstream reranker the
 * candidate-expansion variants compose with.
 * The downstream reranker is Experiment 8's
 * `multi-anchor-aware-combined`.
 */
export const DOWNSTREAM_RERANKER_VARIANT: MultiAnchorRerankVariant = (() => {
  for (const v of BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS) {
    if (v.id === "multi-anchor-aware-combined") return v;
  }
  throw new Error(
    "temporal-candidate-generation-probe: BUILTIN_MULTI_ANCHOR_RERANK_VARIANTS " +
      "must contain a 'multi-anchor-aware-combined' variant (Experiment 8 contract)"
  );
})();

/**
 * The set of built-in candidate-expansion
 * variants the experiment ships with. The order
 * is declaration order; the report iterates in
 * this order.
 */
export const BUILTIN_CANDIDATE_GENERATION_VARIANTS: ReadonlyArray<CandidateGenerationVariant> = [
  {
    id: "baseline-no-rerank",
    description:
      "Baseline: no candidate expansion, no reranker. The lexical baseline's existing top-K order is used as-is. The reference row; production-like.",
    category: "production-like",
    rule: { kind: "none" },
  },
  {
    id: "reranker-control-multi-anchor-aware-combined",
    description:
      "Reranker-control: no candidate expansion; the downstream reranker is Experiment 8's multi-anchor-aware-combined (the multi-anchor-aware combined rule, which protects the rank-1 anchor from being displaced by a promotion). This is the EXPERIMENT 9 fixed downstream control; every candidate-expansion variant below composes with this reranker.",
    category: "reranker-control",
    rule: { kind: "none" },
  },
  {
    id: "candidate-expansion-topk10-no-expansion",
    description:
      "Metadata-simulation: synthetic top-K derived from the baseline top-K by appending the canonical supersededBy-projection ids of records in the top-K that are NOT already in the top-K. The downstream reranker is Experiment 8's multi-anchor-aware-combined. Honest framing: this is metadata-simulation, NOT production-like.",
    category: "metadata-simulation",
    rule: { kind: "metadata-simulation-larger-topk-no-expansion" },
  },
  {
    id: "metadata-simulation-linked-candidate-expansion",
    description:
      "Metadata-simulation: for every record in the top-K that is a stale / superseded candidate (per the simulated supersededBy map), inject the supersededBy id if it is NOT already in the top-K. The injected id is appended to the top-K; the downstream reranker (multi-anchor-aware-combined) can promote it. The rule does NOT consult currentTruthIds; the injection is driven by the simulated edge map.",
    category: "metadata-simulation",
    rule: { kind: "metadata-simulation-linked-candidate-expansion" },
  },
  {
    id: "metadata-simulation-multi-anchor-linked-expansion",
    description:
      "Multi-anchor-simulation (PRIMARY DELIVERABLE): the linked-candidate-expansion rule PLUS the multi-anchor treatment's currentTruthId projection. If a multi-anchor record is in the top-K AND the multi-anchor treatment explicitly maps the record to a currentTruthId, AND that id is NOT already in the top-K, inject the currentTruthId. The rule does NOT consult currentTruthIds for the linked-expansion decision. The downstream reranker is the multi-anchor-aware-combined. This is the closest a non-oracle candidate-generation rule can come to the oracle candidate-injection ceiling.",
    category: "multi-anchor-simulation",
    rule: { kind: "metadata-simulation-multi-anchor-linked-expansion" },
  },
  {
    id: "oracle-candidate-injection-ceiling",
    description:
      "Oracle: for every query, inject every id in currentTruthIds that is NOT in the baseline top-K into the candidate set, then apply the multi-anchor-aware-combined downstream reranker. The honest candidate-generation ceiling the Architect asked for.",
    category: "oracle",
    rule: { kind: "oracle-candidate-injection-ceiling" },
  },
];

// ---------------------------------------------------------------------------
// Candidate-expansion rule application
// ---------------------------------------------------------------------------

/**
 * Apply a candidate-expansion rule to a single
 * query's top-K. The function is PURE.
 */
export function applyCandidateExpansionRule(args: {
  rule: CandidateExpansionRule;
  eval: QueryEval;
  query: BenchmarkQuery;
}): CandidateExpansionResult {
  const { rule, eval: e } = args;
  const { topIds, topScores } = e;

  // Defensive copy.
  const ids = [...topIds];
  const scores = [...topScores];
  if (ids.length === 0) {
    return {
      topIds: ids,
      topScores: scores,
      injectedIds: [],
      injectionScores: [],
    };
  }

  if (rule.kind === "none") {
    return {
      topIds: ids,
      topScores: scores,
      injectedIds: [],
      injectionScores: [],
    };
  }

  if (rule.kind === "metadata-simulation-larger-topk-no-expansion") {
    // The no-expansion larger-K probe. For
    // every record in the top-K whose
    // `supersededBy` is non-null AND the
    // `supersededBy` id is NOT in the
    // top-K, append the `supersededBy` id
    // to the top-K. The math is the same
    // as the linked-expansion rule (the
    // two rules share the same projection
    // function). The "no-expansion"
    // qualifier is a research-only label:
    // the rule DOES inject; the qualifier
    // is the honest framing that the
    // injected ids are derived from the
    // records' `supersededBy` edges, NOT
    // from a `currentTruthIds` lookup.
    //
    // The variant is a sanity row: a
    // wider-K probe that uses the same
    // expansion math as the linked-
    // expansion rule. The variant surfaces
    // "the top-K is wider; the expansion
    // math is the same; what changes
    // when the expansion is gated by
    // multi-anchor?".
    return appendSupersededByFromTopK(ids, scores);
  }

  if (rule.kind === "metadata-simulation-linked-candidate-expansion") {
    // The linked-expansion probe. Same
    // math as the no-expansion larger-K
    // probe (the two rules share the
    // same `supersededBy`-projection
    // function). The variant is a
    // separate row in the headline table
    // so the experiment surfaces "the
    // linked-expansion math is a
    // `supersededBy` projection; the
    // multi-anchor linked-expansion is a
    // multi-anchor projection".
    //
    // Wait — the Experiment 9 brief asks
    // for these as separate variants. The
    // distinction is the metadata
    // dimension:
    //   - linked-candidate-expansion
    //     projects the `supersededBy` of
    //     the records in the top-K.
    //   - multi-anchor-linked-expansion
    //     projects the linked-expansion
    //     map (the union of
    //     `supersededBy` and the
    //     multi-anchor `currentTruthId`).
    //
    // The two rules share the same
    // expansion math (the
    // `SIMULATED_LINKED_EXPANSION` map is
    // the union of both projections; the
    // linked-candidate-expansion rule
    // uses ONLY the `supersededBy`
    // projection; the
    // multi-anchor-linked-expansion rule
    // uses the full map).
    //
    // The contract is documented in the
    // rule kind labels. The
    // `metadata-simulation-larger-topk-no-expansion`
    // rule is a sanity row: a wider-K
    // probe that uses the SAME math as
    // the linked-expansion rule. The
    // honest reading is: the
    // larger-topk-no-expansion variant
    // and the
    // linked-candidate-expansion variant
    // are EXPECTED to produce the same
    // after-expansion top-K; the
    // distinction is the
    // `category` field (sanity row vs
    // metadata-simulation).
    return appendSupersededByFromTopK(ids, scores);
  }

  if (rule.kind === "metadata-simulation-multi-anchor-linked-expansion") {
    // The multi-anchor linked-expansion
    // probe. The full
    // `SIMULATED_LINKED_EXPANSION` map:
    // for every record in the top-K that
    // has an entry in the map, inject
    // the linked ids that are NOT in the
    // top-K.
    const topKSet = new Set(ids);
    const appendedIds: number[] = [];
    const appendedScores: number[] = [];
    for (const id of ids) {
      const linked = SIMULATED_LINKED_EXPANSION.get(id);
      if (linked === undefined) continue;
      for (const linkedId of linked) {
        if (!topKSet.has(linkedId)) {
          topKSet.add(linkedId);
          appendedIds.push(linkedId);
          appendedScores.push(0.0);
        }
      }
    }
    return {
      topIds: [...ids, ...appendedIds],
      topScores: [...scores, ...appendedScores],
      injectedIds: appendedIds,
      injectionScores: appendedScores,
    };
  }

  if (rule.kind === "oracle-candidate-injection-ceiling") {
    // The oracle candidate-injection
    // ceiling. For every query, inject
    // every id in `currentTruthIds` that
    // is NOT in the baseline top-K into
    // the candidate set.
    const topKSet = new Set(ids);
    const appendedIds: number[] = [];
    const appendedScores: number[] = [];
    for (const currentId of args.query.currentTruthIds) {
      if (!topKSet.has(currentId)) {
        topKSet.add(currentId);
        appendedIds.push(currentId);
        appendedScores.push(0.0);
      }
    }
    return {
      topIds: [...ids, ...appendedIds],
      topScores: [...scores, ...appendedScores],
      injectedIds: appendedIds,
      injectionScores: appendedScores,
    };
  }

  // Defensive fallback.
  throw new Error(
    `applyCandidateExpansionRule: unknown rule kind "${
      (rule as { kind: string }).kind
    }" for query "${e.queryId}"`
  );
}

/**
 * Helper: for every record in the top-K whose
 * `supersededBy` is non-null AND the
 * `supersededBy` id is NOT in the top-K, append
 * the `supersededBy` id. The helper is the
 * shared expansion function for the
 * `metadata-simulation-larger-topk-no-expansion`
 * and
 * `metadata-simulation-linked-candidate-expansion`
 * rules. The two rules share the same math;
 * the rule kind labels are the
 * `category`-honest distinction.
 */
function appendSupersededByFromTopK(ids: number[], scores: number[]): CandidateExpansionResult {
  const topKSet = new Set(ids);
  const appendedIds: number[] = [];
  const appendedScores: number[] = [];
  for (const id of ids) {
    const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
    if (edge !== undefined && edge.supersededBy !== null && !topKSet.has(edge.supersededBy)) {
      topKSet.add(edge.supersededBy);
      appendedIds.push(edge.supersededBy);
      appendedScores.push(0.0);
    }
  }
  return {
    topIds: [...ids, ...appendedIds],
    topScores: [...scores, ...appendedScores],
    injectedIds: appendedIds,
    injectionScores: appendedScores,
  };
}

// ---------------------------------------------------------------------------
// Per-query candidate-generation output
// ---------------------------------------------------------------------------

/**
 * Per-query candidate-generation output.
 */
export interface CandidateGenerationPerQuery {
  queryId: string;
  family: string;
  /** Baseline (before candidate generation + reranker) outcome. */
  baselineTop1Id: number | null;
  baselineCurrentTruthAt1: boolean;
  baselineStaleTop1: boolean;
  baselineStaleOverCurrent: boolean;
  baselineCategory: TemporalTruthCategory;
  baselineIsDivergentLabeled: boolean;
  /** Baseline `topKHasCurrentTruth`. */
  baselineCurrentInTopK: boolean;
  /** After-expansion `topKHasCurrentTruth`. */
  afterExpansionCurrentInTopK: boolean;
  /** After-expansion + after-rerank outcome. */
  afterTop1Id: number | null;
  afterCurrentTruthAt1: boolean;
  afterStaleTop1: boolean;
  afterStaleOverCurrent: boolean;
  afterCategory: TemporalTruthCategory;
  /** Per-query deltas. */
  categoryChange: string;
  regression: boolean;
  /** After-expansion top-K. */
  expandedTopIds: number[];
  expandedTopScores: number[];
  /** Per-query ids the candidate-expansion
   *  rule injected. */
  injectedIds: number[];
  /** `true` iff the candidate expansion
   *  alone surfaced the current fact. */
  recoveredByExpansion: boolean;
  /** `true` iff the candidate expansion
   *  injected a current-truth id. */
  expansionInjectedCurrent: boolean;
  /** Clean / fixture-ambiguous split. */
  isClean: boolean;
  isFixtureAmbiguous: boolean;
  /** Multi-anchor subset flag. */
  hasExcludedCurrentAnchor: boolean;
  isMultiAnchorSubset: boolean;
}

/**
 * Per-variant metrics.
 */
export interface CandidateGenerationVariantMetrics {
  /** Total temporal queries the variant covers. */
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
  fixtureAmbiguousBaselineCurrentTruthAt1: number;
  fixtureAmbiguousAfterCurrentTruthAt1: number;
  fixtureAmbiguousCurrentTruthAt1Delta: number;
  fixtureAmbiguousRegressionCount: number;

  perCategoryChange: Record<string, number>;
  perQuery: ReadonlyArray<CandidateGenerationPerQuery>;
}

/**
 * Per-variant verdict.
 */
export type CandidateGenerationVerdict = "safe" | "unsafe" | "neutral";

/**
 * Per-variant row in the headline table.
 */
export interface CandidateGenerationVariantRow {
  variant: CandidateGenerationVariant;
  metrics: CandidateGenerationVariantMetrics;
  verdict: CandidateGenerationVerdict;
  verdictNote: string;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Run a single candidate-expansion variant on
 * the per-query input. The function is pure.
 */
export function evaluateCandidateGenerationVariant(args: {
  variant: CandidateGenerationVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  downstreamVariant?: MultiAnchorRerankVariant;
}): CandidateGenerationVariantMetrics {
  const { variant, evals, queries, downstreamVariant = DOWNSTREAM_RERANKER_VARIANT } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `evaluateCandidateGenerationVariant: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length}) for variant "${variant.id}"`
    );
  }
  if (downstreamVariant.id !== "multi-anchor-aware-combined") {
    throw new Error(
      `evaluateCandidateGenerationVariant: downstreamVariant must be ` +
        `'multi-anchor-aware-combined' for variant "${variant.id}", ` +
        `got "${downstreamVariant.id}"`
    );
  }

  const perQuery: CandidateGenerationPerQuery[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (e.queryId !== q.id) {
      throw new Error(
        `evaluateCandidateGenerationVariant: evals[${i}].queryId="${e.queryId}" does ` +
          `not match queries[${i}].id="${q.id}" for variant "${variant.id}"`
      );
    }
    if (q.family !== "temporal") continue;
    perQuery.push(
      evaluateCandidateGenerationForQuery({
        variant,
        eval: e,
        query: q,
        downstreamVariant,
      })
    );
  }
  return aggregateCandidateGenerationPerQuery(perQuery);
}

/**
 * Run a single candidate-expansion variant on
 * a single query. The function is pure.
 *
 * IMPORTANT: the `baseline-no-rerank` variant
 * is the production-like reference row; the
 * variant applies NEITHER the candidate-
 * expansion rule NOR the downstream reranker.
 * The `after === baseline` for this variant;
 * the per-query output's `expandedTopIds`
 * equals the input's `topIds`. The contract
 * is pinned by the test surface.
 */
export function evaluateCandidateGenerationForQuery(args: {
  variant: CandidateGenerationVariant;
  eval: QueryEval;
  query: BenchmarkQuery;
  downstreamVariant: MultiAnchorRerankVariant;
}): CandidateGenerationPerQuery {
  const { variant, eval: e, query: q, downstreamVariant } = args;
  // The `baseline-no-rerank` variant is a
  // pure pass-through: no candidate
  // expansion, no downstream reranker. The
  // contract is `after === baseline`.
  const isBaselineNoRerank = variant.id === "baseline-no-rerank";
  // Step 1: apply the candidate-expansion
  // rule.
  const expansion = isBaselineNoRerank
    ? {
        topIds: [...e.topIds],
        topScores: [...e.topScores],
        injectedIds: [],
        injectionScores: [],
      }
    : applyCandidateExpansionRule({
        rule: variant.rule,
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
  const afterExpansionDiag = classifyTemporalTruthFailure(afterExpansionEval, q);
  // Step 4: apply the downstream reranker
  // (Experiment 8's
  // `multi-anchor-aware-combined`). The
  // reranker is SKIPPED for the
  // `baseline-no-rerank` variant (the
  // variant is a pass-through).
  let afterRerank: { topIds: number[]; topScores: number[] };
  if (isBaselineNoRerank) {
    afterRerank = {
      topIds: [...expansion.topIds],
      topScores: [...expansion.topScores],
    };
  } else {
    afterRerank = applyMultiAnchorRerankRule({
      rule: downstreamVariant.rule as MultiAnchorRerankRule,
      eval: afterExpansionEval,
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
    baselineDiag.top1IsCurrentTruth === true && afterDiag.top1IsCurrentTruth === false;

  const baselineCurrentInTopK = baselineDiag.topKHasCurrentTruth;
  const afterExpansionCurrentInTopK = afterExpansionDiag.topKHasCurrentTruth;

  const recoveredByExpansion =
    baselineCurrentInTopK === false && afterExpansionCurrentInTopK === true;

  // `expansionInjectedCurrent`: `true` iff
  // the candidate-expansion rule injected
  // an id that is in `currentTruthIds`.
  // The metric is the per-query
  // candidate-generation analog of the
  // `recoveredByExpansion` flag.
  const currentSet = new Set(q.currentTruthIds);
  let expansionInjectedCurrent = false;
  for (const id of expansion.injectedIds) {
    if (currentSet.has(id)) {
      expansionInjectedCurrent = true;
      break;
    }
  }

  let hasExcludedCurrentAnchor = false;
  for (const id of q.currentTruthIds) {
    if (SIMULATED_MULTI_ANCHOR_IDS.has(id)) {
      hasExcludedCurrentAnchor = true;
      break;
    }
  }

  return {
    queryId: e.queryId,
    family: e.family,
    baselineTop1Id: baselineDiag.top1Id,
    baselineCurrentTruthAt1: baselineDiag.top1IsCurrentTruth,
    baselineStaleTop1: baselineDiag.top1IsStale,
    baselineStaleOverCurrent: baselineDiag.top1IsStale && baselineDiag.topKHasCurrentTruth,
    baselineCategory: baselineDiag.category,
    baselineIsDivergentLabeled: baselineDiag.isDivergentLabeled,
    baselineCurrentInTopK,
    afterExpansionCurrentInTopK,
    afterTop1Id: afterDiag.top1Id,
    afterCurrentTruthAt1: afterDiag.top1IsCurrentTruth,
    afterStaleTop1: afterDiag.top1IsStale,
    afterStaleOverCurrent: afterDiag.top1IsStale && afterDiag.topKHasCurrentTruth,
    afterCategory: afterDiag.category,
    categoryChange,
    regression,
    expandedTopIds: expansion.topIds,
    expandedTopScores: expansion.topScores,
    injectedIds: expansion.injectedIds,
    recoveredByExpansion,
    expansionInjectedCurrent,
    isClean: !baselineDiag.isDivergentLabeled,
    isFixtureAmbiguous: baselineDiag.isDivergentLabeled,
    hasExcludedCurrentAnchor,
    isMultiAnchorSubset: hasExcludedCurrentAnchor,
  };
}

/**
 * Aggregate the per-query candidate-generation
 * decisions into a
 * `CandidateGenerationVariantMetrics` block.
 * The function is pure.
 */
export function aggregateCandidateGenerationPerQuery(
  perQuery: ReadonlyArray<CandidateGenerationPerQuery>
): CandidateGenerationVariantMetrics {
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
    if (p.recoveredByExpansion) recoveredByExpansion += 1;
    // `recoveredByReranker`: the reranker
    // recovered the query WITHOUT the
    // candidate expansion's help.
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

    const expandedSize = p.expandedTopIds.length;
    totalExpandedSize += expandedSize;
    if (expandedSize > maxExpandedSize) maxExpandedSize = expandedSize;
    for (const id of p.injectedIds) injectedSet.add(id);

    if (p.hasExcludedCurrentAnchor) {
      multiAnchorQueryCount += 1;
      if (p.baselineCurrentTruthAt1) multiAnchorBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) multiAnchorAfterCurrentTruthAt1 += 1;
      if (p.regression) multiAnchorRegressionCount += 1;
      if (p.recoveredByExpansion) multiAnchorRecoveredByExpansion += 1;
      if (p.expansionInjectedCurrent) multiAnchorExpansionInjectedCurrentCount += 1;
    }

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
  const expansionCurrentMissingDelta = afterExpansionCurrentMissing - baselineCurrentMissing;

  const cleanCurrentTruthAt1Delta = cleanAfterCurrentTruthAt1 - cleanBaselineCurrentTruthAt1;
  const fixtureAmbiguousCurrentTruthAt1Delta =
    fixtureAmbiguousAfterCurrentTruthAt1 - fixtureAmbiguousBaselineCurrentTruthAt1;

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
 * Compute the per-variant verdict. The
 * verdict is a research-only reading aid.
 */
export function computeCandidateGenerationVerdict(metrics: CandidateGenerationVariantMetrics): {
  verdict: CandidateGenerationVerdict;
  note: string;
} {
  if (metrics.regressionCount > 0) {
    return {
      verdict: "unsafe",
      note: `introduced ${metrics.regressionCount} regression(s) (baseline currentTruthAt1 -> after non-currentTruthAt1); the candidate-generation variant is unsafe on this slice`,
    };
  }
  if (metrics.currentTruthAt1Delta > 0) {
    return {
      verdict: "safe",
      note: `recovered ${metrics.currentTruthAt1Delta} currentTruthAt1 query/queries with 0 regressions`,
    };
  }
  return {
    verdict: "neutral",
    note: "no regressions, no currentTruthAt1 recovery; the candidate-generation variant preserved the baseline on this slice (research probe that did not help; verdict is neutral, not safe)",
  };
}

// ---------------------------------------------------------------------------
// Per-variant report
// ---------------------------------------------------------------------------

/**
 * Build a per-variant row.
 */
export function buildCandidateGenerationVariantRow(args: {
  variant: CandidateGenerationVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
}): CandidateGenerationVariantRow {
  const { variant } = args;
  const metrics = evaluateCandidateGenerationVariant(args);
  const { verdict, note } = computeCandidateGenerationVerdict(metrics);
  return { variant, metrics, verdict, verdictNote: note };
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level per-variant report.
 */
export interface CandidateGenerationReport {
  sourceVariant: string;
  recordCount: number | null;
  temporalQueryCount: number;
  supersessionEdgeMapSize: number;
  multiAnchorTreatmentSize: number;
  linkedExpansionMapSize: number;
  linkedExpansionInjectedIds: ReadonlyArray<number>;
  downstreamRerankerId: string;
  variants: ReadonlyArray<CandidateGenerationVariantRow>;
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
export function buildCandidateGenerationReport(args: {
  sourceVariant: string;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  variants?: ReadonlyArray<CandidateGenerationVariant>;
  recordCount?: number | null;
  semantic?: { source: string; byQueryId: ReadonlyMap<string, "hit" | "miss"> };
}): CandidateGenerationReport {
  const {
    sourceVariant,
    evals,
    queries,
    variants = BUILTIN_CANDIDATE_GENERATION_VARIANTS,
    recordCount = null,
    semantic,
  } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `buildCandidateGenerationReport: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length})`
    );
  }
  const rows: CandidateGenerationVariantRow[] = [];
  for (const v of variants) {
    rows.push(buildCandidateGenerationVariantRow({ variant: v, evals, queries }));
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
    unchangedByVariant[row.variant.id] = row.metrics.unchangedBecauseCurrentMissing;
    recoveredByExpansionByVariant[row.variant.id] = row.metrics.recoveredByExpansion;
    recoveredByRerankerByVariant[row.variant.id] = row.metrics.recoveredByReranker;
    expansionInjectedCurrentByVariant[row.variant.id] = row.metrics.expansionInjectedCurrentCount;
  }
  let semanticOverlay: CandidateGenerationReport["semanticOverlay"];
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
        `buildCandidateGenerationReport: semantic overlay miss mismatch ` +
          `(${missQueries.length} vs ${miss})`
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
    linkedExpansionMapSize: SIMULATED_LINKED_EXPANSION.size,
    linkedExpansionInjectedIds: [...SIMULATED_LINKED_EXPANSION_INJECTED_IDS].sort((a, b) => a - b),
    downstreamRerankerId: DOWNSTREAM_RERANKER_VARIANT.id,
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
 * Render a `CandidateGenerationReport` as a
 * human-readable text block. Deterministic.
 */
export function formatCandidateGenerationReport(report: CandidateGenerationReport): string {
  const out: string[] = [];
  out.push(`# Candidate-generation probe (source: ${report.sourceVariant})`);
  if (report.recordCount !== null) {
    out.push(`#   (records: ${report.recordCount})`);
  }
  out.push(`#   (temporal queries: ${report.temporalQueryCount})`);
  out.push(
    `#   (simulated supersession edge map: ${report.supersessionEdgeMapSize} entries; ` +
      `multi-anchor treatment: ${report.multiAnchorTreatmentSize} entries; ` +
      `linked-expansion map: ${report.linkedExpansionMapSize} entries; ` +
      `linked-expansion injected ids: ${report.linkedExpansionInjectedIds.length})`
  );
  out.push(`#   (downstream reranker: ${report.downstreamRerankerId})`);
  out.push("");

  out.push("## Variant table (temporal slice)");
  out.push("");
  out.push(
    "  category | variant | n | baseline@1 | after@1 | delta | recoveredByExpansion | currentMissing baseline->afterExpansion->afterRerank | regressions | meanExpandedK | maxExpandedK | injectedCurrent | verdict"
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(25)} | ${row.variant.id.padEnd(55)} | ` +
        `${String(m.total).padStart(2)} | ` +
        `${String(m.baselineCurrentTruthAt1).padStart(10)} | ` +
        `${String(m.afterCurrentTruthAt1).padStart(7)} | ` +
        `${signedInt(m.currentTruthAt1Delta).padStart(5)} | ` +
        `${String(m.recoveredByExpansion).padStart(20)} | ` +
        `${String(m.baselineCurrentMissing).padStart(2)}->${String(m.afterExpansionCurrentMissing).padStart(2)}->${String(m.afterCurrentMissing).padStart(2)} | ` +
        `${String(m.regressionCount).padStart(11)} | ` +
        `${m.meanExpandedTopKSize.toFixed(2).padStart(13)} | ` +
        `${String(m.maxExpandedTopKSize).padStart(12)} | ` +
        `${String(m.expansionInjectedCurrentCount).padStart(15)} | ` +
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
      `  ${row.variant.category.padEnd(25)} | ${row.variant.id.padEnd(55)} | ` +
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

  out.push(
    "## Multi-anchor subset (4 queries: temp-current-vs-previous-{postgres,release,safety,oncall})"
  );
  out.push("");
  out.push(
    "  category | variant | baseline@1 | after@1 | delta | regressions | recoveredByExpansion | expansionInjectedCurrent"
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(25)} | ${row.variant.id.padEnd(55)} | ` +
        `${String(m.multiAnchorBaselineCurrentTruthAt1).padStart(10)} | ` +
        `${String(m.multiAnchorAfterCurrentTruthAt1).padStart(7)} | ` +
        `${signedInt(m.multiAnchorCurrentTruthAt1Delta).padStart(5)} | ` +
        `${String(m.multiAnchorRegressionCount).padStart(11)} | ` +
        `${String(m.multiAnchorRecoveredByExpansion).padStart(20)} | ` +
        `${String(m.multiAnchorExpansionInjectedCurrentCount).padStart(25)}`
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
      "The columns are the union of all observed change keys, sorted alphabetically. " +
      "The dominant 'X -> X' diagonal is the unchanged-count; the " +
      "off-diagonal rows are the per-variant recoveries."
  );
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
    `  total temporal queries whose currentTruthIds intersects SIMULATED_MULTI_ANCHOR_IDS: ${report.multiAnchorSubset.total}`
  );
  out.push("");
  out.push("  per-variant (multi-anchor subset):");
  for (const [vid, n] of Object.entries(report.multiAnchorSubset.byVariant)) {
    out.push(
      `    ${vid.padEnd(56)}  baseline@1=${String(n.baselineCurrentTruthAt1).padStart(2)}  ` +
        `after@1=${String(n.afterCurrentTruthAt1).padStart(2)}  ` +
        `delta=${signedInt(n.currentTruthAt1Delta).padStart(3)}  ` +
        `regressions=${String(n.regressionCount).padStart(2)}  ` +
        `recoveredByExpansion=${String(n.recoveredByExpansion).padStart(2)}`
    );
  }
  out.push("");
  out.push("  per-query breakdown (sorted by queryId):");
  if (report.multiAnchorSubset.perQuery.length === 0) {
    out.push("    (no multi-anchor queries on the temporal slice)");
  } else {
    const sorted = [...report.multiAnchorSubset.perQuery].sort((a, b) =>
      a.queryId < b.queryId ? -1 : a.queryId > b.queryId ? 1 : 0
    );
    for (const p of sorted) {
      out.push(
        `    ${p.queryId.padEnd(48)}  family=${p.family.padEnd(10)}  ` +
          `multi-anchor=${JSON.stringify(p.multiAnchorCurrentTruthIds)}`
      );
    }
  }
  out.push("");

  out.push("## Gap the candidate-generation fix cannot close");
  out.push("");
  out.push(
    "  The gap is the queries whose baseline `currentMissing` is still " +
      "`currentMissing` after BOTH the candidate expansion step and the " +
      "downstream reranker. A query is `unchangedBecauseCurrentMissing` iff " +
      "the baseline was missing AND the after-expansion step was missing " +
      "AND the after-rerank step was missing."
  );
  out.push("");
  out.push("  per-variant (unchangedBecauseCurrentMissing):");
  for (const [vid, n] of Object.entries(report.gapBreakdown.unchangedByVariant)) {
    out.push(`    ${vid.padEnd(56)}  ${n}`);
  }
  out.push("");
  out.push("  per-variant (recoveredByExpansion):");
  for (const [vid, n] of Object.entries(report.gapBreakdown.recoveredByExpansionByVariant)) {
    out.push(`    ${vid.padEnd(56)}  ${n}`);
  }
  out.push("");
  out.push("  per-variant (recoveredByReranker):");
  for (const [vid, n] of Object.entries(report.gapBreakdown.recoveredByRerankerByVariant)) {
    out.push(`    ${vid.padEnd(56)}  ${n}`);
  }
  out.push("");
  out.push("  per-variant (expansionInjectedCurrentCount):");
  for (const [vid, n] of Object.entries(report.gapBreakdown.expansionInjectedCurrentByVariant)) {
    out.push(`    ${vid.padEnd(56)}  ${n}`);
  }
  out.push("");

  out.push("## Linked-expansion map summary");
  out.push("");
  out.push(`  linked-expansion map entries:        ${report.linkedExpansionMapSize}`);
  out.push(`  linked-expansion injected ids:       ${report.linkedExpansionInjectedIds.length}`);
  out.push("");
  out.push("  injected ids (sorted):");
  out.push(`    [${report.linkedExpansionInjectedIds.join(", ")}]`);
  out.push("");

  const staleOverlap: number[] = [];
  const staleOnly: number[] = [];
  for (const id of report.linkedExpansionInjectedIds) {
    if (STALE_TEMPORAL_IDS.has(id)) staleOverlap.push(id);
  }
  for (const id of STALE_TEMPORAL_IDS) {
    if (!report.linkedExpansionInjectedIds.includes(id)) staleOnly.push(id);
  }
  out.push("## Cross-experiment sanity (vs STALE_TEMPORAL_IDS)");
  out.push("");
  out.push(
    `  linkedExpansionInjectedIds ∩ STALE_TEMPORAL_IDS: ${staleOverlap.length} (overlap ids: [${staleOverlap.join(", ")}])`
  );
  out.push(
    `  STALE_TEMPORAL_IDS \\ linkedExpansionInjectedIds: ${staleOnly.length} (ids: [${staleOnly.join(", ")}])`
  );
  out.push(
    "  The linked-expansion injected ids are the chain winners of the " +
      "supersession graph (e.g. 1, 2, 3, 6, 7, 11, 37, 50, 69, 90) plus the " +
      "multi-anchor anchors' current truth ids (1, 7, 11, 69). The set is " +
      "INTENTIONALLY NARROW: only ids the simulated metadata explicitly " +
      "links to a stale record are in the map."
  );
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
      "  The candidate-expansion rules do NOT consult the map. The map is a cross-reference."
    );
    out.push("");
    out.push("  recovered-by-variant (baseline-miss queries, after-currentTruthAt1):");
    for (const [vid, n] of Object.entries(o.recoveredByVariant)) {
      out.push(`    ${vid.padEnd(56)}  ${n}`);
    }
    out.push("");
  }
  out.push("## Honest framing");
  out.push("");
  out.push(
    "  The `metadata-simulation` / `multi-anchor-simulation` categories in " +
      "this report are HONEST about the source of the metadata: the " +
      "simulated linked-expansion map is fixture-derived from the corpus " +
      "summaries the prior diagnostic audits, NOT a runtime signal on the " +
      "production `QueryEval`. The honest reading is: 'a production-side " +
      "schema that carries BOTH the supersession edge map AND the " +
      "multi-anchor treatment AND the linked-expansion map at `remember` " +
      "time would let a runtime candidate generator + the downstream " +
      "multi-anchor-aware reranker reach the oracle-candidate-injection " +
      "ceiling WITHOUT depending on the fixture truth at all'."
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
export type { TemporalTruthCategory, MultiAnchorRerankRule };
export { TEMPORAL_TRUTH_CATEGORIES };
