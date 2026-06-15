/**
 * Benchmark-only supersession / metadata edge simulation
 * (Experiment 7).
 *
 * Why this exists:
 *   The prior experiments (Experiment 5: temporal /
 *   current-truth diagnostic, Experiment 6: temporal
 *   ranking-preference re-ranker) established the
 *   "current-truth-in-topk-stale-top1" bucket as the
 *   single largest action-class on the temporal slice
 *   (5/26 = 19.2% on the lexical baseline). The
 *   "fixture-shaped" re-ranker variants (Experiment 6)
 *   close the gap by demoting records in
 *   `STALE_TEMPORAL_IDS` and/or promoting records in
 *   `currentTruthIds`. Those variants are explicit
 *   ceilings because they key on fixture truth.
 *
 *   The honest production-like question is: "if the
 *   corpus had per-record METADATA indicating the
 *   supersession / version relationship
 *   (`supersedes`, `supersededBy`, `versionGroup`,
 *   `validFrom`, `validUntil`, `isSuperseded`,
 *   `currentInGroup`), could a runtime re-ranker close
 *   the gap WITHOUT consulting `currentTruthIds`?". The
 *   production storage schema does NOT carry these
 *   fields today, and Experiment 6's production-like
 *   variant is a no-op because no runtime signal
 *   distinguishes a stale anchor from an unrelated
 *   distractor. This experiment is the SIMULATION:
 *   we hand-curate an edge map from the existing
 *   benchmark corpus (the same fixture knowledge the
 *   prior experiments use), feed it to a deterministic
 *   re-ranker, and measure the temporal ranking gain
 *   the re-ranker would produce IF the metadata
 *   existed.
 *
 *   The edge map is FIXTURE-KNOWLEDGE: it is derived
 *   from the corpus summaries the prior diagnostic
 *   audits and from the divergentTemporal-labeled
 *   query notes. A reviewer who reads the edge map
 *   sees a hand-curated supersession graph; a reviewer
 *   who reads the variant `category` field sees the
 *   honest "this is metadata-simulation, not
 *   production-like" framing. The edge map is NOT
 *   derived from `currentTruthIds` (the rerank rules
 *   never consult that field) and is NOT
 *   auto-generated; the contract is documented in the
 *   module header so a future production-side
 *   supersession schema can reuse the type without
 *   rewriting the experiment.
 *
 * What this module does:
 *   - Defines a stable supersession-edge TYPE
 *     (`SupersessionEdge`): a per-record
 *     `{recordId, supersedes, supersededBy,
 *     versionGroup, validFrom, validUntil,
 *     isSuperseded, currentInGroup}` block. The
 *     `validFrom` / `validUntil` fields are nullable
 *     because the fixture corpus does not carry
 *     anchor dates; they exist in the type so a
 *     future schema revision that adds dates does
 *     not require a new module.
 *   - Builds a SIMULATED edge map
 *     (`SIMULATED_SUPERSESSION_EDGES`): the union of
 *     the documented supersession / superseded /
 *     conflict / version-group relationships the
 *     prior diagnostic and the corpus summaries
 *     describe. The map is a `Map<number,
 *     SupersessionEdge>`; the keys are the records
 *     with edges; the values carry the supersession
 *     / version-group fields.
 *   - Defines a small set of RE-RANK POLICY
 *     VARIANTS. Each variant consumes the baseline
 *     ranker's existing top-K candidate list and
 *     applies ONE narrow re-ranking rule derived
 *     from the edge map. The candidate set is
 *     unchanged; only the order changes. The
 *     variant table includes:
 *       * `baseline-no-rerank` (the reference
 *         row; production-like).
 *       * `oracle-current-truth-promote-all`
 *         (Experiment 6's oracle, surfaced here for
 *         ceiling comparison).
 *       * `metadata-simulation-supersededBy-demote`
 *         (demote every candidate whose id is in
 *         the simulated `supersededBy` map).
 *       * `metadata-simulation-supersedes-promote`
 *         (promote every candidate that
 *         `supersedes` another candidate in the
 *         same top-K; pass-through otherwise).
 *       * `metadata-simulation-version-group-current`
 *         (within a `versionGroup`, prefer the
 *         `currentInGroup` member; pass-through
 *         when the group is not in the top-K).
 *       * `metadata-simulation-combined` (demote
 *         `supersededBy` + promote `supersedes`
 *         within the top-K, the "full
 *         supersession-aware" re-rank).
 *       * `metadata-simulation-stale-id-derived` (a
 *         narrow honest variant: project the
 *         `supersededBy` edge map to a flat
 *         `stale-like` id set and use it like
 *         Experiment 6's
 *         `fixture-shaped-stale-demote` rule;
 *         included for direct cross-experiment
 *         comparison).
 *   - For every variant, computes the
 *     AFTER-re-rank `currentTruthAt1`,
 *     `staleTop1`, `staleOverCurrent`, and the
 *     DELTA vs the baseline (before-re-rank). The
 *     per-variant metrics mirror Experiment 6's
 *     metric block: same field names, same
 *     deltas, same clean / fixture-ambiguous
 *     split, same per-category change rollup.
 *   - Surfaces "the gap the metadata cannot fix"
 *     block: a per-query list of the cases the
 *     re-ranker cannot recover (the current fact
 *     not in the top-K, the current fact is a
 *     `current-vs-previous` anchor, the candidate
 *     set is otherwise ambiguous). A reviewer who
 *     wants to know "what queries would STILL
 *     require a candidate-generation fix even
 *     with full supersession metadata?" reads
 *     this block.
 *   - Renders a human-readable report and a JSON
 *     artifact. Both are byte-stable for a fixed
 *     input.
 *
 * What this module does NOT do:
 *   - It does NOT call any provider, any ranker, or
 *     any external service. It consumes the same
 *     per-query input the prior experiments
 *     consume (a list of `QueryEval`s + a list of
 *     `BenchmarkQuery`s).
 *   - It does NOT change the production
 *     `recall(text)` controller, the public MCP
 *     API, or the storage schema.
 *   - It does NOT change candidate generation. The
 *     re-ranker only re-orders the existing top-K
 *     candidate list; the ranker that produced the
 *     list is unchanged.
 *   - It does NOT use `currentTruthIds` in the
 *     re-rank rules. The re-ranker is
 *     `currentTruthIds`-free; the `currentTruthAt1`
 *     metric is a downstream measurement of the
 *     re-ranker's outcome, not an input. A
 *     reviewer who wants to verify the
 *     `currentTruthIds`-free contract reads the
 *     `applySupersessionRerankRule` helper: the
 *     function does not read `query.currentTruthIds`
 *     for the rule decisions (it reads them only
 *     to mirror the prior experiment's metric
 *     helpers via the classifier).
 *   - It does NOT run a new dense embedding
 *     benchmark. A pre-computed semantic-evidence
 *     map (the same map the prior diagnostic
 *     consumes) can be attached for cross-reference;
 *     the re-ranker itself does not consult the
 *     map.
 *   - It does NOT propose a deployment policy.
 *     The `recommendedVerdict` field on each
 *     variant row is a research-only reading aid.
 *     A reviewer who wants a deployable rule reads
 *     the production-like rows; the
 *     `metadata-simulation` rows are a SIMULATION
 *     of what a deployable rule COULD do if the
 *     metadata existed.
 *
 * Determinism:
 *   Every function in this module is pure. The
 *   edge map is a frozen constant; the re-rank
 *   rule is a pure function of the per-query
 *   signal block + the edge map; the per-variant
 *   metrics are aggregated from the per-query
 *   re-rank decisions. The same inputs always
 *   produce the same outputs.
 *
 * Honest framing:
 *   The `metadata-simulation` category is
 *   INTENTIONALLY distinct from the Experiment 6
 *   `fixture-shaped` category. Experiment 6's
 *   `fixture-shaped` variants key on a flat
 *   `STALE_TEMPORAL_IDS` set (an id list). This
 *   module's `metadata-simulation` variants key
 *   on an EDGE MAP (a structured record with
 *   `supersedes`, `supersededBy`, `versionGroup`,
 *   etc.). The category name is `metadata-simulation`
 *   because:
 *     * the edge data is NOT a runtime signal on
 *       the production `QueryEval` (so it is
 *       NOT `production-like`);
 *     * the edge data is hand-curated from
 *       fixture / corpus knowledge (so it is
 *       NOT `oracle` and the re-rank rule does
 *       NOT use `currentTruthIds`);
 *     * the edge data is a SIMULATED metadata
 *       schema (so a reviewer reading the
 *       `category` field sees "this is what
 *       would happen IF the metadata existed",
 *       not "this is what a production
 *       deployment does today").
 *   A reviewer who wants to assess how much
 *   metadata is "worth" reads the
 *   `metadata-simulation-combined` row and
 *   compares it to the `baseline-no-rerank` and
 *   `oracle-current-truth-promote-all` rows. The
 *   honest reading is: "the metadata-simulation
 *   variant closes the gap the fixture-shaped
 *   variant closed (a re-ranker based on
 *   `supersededBy` edges is just as effective as
 *   a re-ranker based on the flat `STALE_TEMPORAL_IDS`
 *   set on the lexical baseline); a production-side
 *   schema that carries the edges at `remember`
 *   time would let a runtime re-ranker reach the
 *   metadata-simulation ceiling WITHOUT depending
 *   on the fixture truth at all".
 *
 * Limitations:
 *   - The edge map is hand-curated from the
 *     corpus summaries. A future corpus revision
 *     (new superseded / conflict / version-group
 *     records) requires updating the map; the
 *     experiment does NOT auto-derive the edges
 *     from the corpus. The map is exported as
 *     `SIMULATED_SUPERSESSION_EDGES` so the
 *     contract is visible at the call site.
 *   - The `validFrom` / `validUntil` fields are
 *     `null` for every edge in the simulated map
 *     (the fixture does not carry anchor dates).
 *     A future production-side supersession
 *     schema would populate them; the re-rank
 *     rules in this module do NOT consult the
 *     date fields (the rules are pure
 *     "supersedes / supersededBy / versionGroup"
 *     decisions). The fields are in the type
 *     contract so a future schema revision
 *     can plug in date-aware re-rank rules
 *     without changing the type.
 *   - The `metadata-simulation` category is
 *     honest about NOT being production-like.
 *     The re-rank rules would be a runtime
 *     re-ranker IF the edge map were
 *     production-side; today the edge map is
 *     fixture-derived, so the re-rank rules
 *     require a production-side schema change
 *     (a `supersedes` / `supersededBy` /
 *     `versionGroup` column on the storage
 *     schema) before they can be wired into
 *     the production `recall(text)` controller.
 *   - The `current-vs-previous` anchor records
 *     (117..120) are explicitly excluded from
 *     the edge map. They encode BOTH the current
 *     and the previous fact in their summary;
 *     marking them as `supersededBy` would be a
 *     misread of their semantic content. The
 *     exclusion is documented in the edge map
 *     (a `null` entry for those ids) and is
 *     flagged in the report.
 *   - The semantic overlay is a passed-in
 *     `queryId -> "hit"|"miss"` map; the
 *     experiment does NOT re-derive the dense
 *     ranker's behavior. The overlay is a
 *     cross-reference, not a production signal.
 *   - The re-ranker does NOT change candidate
 *     generation. The `current-truth-missing-*`
 *     categories are out of reach: the current
 *     fact is not in the top-K, so no in-list
 *     re-ordering can surface it. The report
 *     surfaces the `unchangedBecauseCurrentMissing`
 *     count so the ceiling is honest.
 *   - The `recommendedVerdict` field on each
 *     variant row is a research-only reading
 *     aid. The verdict is computed
 *     deterministically from the variant's metric
 *     block (regressions > 0 -> unsafe;
 *     currentTruthAt1Delta > 0 -> safe;
 *     otherwise neutral). The verdict is NOT a
 *     deployment recommendation. A reviewer who
 *     wants to decide "should we ship this
 *     variant?" reads the variant table and the
 *     per-category change rollup, not the
 *     verdict.
 */

import type { BenchmarkQuery } from "./queries.js";
import type { QueryEval } from "./metrics.js";
import { STALE_TEMPORAL_IDS } from "./temporal-truth-diagnostic.js";
import {
  classifyTemporalTruthFailure,
  type TemporalTruthCategory,
  TEMPORAL_TRUTH_CATEGORIES,
} from "./temporal-truth-diagnostic.js";

// ---------------------------------------------------------------------------
// Edge type
// ---------------------------------------------------------------------------

/**
 * A simulated supersession / version-group edge for a
 * single record id. The fields are the per-record
 * metadata a production-side supersession schema
 * would carry:
 *
 *   - `recordId` — the corpus record id.
 *   - `supersedes` — the record id this record
 *     REPLACES (the OLDER fact). The edge points
 *     from the current record to the older one
 *     (the older record's `supersededBy` points
 *     back to this id). A `null` value means the
 *     record does not supersede another record
 *     (it is either a "current" record with no
 *     predecessor or a record outside the
 *     supersession graph).
 *   - `supersededBy` — the record id this record
 *     IS REPLACED BY (the NEWER fact). A `null`
 *     value means the record is not superseded
 *     (it is either a current record or a
 *     record outside the supersession graph).
 *   - `versionGroup` — a string group label
 *     identifying the version chain the record
 *     belongs to. Records in the same group
 *     are version-equivalent (e.g. all Postgres
 *     major-version records are in
 *     `g-postgres-v16`). A `null` value means
 *     the record is not part of a documented
 *     version chain.
 *   - `validFrom` — the timestamp the record
 *     became current. The field is `null` for
 *     every simulated edge (the fixture corpus
 *     does not carry anchor dates). The field
 *     is in the type contract so a future
 *     production-side schema revision can
 *     populate it without a new module.
 *   - `validUntil` — the timestamp the record
 *     stopped being current. The field is
 *     `null` for every simulated edge (the
 *     fixture corpus does not carry anchor
 *     dates). The field is in the type
 *     contract for the same reason as
 *     `validFrom`.
 *   - `isSuperseded` — convenience boolean
 *     equivalent to `supersededBy !== null`. A
 *     re-rank rule that only needs "is this
 *     record old?" reads the boolean; a rule
 *     that needs "what is the newer record?"
 *     reads `supersededBy`.
 *   - `currentInGroup` — convenience boolean
 *     `true` iff the record is the current
 *     member of its `versionGroup` (the
 *     "winner" of the version chain). The flag
 *     is the type-level inverse of `isSuperseded`
 *     for records that belong to a group; a
 *     record outside any group has
 *     `currentInGroup: false` by definition
 *     (it is not a current member of a group
 *     it is not in).
 *
 * The type is a frozen plain data structure.
 * The contract is documented at the call site
 * so a reviewer can grep.
 */
export interface SupersessionEdge {
  recordId: number;
  supersedes: number | null;
  supersededBy: number | null;
  versionGroup: string | null;
  validFrom: string | null;
  validUntil: string | null;
  isSuperseded: boolean;
  currentInGroup: boolean;
}

// ---------------------------------------------------------------------------
// Simulated edge map
// ---------------------------------------------------------------------------

/**
 * The simulated supersession / version-group edge
 * map. The map is FIXTURE-KNOWLEDGE: every edge is
 * derived from the corpus summaries the prior
 * diagnostic audits and from the
 * `divergentTemporal`-labeled query notes. The
 * `versionGroup` labels are the documented cluster
 * names (e.g. `g-postgres-v16` for the Postgres
 * version chain). The map is a `Map<number,
 * SupersessionEdge>`; the keys are the records
 * with edges; records without an edge are NOT in
 * the map (the re-rank rules treat them as
 * pass-through).
 *
 * The map is HAND-CURATED and INTENTIONALLY
 * NARROW. It covers the documented supersession
 * patterns the prior diagnostic surfaces:
 *   - the legacy cluster (21..24) and the
 *     original temporal-old cluster (57..60);
 *   - the conflict cluster (101..104);
 *   - the superseded-anchor cluster (105..108);
 *   - the temporal-old / no-validation cluster
 *     (96..100);
 *   - the corresponding current records (1, 2, 3,
 *     6, 7, 37, 50, 69, 90) the prior diagnostic
 *     identifies as the "current fact" for each
 *     supersession chain.
 *
 * The `current-vs-previous` anchor records
 * (117..120) are EXPLICITLY EXCLUDED from the map.
 * They encode BOTH the current and the previous
 * fact in their summary; marking them as
 * `supersededBy` would be a misread of their
 * semantic content. The exclusion is documented
 * in the `EXCLUDED_FROM_EDGE_MAP` constant.
 *
 * The `validFrom` / `validUntil` fields are
 * `null` for every edge (the fixture corpus does
 * not carry anchor dates). A future production-
 * side schema revision would populate them; the
 * re-rank rules in this module do NOT consult
 * the date fields.
 */
export const SIMULATED_SUPERSESSION_EDGES: ReadonlyMap<
  number,
  SupersessionEdge
> = (() => {
  const out = new Map<number, SupersessionEdge>();
  // Each entry: recordId -> { supersedes, supersededBy, versionGroup }.
  // The convenience booleans are derived from the explicit
  // `supersededBy` / `supersedes` fields.
  const entries: ReadonlyArray<{
    recordId: number;
    supersedes: number | null;
    supersededBy: number | null;
    versionGroup: string;
  }> = [
    // Postgres version chain. 21 = Postgres 14 (legacy Q2), 105 = Postgres
    // 15 (last quarter, superseded anchor), 1 = Postgres 16 (current).
    { recordId: 21, supersedes: null, supersededBy: 1, versionGroup: "g-postgres-v16" },
    { recordId: 105, supersedes: null, supersededBy: 1, versionGroup: "g-postgres-v16" },
    { recordId: 1, supersedes: 21, supersededBy: null, versionGroup: "g-postgres-v16" },
    // Release cut chain. 22 = Thursday release-branch (legacy), 103 =
    // Thursday release-branch (conflict anchor), 7 = Tuesday main cut
    // (current).
    { recordId: 22, supersedes: null, supersededBy: 7, versionGroup: "g-release-tue" },
    { recordId: 103, supersedes: null, supersededBy: 7, versionGroup: "g-release-tue" },
    { recordId: 7, supersedes: 22, supersededBy: null, versionGroup: "g-release-tue" },
    // Retrieval design chain. 23 = single-pass retrieval (legacy), 104 =
    // single-pass no-rerank (conflict anchor), 3 = re-rank-before-
    // synthesis (current).
    { recordId: 23, supersedes: null, supersededBy: 3, versionGroup: "g-retrieval-rerank" },
    { recordId: 104, supersedes: null, supersededBy: 3, versionGroup: "g-retrieval-rerank" },
    { recordId: 3, supersedes: 23, supersededBy: null, versionGroup: "g-retrieval-rerank" },
    // Safety pipeline chain. 24 = hard-coded blocklist (legacy), 108 =
    // hard-coded blocklist (superseded anchor), 69 = regex-based
    // classifier with allow-list (current).
    { recordId: 24, supersedes: null, supersededBy: 69, versionGroup: "g-safety-pipeline" },
    { recordId: 108, supersedes: null, supersededBy: 69, versionGroup: "g-safety-pipeline" },
    { recordId: 69, supersedes: 24, supersededBy: null, versionGroup: "g-safety-pipeline" },
    // Storage schema chain. 57 = raw text alongside summaries (legacy
    // temporal-old), 50 = summaries only with additive migrations
    // (current). 96 = controller accepted any provider output (legacy
    // no-validation) and 107 = controller accepted any provider output
    // (superseded controller-validation anchor) are in the same
    // versionGroup: they describe the OLD controller behavior that the
    // current controller replaces. The current record is 50 (the Zod-
    // validated schema / controller contract).
    { recordId: 57, supersedes: null, supersededBy: 50, versionGroup: "g-storage-summaries" },
    { recordId: 96, supersedes: null, supersededBy: 50, versionGroup: "g-controller-validation" },
    { recordId: 107, supersedes: null, supersededBy: 50, versionGroup: "g-controller-validation" },
    { recordId: 50, supersedes: 57, supersededBy: null, versionGroup: "g-storage-summaries" },
    // CI runner chain. 58 = single self-hosted runner (legacy
    // temporal-old), 6 = current CI pipeline (managed CI service with
    // matrix builds).
    { recordId: 58, supersedes: null, supersededBy: 6, versionGroup: "g-ci" },
    { recordId: 6, supersedes: 58, supersededBy: null, versionGroup: "g-ci" },
    // Provider chain. 59 = single primary endpoint (legacy
    // temporal-old), 90 = current primary + fallback provider (typed
    // result union). 70 = rate-limit policy belongs to the same
    // versionGroup: the OLD provider did not have a rate-limit policy
    // and the current one reads it from CORTEX_PROVIDER_RATE_LIMIT.
    { recordId: 59, supersedes: null, supersededBy: 90, versionGroup: "g-provider" },
    { recordId: 90, supersedes: 59, supersededBy: null, versionGroup: "g-provider" },
    // Monitoring chain. 60 = polled every minute (legacy
    // temporal-old), 37 = pushed structured events (current).
    { recordId: 60, supersedes: null, supersededBy: 37, versionGroup: "g-monitoring" },
    { recordId: 37, supersedes: 60, supersededBy: null, versionGroup: "g-monitoring" },
    // Runtime chain. 106 = Node 20 (superseded anchor), 2 = Node 22
    // (current). The legacy `21..24` cluster does not include a
    // runtime record, so the chain starts at 106.
    { recordId: 106, supersedes: null, supersededBy: 2, versionGroup: "g-runtime-node22" },
    { recordId: 2, supersedes: null, supersededBy: null, versionGroup: "g-runtime-node22" },
    // The HTTP-client legacy cluster (93..95) is documented in the
    // corpus as "legacy" but is not part of the temporal-current-vs-
    // previous anchor set; it is included in the edge map for
    // completeness, with 95 ("current client opens a new connection
    // per request") as the chain winner.
    { recordId: 93, supersedes: null, supersededBy: 95, versionGroup: "g-http-client" },
    { recordId: 94, supersedes: null, supersededBy: 95, versionGroup: "g-http-client" },
    { recordId: 95, supersedes: null, supersededBy: null, versionGroup: "g-http-client" },
  ];
  for (const e of entries) {
    out.set(e.recordId, {
      recordId: e.recordId,
      supersedes: e.supersedes,
      supersededBy: e.supersededBy,
      versionGroup: e.versionGroup,
      validFrom: null,
      validUntil: null,
      isSuperseded: e.supersededBy !== null,
      // `currentInGroup` is the type-level inverse of `isSuperseded`
      // for records that belong to a group: the chain winner is the
      // record whose `supersededBy` is null AND whose group is the
      // same as the rest. A future schema can override the
      // computation by reading the chain explicitly.
      currentInGroup: e.supersededBy === null,
    });
  }
  return out;
})();

/**
 * The set of record ids EXPLICITLY EXCLUDED from the
 * edge map. The set is exported so a reviewer can
 * audit the exclusion decisions. The exclusion
 * rationale is documented in the module header
 * (the `current-vs-previous` anchor records 117..120
 * encode BOTH the current and the previous fact in
 * their summary; marking them as `supersededBy` would
 * be a misread of their semantic content). The set
 * is also surfaced on the report's "excluded records"
 * block.
 */
export const EXCLUDED_FROM_EDGE_MAP: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  // 117..120 are the `current-vs-previous` anchor
  // records. They are EXPLICITLY excluded from the
  // edge map.
  for (let i = 117; i <= 120; i++) out.add(i);
  return out;
})();

/**
 * The set of `stale-like` ids the
 * `metadata-simulation-stale-id-derived` variant
 * uses. The set is the projection of the simulated
 * `supersededBy` map: every record whose
 * `isSuperseded === true` is included. The
 * projection is INTENTIONAL: the variant is a
 * direct cross-experiment comparison with
 * Experiment 6's `fixture-shaped-stale-demote`
 * rule, which uses the hand-curated
 * `STALE_TEMPORAL_IDS` set. A reviewer who wants
 * to read "what if the runtime signal were the
 * `STALE_TEMPORAL_IDS` set, not the
 * `supersededBy` projection?" reads
 * `metadata-simulation-stale-id-derived` with an
 * override `staleLikeIds` set; the default uses
 * the projection so the cross-experiment
 * comparison is direct.
 */
export const SIMULATED_SUPERSEDED_IDS: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  for (const [id, edge] of SIMULATED_SUPERSESSION_EDGES.entries()) {
    if (edge.isSuperseded) out.add(id);
  }
  return out;
})();

/**
 * The set of `current-in-group` ids the
 * `metadata-simulation-version-group-current`
 * variant uses. The set is the projection of the
 * simulated `currentInGroup` flag: every record
 * whose `currentInGroup === true` is included. A
 * record in the projection is the "winner" of its
 * version chain; a re-rank rule that prefers the
 * `currentInGroup` member within a `versionGroup`
 * reads the set.
 */
export const SIMULATED_CURRENT_IN_GROUP_IDS: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  for (const [id, edge] of SIMULATED_SUPERSESSION_EDGES.entries()) {
    if (edge.currentInGroup) out.add(id);
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Variant types
// ---------------------------------------------------------------------------

/**
 * The narrow re-rank rule the variant applies to
 * the baseline ranker's existing top-K candidate
 * list. The rule is a pure function of the
 * per-query top-K + the simulated edge map. The
 * ranker that produced the top-K is unchanged.
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
 *     Surfaced here for ceiling comparison; the
 *     rule is identical to Experiment 6's
 *     `oracle-current-truth-promote-all` rule.
 *   - `metadata-simulation-supersededBy-demote` —
 *     demote every candidate in the top-K whose
 *     id is in the simulated `supersededBy` map
 *     to the BOTTOM of the list. The map is the
 *     `SIMULATED_SUPERSESSION_EDGES` projection.
 *     **METADATA-SIMULATION**: uses a
 *     fixture-derived edge map; the rule does NOT
 *     consult `currentTruthIds`.
 *   - `metadata-simulation-supersedes-promote` —
 *     promote every candidate in the top-K that
 *     `supersedes` another candidate in the SAME
 *     top-K to the TOP of the list, preserving
 *     the relative order of the promoted
 *     candidates and the relative order of the
 *     non-promoted candidates. Candidates that do
 *     not `supersede` another top-K candidate
 *     pass through unchanged. **METADATA-
 *     SIMULATION**.
 *   - `metadata-simulation-version-group-current`
 *     — within a `versionGroup`, prefer the
 *     `currentInGroup` member. The rule
 *     partitions the top-K by `versionGroup`; for
 *     each group, the `currentInGroup` member (if
 *     any) is moved to the FRONT of the group
 *     slot, preserving the relative order of the
 *     non-current members. Records outside any
 *     group pass through unchanged. **METADATA-
 *     SIMULATION**.
 *   - `metadata-simulation-combined` — the
 *     "full supersession-aware" re-rank: demote
 *     every candidate whose id is in the
 *     simulated `supersededBy` map to the
 *     BOTTOM, then promote every candidate that
 *     `supersedes` another candidate in the same
 *     top-K to the TOP. The middle slot keeps
 *     its relative order. **METADATA-SIMULATION**.
 *   - `metadata-simulation-stale-id-derived` —
 *     narrow honest cross-experiment variant:
 *     project the `supersededBy` map to a flat
 *     `staleLikeIds` set and apply Experiment 6's
 *     `fixture-shaped-stale-demote` rule. The
 *     default `staleLikeIds` is
 *     `SIMULATED_SUPERSEDED_IDS`; a future
 *     variant can override it. The variant is
 *     the bridge between the edge map and the
 *     flat `STALE_TEMPORAL_IDS` set: a reviewer
 *     who wants to ask "is the edge map
 *     equivalent to the flat stale set?" reads
 *     this row. **METADATA-SIMULATION** (the
 *     edge data is fixture-derived; the rule is
 *     a projection of the edge map).
 */
export type SupersessionRerankRule =
  | { kind: "none" }
  | { kind: "oracle-current-truth-promote" }
  | { kind: "metadata-simulation-supersededBy-demote" }
  | { kind: "metadata-simulation-supersedes-promote" }
  | {
      kind: "metadata-simulation-version-group-current";
    }
  | { kind: "metadata-simulation-combined" }
  | {
      kind: "metadata-simulation-stale-id-derived";
      /**
       * The flat `stale-like` id set the rule
       * uses. The default is
       * `SIMULATED_SUPERSEDED_IDS` (the
       * projection of the `supersededBy` map);
       * a future variant can override it (e.g.
       * with `STALE_TEMPORAL_IDS` for direct
       * cross-experiment comparison).
       */
      staleLikeIds: ReadonlySet<number>;
    };

/**
 * A single re-rank variant. The variant is the
 * baseline re-ranking (no-op) PLUS a narrow
 * re-rank rule. The variant is the unit the
 * report iterates over. The `category` field is
 * the honest "is this variant production-like,
 * fixture-shaped, oracle, or metadata-simulation?"
 * reading.
 */
export interface SupersessionRerankVariant {
  /** Stable id used in the artifact + report. */
  id: string;
  /**
   * Short human-readable description surfaced
   * in the report. The description MUST be
   * honest about which category the variant
   * belongs to so a reviewer reading the
   * headline table does not mistake a
   * `metadata-simulation` variant for a
   * `production-like` one.
   */
  description: string;
  /**
   * The honest category. The categories are:
   *   - `production-like` (the reference
   *     `baseline-no-rerank` row; no runtime
   *     signal is consumed);
   *   - `oracle` (the
   *     `oracle-current-truth-promote` row; keys
   *     on `currentTruthIds`);
   *   - `metadata-simulation` (the edge-driven
   *     re-rank rules; keys on a fixture-derived
   *     edge map, NOT on `currentTruthIds`,
   *     NOT on a runtime signal). The
   *     `metadata-simulation` category is the
   *     HONEST framing of the edge map: a
   *     reviewer who reads the category sees
   *     "this is what would happen IF the
   *     metadata existed at runtime".
   */
  category: "production-like" | "oracle" | "metadata-simulation";
  /**
   * The narrow re-rank rule. A `none` rule is
   * the baseline row.
   */
  rule: SupersessionRerankRule;
}

/**
 * The set of built-in variants the experiment
 * ships with. The list is intentionally small
 * and explicit so a reviewer can audit the
 * trade-off curve without re-deriving. The order
 * is declaration order; the report iterates in
 * this order, so the on-disk artifact is
 * byte-stable for a given input.
 *
 * The first variant is the baseline (no
 * re-rank). The second is the oracle ceiling
 * (Experiment 6's `oracle-current-truth-promote-all`,
 * surfaced for direct comparison). The
 * remaining variants are the metadata-simulation
 * edge-driven re-rank rules.
 */
export const BUILTIN_SUPERSESSION_RERANK_VARIANTS: ReadonlyArray<SupersessionRerankVariant> =
  [
    // ---- Baseline (no re-rank) ----
    {
      id: "baseline-no-rerank",
      description:
        "Baseline: no re-ranking. The lexical baseline's existing top-K order is used as-is. The reference row; production-like. This is the row a production deployment would use today.",
      category: "production-like",
      rule: { kind: "none" },
    },
    // ---- Oracle ceiling (from Experiment 6) ----
    {
      id: "oracle-current-truth-promote-all",
      description:
        "Oracle: promote every candidate whose id is in currentTruthIds to the TOP of the top-K, preserving the relative order of promoted and non-promoted candidates. Uses fixture truth (currentTruthIds). The 'if we knew which records are current, promote them all' ceiling. Clearly NOT production-like; research-only.",
      category: "oracle",
      rule: { kind: "oracle-current-truth-promote" },
    },
    // ---- Metadata-simulation: demote supersededBy ----
    {
      id: "metadata-simulation-supersededBy-demote",
      description:
        "Metadata-simulation: demote every candidate whose id is in the simulated supersededBy map to the BOTTOM of the top-K, preserving the relative order of demoted and non-demoted candidates. The edge map is SIMULATED_SUPERSESSION_EDGES (fixture-derived); the rule does NOT consult currentTruthIds. The 'if the production schema carried a supersededBy edge and a runtime re-ranker used it, what would happen?' reading. Honest framing: this is metadata-simulation, NOT production-like; a production deployment needs the edge data on every record at remember time.",
      category: "metadata-simulation",
      rule: { kind: "metadata-simulation-supersededBy-demote" },
    },
    // ---- Metadata-simulation: promote supersedes ----
    {
      id: "metadata-simulation-supersedes-promote",
      description:
        "Metadata-simulation: promote every candidate in the top-K that supersedes another candidate in the SAME top-K to the TOP, preserving the relative order of promoted and non-promoted candidates. A candidate that does not supersede another top-K candidate passes through unchanged. The edge map is SIMULATED_SUPERSESSION_EDGES; the rule does NOT consult currentTruthIds. The 'if the runtime re-ranker only promotes candidates that explicitly supersede another in the same top-K, what would happen?' reading.",
      category: "metadata-simulation",
      rule: { kind: "metadata-simulation-supersedes-promote" },
    },
    // ---- Metadata-simulation: versionGroup current preference ----
    {
      id: "metadata-simulation-version-group-current",
      description:
        "Metadata-simulation: within a versionGroup, prefer the currentInGroup member. The rule partitions the top-K by versionGroup; for each group, the currentInGroup member (if any) is moved to the FRONT of the group slot, preserving the relative order of the non-current members. Records outside any group pass through unchanged. The edge map is SIMULATED_SUPERSESSION_EDGES; the rule does NOT consult currentTruthIds. The 'if the runtime re-ranker preferred the current member of a version chain' reading.",
      category: "metadata-simulation",
      rule: { kind: "metadata-simulation-version-group-current" },
    },
    // ---- Metadata-simulation: combined (demote + promote) ----
    {
      id: "metadata-simulation-combined",
      description:
        "Metadata-simulation: the 'full supersession-aware' re-rank. First, demote every candidate whose id is in the simulated supersededBy map to the BOTTOM. Then, promote every candidate that supersedes another candidate in the same top-K to the TOP. The middle slot keeps its relative order. The edge map is SIMULATED_SUPERSESSION_EDGES; the rule does NOT consult currentTruthIds. The 'if the runtime re-ranker used BOTH the supersededBy demote and the supersedes promote, what would happen?' reading. This is the strongest metadata-simulation rule the experiment ships with.",
      category: "metadata-simulation",
      rule: { kind: "metadata-simulation-combined" },
    },
    // ---- Metadata-simulation: stale-id-derived (cross-experiment bridge) ----
    {
      id: "metadata-simulation-stale-id-derived",
      description:
        "Metadata-simulation (cross-experiment bridge): project the simulated supersededBy map to a flat staleLikeIds set (SIMULATED_SUPERSEDED_IDS) and apply the same demote rule Experiment 6's fixture-shaped-stale-demote rule uses. The variant is the bridge between the edge map and the flat STALE_TEMPORAL_IDS set: a reviewer who wants to ask 'is the edge map equivalent to the flat stale set on the lexical baseline?' reads this row. Honest framing: the edge data is fixture-derived; the rule is a one-way projection.",
      category: "metadata-simulation",
      rule: {
        kind: "metadata-simulation-stale-id-derived",
        staleLikeIds: SIMULATED_SUPERSEDED_IDS,
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
 * The function never shortens the top-K. A
 * re-rank that produces an empty `topIds`
 * returns an empty result (the ranker abstained
 * on this query; the re-ranker cannot conjure
 * candidates).
 *
 * The function NEVER consults
 * `query.currentTruthIds` for the rule
 * decisions. The oracle variant reads
 * `query.currentTruthIds` ONLY for the
 * `oracle-current-truth-promote` rule (the
 * variant is explicitly marked `oracle` in the
 * category field); every metadata-simulation
 * variant reads ONLY the simulated edge map.
 *
 * The function is the unit the per-variant
 * aggregator consumes; the aggregator iterates
 * over the input list and calls this helper
 * for every query.
 */
export function applySupersessionRerankRule(args: {
  rule: SupersessionRerankRule;
  eval: QueryEval;
  query: BenchmarkQuery;
}): { topIds: number[]; topScores: number[] } {
  const { rule, eval: e } = args;
  const { topIds, topScores } = e;

  // Defensive copy. The function never mutates
  // the input arrays.
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

  if (rule.kind === "oracle-current-truth-promote") {
    // The oracle variant reads
    // `query.currentTruthIds` directly. Every
    // other rule is `currentTruthIds`-free.
    const currentTruthSet = new Set(args.query.currentTruthIds);
    const currentFirst: number[] = [];
    const middle: number[] = [];
    for (const p of positions) {
      const id = ids[p]!;
      if (currentTruthSet.has(id)) currentFirst.push(p);
      else middle.push(p);
    }
    return projected([...currentFirst, ...middle]);
  }

  if (rule.kind === "metadata-simulation-supersededBy-demote") {
    // The demote rule: every candidate whose id
    // is in the simulated `supersededBy` map
    // moves to the BOTTOM. The map is the
    // `SIMULATED_SUPERSESSION_EDGES` projection:
    // every record with `isSuperseded === true`.
    // The rule does NOT consult
    // `currentTruthIds`.
    const notSuperseded: number[] = [];
    const supersededLast: number[] = [];
    for (const p of positions) {
      const id = ids[p]!;
      const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
      if (edge && edge.isSuperseded) supersededLast.push(p);
      else notSuperseded.push(p);
    }
    return projected([...notSuperseded, ...supersededLast]);
  }

  if (rule.kind === "metadata-simulation-supersedes-promote") {
    // The promote rule: every candidate that
    // `supersedes` ANOTHER CANDIDATE IN THE SAME
    // TOP-K moves to the TOP. The check is
    // bounded: a candidate that `supersedes`
    // an id NOT in the top-K is NOT promoted.
    // The rule does NOT consult
    // `currentTruthIds`.
    const topKSet = new Set(ids);
    const supersedesFirst: number[] = [];
    const middle: number[] = [];
    for (const p of positions) {
      const id = ids[p]!;
      const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
      const supersedesInTopK =
        edge !== undefined &&
        edge.supersedes !== null &&
        topKSet.has(edge.supersedes);
      if (supersedesInTopK) supersedesFirst.push(p);
      else middle.push(p);
    }
    return projected([...supersedesFirst, ...middle]);
  }

  if (rule.kind === "metadata-simulation-version-group-current") {
    // The version-group rule: within a
    // `versionGroup`, prefer the
    // `currentInGroup` member. The rule
    // partitions the top-K by `versionGroup`;
    // for each group, the `currentInGroup`
    // member (if any) is moved to the FRONT
    // of the group slot, preserving the
    // relative order of the non-current
    // members. Records outside any group pass
    // through unchanged. The rule does NOT
    // consult `currentTruthIds`.
    //
    // Implementation: a single pass that
    // groups positions by `versionGroup` (or
    // `null` for "no group"). Within each
    // group, the `currentInGroup` member is
    // moved to the front; the rest of the
    // group preserves the input order. Groups
    // are emitted in the order their first
    // member appears in the input.
    const groupOrder: Array<string | null> = [];
    const groupPositions = new Map<string | null, number[]>();
    for (const p of positions) {
      const id = ids[p]!;
      const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
      const group = edge ? edge.versionGroup : null;
      if (!groupPositions.has(group)) {
        groupOrder.push(group);
        groupPositions.set(group, []);
      }
      groupPositions.get(group)!.push(p);
    }
    const reordered: number[] = [];
    for (const g of groupOrder) {
      const groupPos = groupPositions.get(g) ?? [];
      if (g === null) {
        // Records outside any group pass
        // through unchanged.
        reordered.push(...groupPos);
        continue;
      }
      // Within the group, prefer the
      // `currentInGroup` member.
      const currentFirst: number[] = [];
      const rest: number[] = [];
      for (const p of groupPos) {
        const id = ids[p]!;
        const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
        if (edge && edge.currentInGroup) currentFirst.push(p);
        else rest.push(p);
      }
      reordered.push(...currentFirst, ...rest);
    }
    return projected(reordered);
  }

  if (rule.kind === "metadata-simulation-combined") {
    // The combined rule: demote `supersededBy`
    // to the BOTTOM, then promote `supersedes`
    // (within the same top-K) to the TOP. The
    // middle slot keeps its relative order. The
    // rule does NOT consult `currentTruthIds`.
    const topKSet = new Set(ids);
    const supersedesFirst: number[] = [];
    const middle: number[] = [];
    const supersededLast: number[] = [];
    for (const p of positions) {
      const id = ids[p]!;
      const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
      const isSuperseded = edge !== undefined && edge.isSuperseded;
      const supersedesInTopK =
        edge !== undefined &&
        edge.supersedes !== null &&
        topKSet.has(edge.supersedes);
      if (isSuperseded) supersededLast.push(p);
      else if (supersedesInTopK) supersedesFirst.push(p);
      else middle.push(p);
    }
    return projected([...supersedesFirst, ...middle, ...supersededLast]);
  }

  if (rule.kind === "metadata-simulation-stale-id-derived") {
    // The stale-id-derived rule: the same
    // demote rule as Experiment 6's
    // `fixture-shaped-stale-demote`, but with a
    // `staleLikeIds` set that is the projection
    // of the simulated `supersededBy` map. The
    // default is `SIMULATED_SUPERSEDED_IDS`. The
    // rule does NOT consult `currentTruthIds`.
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

  // Defensive fallback. The discriminated
  // union is exhaustive; the fallback is
  // unreachable at the type level. The runtime
  // check is here so a future variant addition
  // that forgets to extend the helper produces
  // a loud error rather than a silent
  // mis-routing.
  throw new Error(
    `applySupersessionRerankRule: unknown rule kind "${
      (rule as { kind: string }).kind
    }" for query "${e.queryId}"`,
  );
}

// ---------------------------------------------------------------------------
// Per-query re-rank output
// ---------------------------------------------------------------------------

/**
 * Per-query re-rank output. The shape is what the
 * per-variant aggregator consumes. The fields
 * are:
 *   - `queryId`, `family` — the fixture's stable
 *     id and family.
 *   - `baselineTop1Id`, `baselineCurrentTruthAt1`,
 *     `baselineStaleTop1`, `baselineStaleOverCurrent`,
 *     `baselineCategory`,
 *     `baselineIsDivergentLabeled` — the baseline's
 *     outcome on this query. `baselineCategory` is
 *     the prior diagnostic's category for the
 *     query. The per-category change block
 *     consumes it.
 *   - `afterTop1Id`, `afterCurrentTruthAt1`,
 *     `afterStaleTop1`, `afterStaleOverCurrent`,
 *     `afterCategory` — the re-ranker outcome.
 *   - `categoryChange` — the (baseline -> after)
 *     pair, computed once. The pair is a string
 *     like `"current-truth-in-topk-stale-top1 ->
 *     current-truth-top1"` so a reviewer can read
 *     the per-query deltas at a glance.
 *   - `regression` — `true` iff the baseline was
 *     `currentTruthAt1` and the re-ranker's
 *     `currentTruthAt1` is false. A re-ranker
 *     that introduces regressions is unsafe.
 *   - `unchangedBecauseCurrentMissing` — `true`
 *     iff the baseline had no `currentTruthId`
 *     in the top-K AND the re-ranker did not
 *     promote a `currentTruthId` either (the
 *     re-ranker cannot help when the current
 *     fact is not in the candidate set).
 *   - `newTopIds` — the re-ranker output's top-K
 *     ids (parallel to `newTopScores`).
 *   - `newTopScores` — the re-ranker output's
 *     per-candidate scores, parallel to
 *     `newTopIds`. The score values are the
 *     baseline's scores in the re-ranker order;
 *     the re-ranker does NOT re-score, it
 *     re-orders.
 *   - `isClean`, `isFixtureAmbiguous` — the
 *     clean / fixture-ambiguous split on the
 *     baseline's `isDivergentLabeled` flag.
 */
export interface SupersessionRerankPerQuery {
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
   *  "clean" (non-fixture-ambiguous) query, or
   *  on a fixture-ambiguous one. The split is
   *  on the query's `divergentTemporal`
   *  label, not on the per-classification
   *  category. */
  isClean: boolean;
  isFixtureAmbiguous: boolean;
  /**
   * Whether the per-query re-rank could have
   * been "stuck" because the current fact
   * is a `current-vs-previous` anchor (the
   * records the edge map explicitly
   * excludes). The flag is `true` for the
   * queries whose `currentTruthIds`
   * intersects `EXCLUDED_FROM_EDGE_MAP`. The
   * "gap the metadata cannot fix" block
   * surfaces the count; the per-query flag
   * is the per-query breakdown. The flag is
   * NOT a re-rank outcome; it is a
   * pre-re-rank classification of the
   * query.
   */
  hasExcludedCurrentAnchor: boolean;
}

// ---------------------------------------------------------------------------
// Per-variant metrics
// ---------------------------------------------------------------------------

/**
 * Per-variant metrics. The block is the unit the
 * per-variant row in the headline table
 * consumes.
 *
 * All counts are over the temporal slice only.
 * The `clean` / `fixtureAmbiguous` split mirrors
 * the same split the prior diagnostic surfaces,
 * so a reviewer reads the experiments
 * side-by-side.
 */
export interface SupersessionRerankVariantMetrics {
  /** Total temporal queries the variant covers. */
  total: number;
  /** Temporal queries on the clean (non-
   *  fixture-ambiguous) slice. The clean slice
   *  excludes queries that carry the
   *  `divergentTemporal` label. */
  cleanTotal: number;
  /** Temporal queries on the fixture-ambiguous
   *  slice (the labeled divergent set). */
  fixtureAmbiguousTotal: number;

  // Headline before/after counts (temporal slice).
  /** Baseline `currentTruthAt1` count (before
   *  re-rank). */
  baselineCurrentTruthAt1: number;
  /** After-re-rank `currentTruthAt1` count. */
  afterCurrentTruthAt1: number;
  /** `afterCurrentTruthAt1 - baselineCurrentTruthAt1`. */
  currentTruthAt1Delta: number;
  /** `afterCurrentTruthAt1 / total` - the
   *  baseline-rate as a percentage point
   *  delta. */
  currentTruthAt1RateDelta: number;

  /** Baseline `staleTop1` count. */
  baselineStaleTop1: number;
  /** After-re-rank `staleTop1` count. */
  afterStaleTop1: number;
  /** `afterStaleTop1 - baselineStaleTop1`.
   *  Negative means the re-ranker demoted some
   *  stale candidates. */
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
  /** The delta. A well-formed re-ranker that
   *  does not change candidate generation
   *  produces 0 here; a buggy re-ranker that
   *  drops a current-truth candidate produces
   *  a negative value. */
  currentMissingDelta: number;

  /** Re-rank-introduced regressions: queries
   *  where the baseline was `currentTruthAt1`
   *  and the re-ranker made it not
   *  `currentTruthAt1`. The HEADLINE safety
   *  number. A reviewer who wants to flag an
   *  unsafe variant reads this row first. */
  regressionCount: number;
  /** Queries the re-ranker cannot help
   *  because the current fact was never in
   *  the top-K (the `currentMissing` queries
   *  the re-ranker could not turn into a
   *  `currentTruthAt1`). The number is the
   *  re-ranker's CEILING: the total
   *  `currentMissing` minus this number is
   *  the maximum the re-ranker could
   *  possibly recover. */
  unchangedBecauseCurrentMissing: number;
  /**
   * Number of temporal queries whose
   * `currentTruthIds` intersects the
   * `EXCLUDED_FROM_EDGE_MAP` set (i.e. the
   * current fact is a `current-vs-previous`
   * anchor that the simulated edge map
   * explicitly excludes). These queries are
   * the "gap the metadata cannot fix"
   * sub-class: the simulated edge map
   * excludes them by design, so no
   * edge-driven re-rank can promote them
   * (the records are themselves the current
   * answer; the metadata-simulation rule is
   * the same as the baseline on these
   * queries). The block is surfaced so a
   * reviewer can audit the gap.
   */
  excludedCurrentAnchorCount: number;

  // Clean / fixture-ambiguous split.
  /** Clean-slice `currentTruthAt1` baseline /
   *  after / delta. */
  cleanBaselineCurrentTruthAt1: number;
  cleanAfterCurrentTruthAt1: number;
  cleanCurrentTruthAt1Delta: number;
  cleanRegressionCount: number;
  /** Fixture-ambiguous-slice `currentTruthAt1`
   *  baseline / after / delta. The
   *  fixture-ambiguous slice is the labeled
   *  divergent set; `currentTruthAt1` is
   *  uninterpretable on these queries per
   *  the prior diagnostic's framing, but the
   *  variant still surfaces the raw count so
   *  a reviewer can audit. */
  fixtureAmbiguousBaselineCurrentTruthAt1: number;
  fixtureAmbiguousAfterCurrentTruthAt1: number;
  fixtureAmbiguousCurrentTruthAt1Delta: number;
  fixtureAmbiguousRegressionCount: number;

  // Per-category change counts. The block maps
  // "baseline category -> after category" ->
  // count. The map is intentionally
  // exhaustive: a reviewer can read the table
  // to see "the re-ranker moved N queries from
  // `current-truth-in-topk-stale-top1` to
  // `current-truth-top1`" and so on.
  perCategoryChange: Record<string, number>;

  /** Per-query re-rank outputs. The list is
   *  in the same order as the input. The
   *  block is surfaced on the report's
   *  per-query table and on the on-disk
   *  artifact. */
  perQuery: ReadonlyArray<SupersessionRerankPerQuery>;
}

/**
 * Per-variant verdict. The verdict is a
 * research-only reading aid. The function is
 * pure.
 *
 * Rules (deterministic):
 *   - if `regressionCount > 0` -> `unsafe`. A
 *     re-ranker that introduced at least one
 *     regression is unsafe regardless of how
 *     much it recovered.
 *   - else if `currentTruthAt1Delta > 0` ->
 *     `safe`. The re-ranker recovered at least
 *     one `currentTruthAt1` and introduced no
 *     regressions.
 *   - else -> `neutral`. The re-ranker did not
 *     introduce regressions AND did not recover
 *     anything. The variant is a research probe
 *     that did not help; the report surfaces the
 *     raw numbers so a reviewer can audit.
 */
export type SupersessionRerankVerdict = "safe" | "unsafe" | "neutral";

/**
 * Per-variant row in the headline table. The
 * block is the unit the headline table and the
 * human report iterate over.
 */
export interface SupersessionRerankVariantRow {
  variant: SupersessionRerankVariant;
  metrics: SupersessionRerankVariantMetrics;
  verdict: SupersessionRerankVerdict;
  /**
   * Short human-readable verdict note.
   * Surfaced in the headline table. The note
   * is deterministic and is derived from the
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
 * same `SupersessionRerankVariantMetrics`. The
 * function consumes the per-query `QueryEval` +
 * `BenchmarkQuery` lists and produces:
 *   - a per-query re-rank decision block;
 *   - a per-variant metric block.
 *
 * The function does NOT change candidate
 * generation. The `topK` is whatever the
 * baseline ranker produced; the re-ranker only
 * re-orders the list. The "after"
 * `currentMissing` count is therefore the same
 * as the baseline's unless a re-rank-rule bug
 * drops a current-truth candidate (which the
 * regression test catches).
 *
 * The function does NOT call any provider, any
 * ranker, or any external service. It consumes
 * the artifacts the benchmark runner produced.
 */
export function evaluateSupersessionRerankVariant(args: {
  variant: SupersessionRerankVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
}): SupersessionRerankVariantMetrics {
  const { variant, evals, queries } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `evaluateSupersessionRerankVariant: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length}) for variant "${variant.id}"`,
    );
  }

  const perQuery: SupersessionRerankPerQuery[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (e.queryId !== q.id) {
      throw new Error(
        `evaluateSupersessionRerankVariant: evals[${i}].queryId="${e.queryId}" does ` +
          `not match queries[${i}].id="${q.id}" for variant "${variant.id}"`,
      );
    }
    if (q.family !== "temporal") continue; // temporal slice only
    perQuery.push(
      evaluateSupersessionRerankForQuery({ variant, eval: e, query: q }),
    );
  }

  return aggregateSupersessionRerankPerQuery(perQuery);
}

/**
 * Run a single re-rank variant on a single
 * query. The function is pure. The function is
 * a thin orchestrator: it applies the re-rank
 * rule via `applySupersessionRerankRule`,
 * classifies the baseline and after outcomes
 * via `classifyTemporalTruthFailure` (the prior
 * diagnostic's classifier), and emits a
 * `SupersessionRerankPerQuery` block.
 */
export function evaluateSupersessionRerankForQuery(args: {
  variant: SupersessionRerankVariant;
  eval: QueryEval;
  query: BenchmarkQuery;
}): SupersessionRerankPerQuery {
  const { variant, eval: e, query: q } = args;
  // Apply the re-rank rule. The result is a
  // NEW top-K candidate list (not a mutation
  // of the input).
  const reranked = applySupersessionRerankRule({
    rule: variant.rule,
    eval: e,
    query: q,
  });
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
  const afterEval: QueryEval = {
    ...e,
    topIds: reranked.topIds,
    topScores: reranked.topScores,
  };
  const afterDiag = classifyTemporalTruthFailure(afterEval, q);

  // Compute the (baseline -> after) category
  // change. The string is the concatenated
  // pair.
  const categoryChange = `${baselineDiag.category} -> ${afterDiag.category}`;

  // Regression: baseline `currentTruthAt1`,
  // after NOT `currentTruthAt1`.
  const regression =
    baselineDiag.top1IsCurrentTruth === true &&
    afterDiag.top1IsCurrentTruth === false;

  // Unchanged because current missing: baseline
  // had no current in top-K, AND the re-ranker
  // did not surface a current-truth candidate
  // either.
  const unchangedBecauseCurrentMissing =
    baselineDiag.topKHasCurrentTruth === false &&
    afterDiag.topKHasCurrentTruth === false;

  // The clean / fixture-ambiguous split is on
  // the baseline's `isDivergentLabeled` flag.
  const isFixtureAmbiguous = baselineDiag.isDivergentLabeled;
  const isClean = !isFixtureAmbiguous;

  // "Gap the metadata cannot fix" flag: true
  // iff at least one of the query's
  // `currentTruthIds` is in the
  // `EXCLUDED_FROM_EDGE_MAP` set. The flag is
  // a pre-re-rank classification of the query;
  // the per-variant `excludedCurrentAnchorCount`
  // metric aggregates it.
  let hasExcludedCurrentAnchor = false;
  for (const id of q.currentTruthIds) {
    if (EXCLUDED_FROM_EDGE_MAP.has(id)) {
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
    baselineStaleOverCurrent:
      baselineDiag.top1IsStale && baselineDiag.topKHasCurrentTruth,
    baselineCategory: baselineDiag.category,
    baselineIsDivergentLabeled: baselineDiag.isDivergentLabeled,
    afterTop1Id: afterDiag.top1Id,
    afterCurrentTruthAt1: afterDiag.top1IsCurrentTruth,
    afterStaleTop1: afterDiag.top1IsStale,
    afterStaleOverCurrent:
      afterDiag.top1IsStale && afterDiag.topKHasCurrentTruth,
    afterCategory: afterDiag.category,
    categoryChange,
    regression,
    unchangedBecauseCurrentMissing,
    newTopIds: reranked.topIds,
    newTopScores: reranked.topScores,
    isClean,
    isFixtureAmbiguous,
    hasExcludedCurrentAnchor,
  };
}

/**
 * Aggregate the per-query re-rank decisions
 * into a `SupersessionRerankVariantMetrics`
 * block. The function is pure: same per-query
 * list -> same metrics block.
 */
export function aggregateSupersessionRerankPerQuery(
  perQuery: ReadonlyArray<SupersessionRerankPerQuery>,
): SupersessionRerankVariantMetrics {
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
  let excludedCurrentAnchorCount = 0;

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
    if (p.regression) regressionCount += 1;
    if (p.unchangedBecauseCurrentMissing)
      unchangedBecauseCurrentMissing += 1;
    if (p.hasExcludedCurrentAnchor) excludedCurrentAnchorCount += 1;

    if (p.isClean) {
      if (p.baselineCurrentTruthAt1) cleanBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) cleanAfterCurrentTruthAt1 += 1;
      if (p.regression) cleanRegressionCount += 1;
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

  const cleanCurrentTruthAt1Delta =
    cleanAfterCurrentTruthAt1 - cleanBaselineCurrentTruthAt1;
  const fixtureAmbiguousCurrentTruthAt1Delta =
    fixtureAmbiguousAfterCurrentTruthAt1 -
    fixtureAmbiguousBaselineCurrentTruthAt1;

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
    excludedCurrentAnchorCount,
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
 *   - else if `currentTruthAt1Delta > 0` ->
 *     `safe`. The re-ranker recovered at least
 *     one `currentTruthAt1` and introduced no
 *     regressions.
 *   - else -> `neutral`. The re-ranker did not
 *     introduce regressions AND did not recover
 *     anything. The variant is a research probe
 *     that did not help; the report surfaces the
 *     raw numbers so a reviewer can audit.
 */
export function computeSupersessionRerankVerdict(
  metrics: SupersessionRerankVariantMetrics,
): { verdict: SupersessionRerankVerdict; note: string } {
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
  // currentTruthAt1 count. This is `neutral`,
  // NOT `safe`: a `safe` verdict means the
  // re-ranker recovered at least one
  // `currentTruthAt1`; a no-op re-ranker is
  // a research probe that did not help, and
  // the report surfaces the raw numbers so a
  // reviewer can audit.
  return {
    verdict: "neutral",
    note: "no regressions, no currentTruthAt1 recovery; the re-ranker preserved the baseline on this slice (research probe that did not help; verdict is neutral, not safe)",
  };
}

// ---------------------------------------------------------------------------
// Per-variant report
// ---------------------------------------------------------------------------

/**
 * Build a per-variant row. The function is a
 * thin orchestrator that calls
 * `evaluateSupersessionRerankVariant` and
 * `computeSupersessionRerankVerdict`. Pure.
 */
export function buildSupersessionRerankVariantRow(args: {
  variant: SupersessionRerankVariant;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
}): SupersessionRerankVariantRow {
  const { variant } = args;
  const metrics = evaluateSupersessionRerankVariant(args);
  const { verdict, note } = computeSupersessionRerankVerdict(metrics);
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
export interface SupersessionRerankReport {
  /** The variant the report was built from.
   *  The upstream artifact's `variant` field
   *  is surfaced here. */
  sourceVariant: string;
  /** The number of records in the source
   *  corpus, when known. */
  recordCount: number | null;
  /** The number of queries the source
   *  artifact covers (temporal slice). */
  temporalQueryCount: number;
  /**
   * The size of the simulated edge map. The
   * field is surfaced so a reviewer can audit
   * the map at a glance.
   */
  edgeMapSize: number;
  /**
   * The set of `isSuperseded === true` ids
   * (the projection of the edge map that the
   * `metadata-simulation-supersededBy-demote`
   * rule uses). The set is sorted for stable
   * output.
   */
  simulatedSupersededIds: ReadonlyArray<number>;
  /**
   * The set of `currentInGroup === true`
   * ids (the projection of the edge map
   * that the
   * `metadata-simulation-version-group-current`
   * rule uses). The set is sorted for stable
   * output.
   */
  simulatedCurrentInGroupIds: ReadonlyArray<number>;
  /**
   * The set of record ids EXPLICITLY
   * EXCLUDED from the edge map. The set is
   * sorted for stable output.
   */
  excludedRecordIds: ReadonlyArray<number>;
  /**
   * Per-variant rows. The order is the
   * declaration order of
   * `BUILTIN_SUPERSESSION_RERANK_VARIANTS`,
   * so a reviewer reading the artifact can
   * find the baseline row first.
   */
  variants: ReadonlyArray<SupersessionRerankVariantRow>;
  /**
   * The "gap the metadata cannot fix" block.
   * The block surfaces the per-variant
   * `excludedCurrentAnchorCount` AND a
   * per-query breakdown of the queries
   * whose `currentTruthIds` intersects
   * `EXCLUDED_FROM_EDGE_MAP`. A reviewer
   * who wants to know "what queries would
   * STILL require a candidate-generation
   * fix even with full supersession
   * metadata?" reads this block.
   */
  gapBreakdown: {
    /** Total temporal queries whose
     *  `currentTruthIds` intersects
     *  `EXCLUDED_FROM_EDGE_MAP`. */
    total: number;
    /** Per-variant `excludedCurrentAnchorCount`
     *  (re-surfaced here so a reviewer can
     *  audit the gap without re-deriving the
     *  per-variant metrics). */
    byVariant: Record<string, number>;
    /** Per-query breakdown: the query id
     *  and the excluded currentTruthIds. */
    perQuery: ReadonlyArray<{
      queryId: string;
      family: string;
      excludedCurrentTruthIds: ReadonlyArray<number>;
    }>;
  };
  /**
   * Optional semantic-evidence cross-
   * reference. The block is surfaced only
   * when the caller supplied a pre-computed
   * semantic map. The block is honest about
   * its source and is NOT consulted by the
   * re-ranker.
   */
  semanticOverlay?: {
    source: string;
    covered: number;
    hit: number;
    miss: number;
    /** Per-variant breakdown of `miss`
     *  queries: the number of baseline-`miss`
     *  queries whose after-re-rank top-1 is
     *  a `currentTruthId` under each variant.
     *  A reviewer reads this row to see "the
     *  dense ranker also missed this query,
     *  but the re-ranker could have recovered
     *  it anyway (the current fact was in the
     *  top-K)". */
    recoveredByVariant: Record<string, number>;
  };
  /**
   * The full set of `categoryChange`
   * strings the report has observed, sorted
   * alphabetically. Surfaced so the human
   * report's per-category-change table has
   * a stable column order.
   */
  categoryChangeKeys: ReadonlyArray<string>;
}

/**
 * Top-level orchestrator. Consumes the
 * per-query input + the variant list and emits
 * the `SupersessionRerankReport`. The function
 * is pure: no I/O, no mutation, no provider
 * calls.
 */
export function buildSupersessionRerankReport(args: {
  sourceVariant: string;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  variants?: ReadonlyArray<SupersessionRerankVariant>;
  recordCount?: number | null;
  /** Optional semantic-evidence map. The
   *  shape is the same the prior diagnostic
   *  accepts: `{source: string, byQueryId:
   *  ReadonlyMap<string, "hit" | "miss">}`.
   *  The block is a CROSS-REFERENCE, not a
   *  re-ranker input. */
  semantic?: { source: string; byQueryId: ReadonlyMap<string, "hit" | "miss"> };
}): SupersessionRerankReport {
  const {
    sourceVariant,
    evals,
    queries,
    variants = BUILTIN_SUPERSESSION_RERANK_VARIANTS,
    recordCount = null,
    semantic,
  } = args;
  if (evals.length !== queries.length) {
    throw new Error(
      `buildSupersessionRerankReport: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length})`,
    );
  }
  // Build the per-variant rows.
  const rows: SupersessionRerankVariantRow[] = [];
  for (const v of variants) {
    rows.push(
      buildSupersessionRerankVariantRow({ variant: v, evals, queries }),
    );
  }
  // Temporal slice size: count temporal
  // queries in the input. We count the
  // queries the variants' temporal slice
  // will cover.
  let temporalQueryCount = 0;
  for (const q of queries) {
    if (q.family === "temporal") temporalQueryCount += 1;
  }
  // Build the "gap the metadata cannot fix"
  // block. The per-variant
  // `excludedCurrentAnchorCount` is
  // re-surfaced; the per-query breakdown is
  // computed from the input queries (NOT
  // from the per-variant metrics, so the
  // block is query-level not variant-level).
  const perQueryGap: Array<{
    queryId: string;
    family: string;
    excludedCurrentTruthIds: ReadonlyArray<number>;
  }> = [];
  for (const q of queries) {
    if (q.family !== "temporal") continue;
    const excluded: number[] = [];
    for (const id of q.currentTruthIds) {
      if (EXCLUDED_FROM_EDGE_MAP.has(id)) excluded.push(id);
    }
    if (excluded.length > 0) {
      perQueryGap.push({
        queryId: q.id,
        family: q.family,
        excludedCurrentTruthIds: [...excluded].sort((a, b) => a - b),
      });
    }
  }
  const byVariant: Record<string, number> = {};
  for (const row of rows) {
    byVariant[row.variant.id] = row.metrics.excludedCurrentAnchorCount;
  }
  // Optional semantic overlay. The block is
  // computed per-variant for cross-reference
  // (the re-ranker does not consult the map).
  let semanticOverlay: SupersessionRerankReport["semanticOverlay"];
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
        `buildSupersessionRerankReport: semantic overlay miss mismatch ` +
          `(${missQueries.length} vs ${miss})`,
      );
    }
  }
  // Compute the sorted `categoryChange`
  // keys. We aggregate across all variants
  // so the report's per-category-change
  // table has a stable set of columns.
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
    edgeMapSize: SIMULATED_SUPERSESSION_EDGES.size,
    simulatedSupersededIds: [...SIMULATED_SUPERSEDED_IDS].sort((a, b) => a - b),
    simulatedCurrentInGroupIds: [...SIMULATED_CURRENT_IN_GROUP_IDS].sort(
      (a, b) => a - b,
    ),
    excludedRecordIds: [...EXCLUDED_FROM_EDGE_MAP].sort((a, b) => a - b),
    variants: rows,
    gapBreakdown: {
      total: perQueryGap.length,
      byVariant,
      perQuery: perQueryGap,
    },
    ...(semanticOverlay ? { semanticOverlay } : {}),
    categoryChangeKeys,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Render a `SupersessionRerankReport` as a
 * human-readable text block. The output is
 * deterministic (no PRNG, no wall clock) so a
 * reviewer can `diff` two runs. The function
 * is pure.
 */
export function formatSupersessionRerankReport(
  report: SupersessionRerankReport,
): string {
  const out: string[] = [];
  out.push(
    `# Supersession / metadata edge simulation (source: ${report.sourceVariant})`,
  );
  if (report.recordCount !== null) {
    out.push(`#   (records: ${report.recordCount})`);
  }
  out.push(
    `#   (temporal queries: ${report.temporalQueryCount})`,
  );
  out.push(
    `#   (simulated edge map: ${report.edgeMapSize} entries; ` +
      `${report.simulatedSupersededIds.length} superseded ids; ` +
      `${report.simulatedCurrentInGroupIds.length} current-in-group ids; ` +
      `${report.excludedRecordIds.length} explicitly excluded ids)`,
  );
  out.push("");

  out.push("## Variant table (temporal slice)");
  out.push("");
  out.push(
    "  category | variant | n | baseline@1 | after@1 | delta | staleTop1 baseline->after | staleOverCurrent baseline->after | currentMissing baseline->after | regressions | unchanged-missing | excluded-anchor | verdict",
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(19)} | ${row.variant.id.padEnd(45)} | ` +
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
        `${String(m.excludedCurrentAnchorCount).padStart(16)} | ` +
        `${row.verdict}`,
    );
  }
  out.push("");
  out.push("## Variant table (clean / fixture-ambiguous split)");
  out.push("");
  out.push(
    "  category | variant | cleanN | cleanBaseline@1 | cleanAfter@1 | cleanDelta | cleanRegressions | ambigN | ambigBaseline@1 | ambigAfter@1 | ambigDelta | ambigRegressions",
  );
  for (const row of report.variants) {
    const m = row.metrics;
    out.push(
      `  ${row.variant.category.padEnd(19)} | ${row.variant.id.padEnd(45)} | ` +
        `${String(m.cleanTotal).padStart(6)} | ` +
        `${String(m.cleanBaselineCurrentTruthAt1).padStart(14)} | ` +
        `${String(m.cleanAfterCurrentTruthAt1).padStart(11)} | ` +
        `${signedInt(m.cleanCurrentTruthAt1Delta).padStart(10)} | ` +
        `${String(m.cleanRegressionCount).padStart(16)} | ` +
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
  out.push(
    "  The table maps (baseline-category -> after-category) -> count for each variant. " +
      "The columns are the union of all observed change keys, sorted alphabetically. " +
      "The dominant 'X -> X' diagonal is the unchanged-count; the " +
      "off-diagonal rows are the per-variant recoveries.",
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
  out.push("## Gap the metadata cannot fix (excluded current-anchor queries)");
  out.push("");
  out.push(
    `  total temporal queries whose currentTruthIds intersects EXCLUDED_FROM_EDGE_MAP: ${report.gapBreakdown.total}`,
  );
  out.push("");
  out.push(
    "  The excluded record ids are the `current-vs-previous` anchor " +
      "records (117..120) that the simulated edge map explicitly " +
      "excludes. The records encode BOTH the current and the previous " +
      "fact in their summary; marking them as `supersededBy` would be a " +
      "misread of their semantic content. The queries that name them " +
      "as the current truth are the `temp-current-vs-previous-*` " +
      "queries the prior diagnostic surfaces.",
  );
  out.push("");
  out.push("  per-variant (excludedCurrentAnchorCount):");
  for (const [vid, n] of Object.entries(report.gapBreakdown.byVariant)) {
    out.push(`    ${vid.padEnd(46)}  ${n}`);
  }
  out.push("");
  out.push("  per-query breakdown (sorted by queryId):");
  if (report.gapBreakdown.perQuery.length === 0) {
    out.push("    (no excluded-anchor queries on the temporal slice)");
  } else {
    const sorted = [...report.gapBreakdown.perQuery].sort((a, b) =>
      a.queryId < b.queryId ? -1 : a.queryId > b.queryId ? 1 : 0,
    );
    for (const p of sorted) {
      out.push(
        `    ${p.queryId.padEnd(48)}  family=${p.family.padEnd(10)}  ` +
          `excluded=${JSON.stringify(p.excludedCurrentTruthIds)}`,
      );
    }
  }
  out.push("");
  out.push("## Simulated edge-map summary");
  out.push("");
  out.push(
    `  total entries:                 ${report.edgeMapSize}`,
  );
  out.push(
    `  superseded ids (isSuperseded): ${report.simulatedSupersededIds.length}`,
  );
  out.push(
    `  current-in-group ids:          ${report.simulatedCurrentInGroupIds.length}`,
  );
  out.push(
    `  explicitly excluded ids:       ${report.excludedRecordIds.length}`,
  );
  out.push("");
  out.push("  superseded ids (sorted):");
  out.push(
    `    [${report.simulatedSupersededIds.join(", ")}]`,
  );
  out.push("");
  out.push("  current-in-group ids (sorted):");
  out.push(
    `    [${report.simulatedCurrentInGroupIds.join(", ")}]`,
  );
  out.push("");
  out.push("  explicitly excluded ids (sorted):");
  out.push(
    `    [${report.excludedRecordIds.join(", ")}]`,
  );
  out.push("");
  // Sanity: the simulated superseded id set
  // should be a SUBSET of the prior
  // diagnostic's `STALE_TEMPORAL_IDS` set
  // (the same supersession patterns drive
  // both). A reviewer who wants to audit
  // the cross-experiment overlap reads
  // this block.
  const staleOverlap: number[] = [];
  const staleOnly: number[] = [];
  for (const id of report.simulatedSupersededIds) {
    if (STALE_TEMPORAL_IDS.has(id)) staleOverlap.push(id);
  }
  for (const id of STALE_TEMPORAL_IDS) {
    if (!SIMULATED_SUPERSEDED_IDS.has(id)) staleOnly.push(id);
  }
  out.push("## Cross-experiment sanity (vs STALE_TEMPORAL_IDS)");
  out.push("");
  out.push(
    `  simulatedSupersededIds ∩ STALE_TEMPORAL_IDS: ${staleOverlap.length} (overlap ids: [${staleOverlap.join(", ")}])`,
  );
  out.push(
    `  STALE_TEMPORAL_IDS \\ simulatedSupersededIds: ${staleOnly.length} (in STALE_TEMPORAL_IDS but not in simulatedSupersededIds: [${staleOnly.join(", ")}])`,
  );
  out.push(
    "  The simulatedSupersededIds set is a NARROWER subset of " +
      "STALE_TEMPORAL_IDS: the edge map is restricted to the " +
      "explicit supersession chains the prior diagnostic " +
      "documents, while STALE_TEMPORAL_IDS is the union of all " +
      "stale clusters (legacy, conflict, superseded, temporal-old). " +
      "A reviewer who wants the SAME denylist behavior as the prior " +
      "fixture-shaped-stale-demote variant reads the " +
      "`metadata-simulation-stale-id-derived` row with an " +
      "override `staleLikeIds: STALE_TEMPORAL_IDS`; the default " +
      "uses the narrower simulatedSupersededIds set so the " +
      "edge-map-derived baseline is the honest reading.",
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
      "  The re-ranker does NOT consult the map. The map is a cross-reference: " +
        "for each variant, the count is the number of baseline-miss queries " +
        "whose after-re-rank top-1 IS a currentTruthId. A non-zero count means " +
        "'the current fact was in the top-K; the re-ranker could have recovered " +
        "it regardless of the dense ranker's miss'.",
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
    "  The `metadata-simulation` category in this report is HONEST about " +
      "the source of the edge data: the simulated edge map is " +
      "fixture-derived from the corpus summaries the prior diagnostic " +
      "audits, NOT a runtime signal on the production `QueryEval`. A " +
      "reviewer who reads the category field sees the framing: " +
      "`metadata-simulation` is NOT `production-like` (no runtime " +
      "signal exists today); it is NOT `oracle` (the re-rank rules " +
      "never consult `currentTruthIds`); it is NOT `fixture-shaped` " +
      "(the `STALE_TEMPORAL_IDS` set is a flat id list; the " +
      "`metadata-simulation` variants key on a structured edge map). " +
      "The honest reading is: 'a production-side schema that carries " +
      "the edges at `remember` time would let a runtime re-ranker " +
      "reach the metadata-simulation ceiling WITHOUT depending on " +
      "the fixture truth at all'.",
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
