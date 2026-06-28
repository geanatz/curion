/**
 * Held-out query slice for the benchmark-only
 * prospective future-shift validation experiment.
 *
 * This file is a STRICT ADDITION to the existing
 * `BENCHMARK_QUERIES` (the 176-query dev set defined in
 * `src/benchmark/queries.ts`). The held-out queries are
 * hand-curated to:
 *
 *   1. Have unique ids that do not collide with the
 *      dev set (every id here is prefixed `held-`).
 *   2. Target the SAME 132-record / 176-query corpus
 *      the dev set targets — this is the "frozen
 *      policy, future-shift queries, same corpus" the
 *      architect advisory calls out as v1 of the
 *      held-out validation. The held-out queries
 *      deliberately do NOT add or remove any records.
 *   3. Cover all six families (exact / paraphrase /
 *      temporal / multi-hop / no-answer / orientation)
 *      and the residual-risk cases the architect brief
 *      names explicitly:
 *
 *        - paraphrase variants (deep / adversarial)
 *        - false-premise / no-answer near known clusters
 *        - analogues of the previous false-negatives
 *          (`nonexistent-staging-access`,
 *          `nonexistent-flink-pipeline`)
 *
 *      The held-out set is treated as a FROZEN
 *      prospective slice: the policy evaluator
 *      consumes it without tuning. The brief is
 *      explicit: "frozen policy, future-shift,
 *      held-out" — we do not retroactively split the
 *      existing 176 dev queries, and we do not tune
 *      the policies on the held-out results.
 *
 * What this file IS:
 *   - A SECOND `BenchmarkQuery[]` array, exported as
 *     `HELD_OUT_QUERIES`.
 *   - Sized for a meaningful future-shift probe
 *     (28 queries; the brief's target is ~24-40).
 *   - Honest: every held-out query has explicit
 *     `expectedIds` / `currentTruthIds` and a `note`
 *     explaining the residual risk it covers.
 *   - Optional `labels` for queries that map to a
 *     labeled adversarial property (the same labels
 *     the dev set uses).
 *
 * What this file IS NOT:
 *   - Not a retraining set. The policies are FROZEN.
 *   - Not a production import. The held-out queries
 *     are only consumed by the held-out validation
 *     runner; the production `recall(text)` controller
 *     never reads this file.
 *   - Not a fixture for the production benchmark.
 *     The dev set is still `BENCHMARK_QUERIES`.
 *
 * Scope (benchmark-only):
 *   This module is read-only and never modifies the
 *   production `recall(text)` behavior, the public
 *   MCP API, or the existing dev-set / audit /
 *   calibration / policy report shapes. The
 *   `buildHeldOutReport` runner (in
 *   `src/benchmark/held-out-validation.ts`) consumes
 *   this array and emits a SEPARATE artifact with the
 *   `retrieval-held-out-validation-*.json` prefix.
 *
 * Honest caveats:
 *   - Same-corpus validation: the held-out queries
 *     share the 132-record corpus with the dev set.
 *     A reviewer who interprets a positive transfer
 *     delta as "the policy generalises to a new
 *     corpus" is over-reading the result. The right
 *     reading is "the policy does not over-fit to
 *     the dev set's specific query phrasing".
 *   - Frozen policy: the threshold / flag
 *     combinations in `BUILTIN_POLICIES` are NOT
 *     tuned on the held-out results. A future
 *     experiment that re-tunes them would invalidate
 *     the v1 contract.
 *   - The held-out set is small (28 queries). The
 *     headline numbers carry 1-query granularity; a
 *     1-query swing on a small family is a 3-4 pp
 *     swing on the rate. The "honest reading" block
 *     in the human report surfaces this.
 */

import type { BenchmarkQuery } from "./queries.js";

// ---------------------------------------------------------------------------
// Held-out query slice
// ---------------------------------------------------------------------------

/**
 * The held-out query set. The order is the order
 * the runner iterates in; the on-disk artifact
 * follows the same order so byte-stable
 * comparisons remain meaningful.
 *
 * Family distribution (28 queries):
 *   - exact:        4
 *   - paraphrase:   6  (3 normal, 3 deep / adversarial)
 *   - temporal:     4
 *   - multi-hop:    4
 *   - no-answer:    6
 *   - orientation:  4
 *
 * The exact / paraphrase / temporal counts are
 * tuned so the held-out set has enough positive
 * queries to make the "transferred hit@5 retained"
 * metric meaningful on the small sample. The
 * no-answer count is tuned to give the flag-only
 * baseline room to expose its TNR delta honestly.
 */
export const HELD_OUT_QUERIES: BenchmarkQuery[] = [
  // -------------------------------------------------------------------------
  // Family: exact (4) — verbatim-ish token overlap,
  // freshly authored. The held-out exact queries
  // deliberately target different records than the
  // dev set's exact queries to expose "did the
  // ranker learn the dev set's records?" over-fit.
  // -------------------------------------------------------------------------
  {
    id: "held-exact-fs-wal-mode",
    family: "exact",
    query: "What journaling mode does the SQLite file use?",
    expectedIds: [77],
    currentTruthIds: [77],
    note: "Held-out exact. Targets record 77 (data-pipeline WAL) which the dev set's exact queries do not probe directly. A held-out exact miss is a strong signal of dev-set over-fit (the ranker should still find 77 from a verbatim-ish query).",
  },
  {
    id: "held-exact-fs-tls-version",
    family: "exact",
    query: "What TLS version is required for provider traffic?",
    expectedIds: [71],
    currentTruthIds: [71],
    note: "Held-out exact. Targets record 71 (security-extensions TLS 1.2+). The dev set has no exact query on TLS; the held-out probe isolates the ranker's verbatim coverage on a cluster it has not been explicitly probed against.",
  },
  {
    id: "held-exact-fs-coverage-gate",
    family: "exact",
    query: "What coverage drop on changed lines fails the merge gate?",
    expectedIds: [126],
    currentTruthIds: [126],
    note: "Held-out exact. Targets record 126 (orientation-extension coverage gate). The threshold (1 percentage point) is the verbatim answer; the ranker should retrieve record 126 on the exact-token query.",
  },
  {
    id: "held-exact-fs-feature-flags-source",
    family: "exact",
    query: "Which environment variable carries the feature flag list?",
    expectedIds: [85],
    currentTruthIds: [85],
    note: "Held-out exact. Targets record 85 (feature-flags env var CURION_FEATURE_FLAGS). The env-var name is the verbatim answer; the dev set has no exact query for the feature-flags cluster.",
  },

  // -------------------------------------------------------------------------
  // Family: paraphrase (6) — paraphrases deliberately
  // chosen for low lexical overlap with the target
  // record. The held-out paraphrase set is
  // heavier on the "deep" / "adversarial" style the
  // architect brief calls out as residual risk.
  // -------------------------------------------------------------------------
  {
    id: "held-para-fs-rolling-restart-vocab",
    family: "paraphrase",
    query: "How do we bring up the new code without taking the service down?",
    expectedIds: [8],
    currentTruthIds: [8],
    note: "Held-out paraphrase. Targets record 8 (rolling restarts preferred over hard cuts). The query uses 'bring up the new code' / 'without taking down' instead of 'rolling restart' / 'hard cut'. Tests whether the ranker recovers the right cluster on a paraphrase that swaps the production-control vocabulary for an end-user framing.",
  },
  {
    id: "held-para-fs-adr-vocab",
    family: "paraphrase",
    query: "Where do we write down the rationale for a big technical choice?",
    expectedIds: [12],
    currentTruthIds: [12],
    note: "Held-out paraphrase. Targets record 12 (architecture decisions / ADRs). The query uses 'write down' / 'rationale' / 'big technical choice' instead of 'architectural decision' / 'ADR'. Tests paraphrase coverage on the docs cluster.",
  },
  {
    id: "held-para-fs-conflict-vocab",
    family: "paraphrase",
    query: "When two saved notes disagree, what state marks the older one as out of play?",
    expectedIds: [46, 80],
    currentTruthIds: [46, 80],
    note: "Held-out paraphrase. Targets records 46 (memory state machine: active / superseded / invalidated) and 80 (soft-delete / state=invalidated). The query uses 'disagree' / 'out of play' instead of 'conflict' / 'invalidated' / 'supersede'. Deep paraphrase: two hops of vocabulary swap on the entity-domain and data-pipeline clusters.",
  },
  {
    id: "held-para-fs-redaction-vocab",
    family: "paraphrase",
    query: "Do authorization headers ever get written into the failure log?",
    expectedIds: [67],
    currentTruthIds: [67],
    note: "Held-out deep paraphrase. Targets record 67 (Authorization / Bearer header redaction). The query is phrased as a yes/no question (do they EVER) instead of the record's 'are redacted' wording. The negation-style phrasing inverts the polarity; the answer is 'no, they are redacted'.",
  },
  {
    id: "held-para-fs-bridge-vocab",
    family: "paraphrase",
    query: "What's the connection between audit retention and the weekly on-call note?",
    expectedIds: [129],
    currentTruthIds: [129],
    note: "Held-out adversarial paraphrase. Targets record 129 (audit retention + on-call digest bridge). The query uses 'connection' / 'weekly on-call note' instead of 'CURION_AUDIT_RETENTION_DAYS' / 'Monday morning at 9:00 local time'. This is the multi-hop-bridge cluster; the query deliberately avoids both anchor words to test the ranker's bridge-finding on a paraphrase surface.",
  },
  {
    id: "held-para-fs-cipher-vocab",
    family: "paraphrase",
    query: "How are secrets protected when they sit in process memory?",
    expectedIds: [29],
    currentTruthIds: [29],
    note: "Held-out deep paraphrase. Targets record 29 (API keys read from environment variables only, never written to disk). The query uses 'protected' / 'sit in process memory' instead of 'never persisted' / 'environment variables'. Tests the ranker's paraphrase coverage on the security cluster.",
  },

  // -------------------------------------------------------------------------
  // Family: temporal (4) — current-fact-expected
  // queries that target record pairs the dev set
  // does NOT cover. The held-out temporal set
  // deliberately uses different vocabulary from the
  // dev set's temporal queries so the ranker cannot
  // cheat on memorised dev-set phrasing.
  // -------------------------------------------------------------------------
  {
    id: "held-temp-fs-stdio-current",
    family: "temporal",
    query: "What's the current process model for the MCP transport?",
    expectedIds: [73],
    currentTruthIds: [73],
    note: "Held-out temporal. Targets record 73 (agent-runtime single-process stdio). The query uses 'current' / 'process model' instead of the dev set's 'now' / 'transport'. The agent-runtime cluster is a new cluster the dev set has only probed via 'multi' queries; the held-out probe checks the ranker's 'current-fact' coverage on a fresh cluster.",
  },
  {
    id: "held-temp-fs-coverage-current",
    family: "temporal",
    query: "What's the current nightly job in CI?",
    expectedIds: [125],
    currentTruthIds: [125],
    note: "Held-out temporal. Targets record 125 (orientation-extension nightly benchmark). The query is a fresh phrasing of the 'nightly CI job' fact; the dev set's temporal queries do not probe the orientation-extension cluster. Tests temporal coverage on a brand-new cluster.",
  },
  {
    id: "held-temp-fs-redaction-current",
    family: "temporal",
    query: "How is the current redaction policy applied to error output?",
    expectedIds: [67],
    currentTruthIds: [67],
    note: "Held-out temporal. Targets record 67 (Authorization / Bearer redaction). The query uses 'current' / 'applied to error output' instead of the dev set's per-record phrasing. The 'current' framing is the temporal signal; the 'error output' is the paraphrase surface.",
  },
  {
    id: "held-temp-fs-feature-flags-current",
    family: "temporal",
    query: "What's the current default feature flag set?",
    expectedIds: [86],
    currentTruthIds: [86],
    note: "Held-out temporal. Targets record 86 (default-empty feature flag set). The query uses 'current default' instead of the dev set's per-record phrasing. The held-out set does not pair this with a 'previous' anchor (the corpus has no explicit feature-flag-history record), so the temporal signal is the 'current' token alone — a milder test than the dev set's explicit old/new temporal pairs.",
  },

  // -------------------------------------------------------------------------
  // Family: multi-hop (4) — answer requires joining
  // multiple memories. The held-out multi-hop
  // queries deliberately target the multi-hop-
  // bridge cluster (records 129-132) and the
  // feature-flag / client-sdk / data-pipeline
  // clusters the dev set's multi-hop queries do
  // not probe.
  // -------------------------------------------------------------------------
  {
    id: "held-multi-fs-bridge-stdio",
    family: "multi-hop",
    query: "What is the relation between the stdio transport and the log channel?",
    expectedIds: [132],
    currentTruthIds: [132],
    note: "Held-out multi-hop. Targets record 132 (MCP stdio / stderr bridge). The query asks for the relation between two concepts the dev set's multi-hop queries do not join. The single expected id is the bridge record.",
  },
  {
    id: "held-multi-fs-bridge-cache",
    family: "multi-hop",
    query: "How do the recall limit and the provider response cache interact?",
    expectedIds: [131],
    currentTruthIds: [131],
    note: "Held-out multi-hop. Targets record 131 (recall limit + provider cache bridge). The query asks about the relation between two cluster 19 / cluster 21 concepts; the bridge record is the only record that links them.",
  },
  {
    id: "held-multi-fs-feature-flags-verbose",
    family: "multi-hop",
    query: "What gates the verbose summary in the remember tool?",
    expectedIds: [88, 86],
    currentTruthIds: [88, 86],
    note: "Held-out multi-hop. Targets records 88 (verbose-summary feature flag) and 86 (default-empty feature flag set). The query requires a feature-flag cluster record (88) and the rollout-policy record (86) to answer fully; the dev set has no multi-hop query on the feature-flags cluster.",
  },
  {
    id: "held-multi-fs-data-pipeline-backup",
    family: "multi-hop",
    query: "How are database backups rotated and what journal mode is used?",
    expectedIds: [78, 77],
    currentTruthIds: [78, 77],
    note: "Held-out multi-hop. Targets records 78 (nightly backups, weekly rotation, 7 kept) and 77 (WAL mode). The query requires both halves of the data-pipeline cluster to answer; the dev set's multi-hop queries do not probe this cluster.",
  },

  // -------------------------------------------------------------------------
  // Family: no-answer (6) — no relevant memory in
  // the corpus. The held-out no-answer set is the
  // headline RESIDUAL-RISK coverage: it includes
  // analogues of the previous false-negatives
  // (`nonexistent-staging-access`,
  // `nonexistent-flink-pipeline`) and false-premise
  // / hard-negative cases the dev set's no-answer
  // queries do not probe.
  // -------------------------------------------------------------------------
  {
    id: "held-noanswer-fs-analogue-staging-access",
    family: "no-answer",
    query: "How do I get access to the staging environment's secret keys?",
    expectedIds: [],
    currentTruthIds: [],
    note: "Held-out no-answer, analogue of the dev set's `nonexistent-staging-access` false-negative. The query mentions 'staging' (a real cluster) and 'access' / 'secret keys' (tools the corpus does not name). It is designed to be confabulation pressure: the ranker is likely to surface staging / security records with high mean contributor score, and the query-shape detector's curated false-premise token list does not include 'secret keys'. A held-out miss here mirrors the dev-set FN pattern.",
    labels: ["hardNegative"],
  },
  {
    id: "held-noanswer-fs-analogue-flink-pipeline",
    family: "no-answer",
    query: "Does the Flink pipeline consume the recall response stream?",
    expectedIds: [],
    currentTruthIds: [],
    note: "Held-out no-answer, analogue of the dev set's `nonexistent-flink-pipeline` false-negative. The query mentions 'Flink' (a tool the corpus does not use; record 123 is the false-premise anchor for Kafka, a sibling near-miss). The phrase 'recall response stream' shares tokens with the agent-runtime cluster, so the ranker may confabulate. A held-out miss here mirrors the dev-set FN pattern.",
    labels: ["hardNegative"],
  },
  {
    id: "held-noanswer-fs-fp-near-sidecar",
    family: "no-answer",
    query: "What is the role of the OTel sidecar for the MCP server?",
    expectedIds: [],
    currentTruthIds: [],
    note: "Held-out no-answer, false-premise near the observability cluster. The query mentions 'OTel sidecar' (a near-miss tool the corpus does not name; record 121 is the false-premise anchor for vector-exporter, a sibling sidecar). A held-out retention is a true positive: the ranker should abstain.",
    labels: ["falsePremise", "hardNegative"],
  },
  {
    id: "held-noanswer-fs-fp-near-events",
    family: "no-answer",
    query: "Does the project publish a Pulsar event topic for cross-process notifications?",
    expectedIds: [],
    currentTruthIds: [],
    note: "Held-out no-answer, false-premise near the data-pipeline cluster. The query mentions 'Pulsar event topic' (a near-miss tool the corpus does not name; record 123 is the false-premise anchor for Kafka, a sibling event bus). A held-out retention is a true positive: the ranker should abstain.",
    labels: ["falsePremise", "hardNegative"],
  },
  {
    id: "held-noanswer-fs-easy-zero-overlap",
    family: "no-answer",
    query: "Where is the team's annual offsite retreat?",
    expectedIds: [],
    currentTruthIds: [],
    note: "Held-out no-answer, zero-overlap easy case. The query is about a topic the corpus does not cover; the ranker should return an empty top-K. A held-out retention is a true positive at the flag-only baseline; a held-out hit is a confabulation.",
  },
  {
    id: "held-noanswer-fs-negation-shape",
    family: "no-answer",
    query: "Why doesn't the project use a CDN for static assets?",
    expectedIds: [],
    currentTruthIds: [],
    note: "Held-out no-answer, negation-shaped. The query asserts a missing tool (CDN) the corpus does not name and uses a negation token ('doesn't') to flip the polarity. The query-shape detector should fire `isFalsePremiseLike`; a held-out retention is a true positive on the flag-only baseline.",
    labels: ["negation", "falsePremise"],
  },

  // -------------------------------------------------------------------------
  // Family: orientation (4) — project-status queries.
  // The held-out orientation set deliberately
  // targets the orientation-extension cluster
  // (records 125-128) and the multi-hop-bridge
  // cluster (records 129-132) — clusters the dev
  // set's orientation queries do not probe.
  // -------------------------------------------------------------------------
  {
    id: "held-orient-fs-ci-nightly-benchmark",
    family: "orientation",
    query: "What does the nightly CI job do and where is the badge published?",
    expectedIds: [125],
    currentTruthIds: [125],
    note: "Held-out orientation. Targets record 125 (nightly benchmark / status badge in README). The query uses 'nightly' / 'badge' vocabulary the dev set's orientation queries do not probe. Tests the ranker's orientation coverage on the orientation-extension cluster.",
  },
  {
    id: "held-orient-fs-ci-no-skip",
    family: "orientation",
    query: "What is the current policy on skipped tests on the default branch?",
    expectedIds: [127],
    currentTruthIds: [127],
    note: "Held-out orientation. Targets record 127 (deterministic no-skip invariant). The query uses 'current policy' / 'skipped tests' vocabulary. The dev set's orientation queries do not probe the no-skip invariant; the held-out probe isolates the ranker's coverage on a fresh orientation target.",
  },
  {
    id: "held-orient-fs-bridge-audit-digest",
    family: "orientation",
    query: "What's the current state of the audit-to-digest bridge?",
    expectedIds: [129],
    currentTruthIds: [129],
    note: "Held-out orientation. Targets record 129 (audit retention + on-call digest bridge). The query uses 'current state' / 'bridge' vocabulary; the dev set's orientation queries do not probe the multi-hop-bridge cluster.",
  },
  {
    id: "held-orient-fs-stdio-bridge",
    family: "orientation",
    query: "What does the project do about the stdio and stderr contract today?",
    expectedIds: [132],
    currentTruthIds: [132],
    note: "Held-out orientation. Targets record 132 (stdio / stderr bridge). The query uses 'today' (a temporal-current token) to test the orientation family's current-fact coverage on a multi-hop-bridge record.",
  },
];

// ---------------------------------------------------------------------------
// Sanity helpers (consumed by the held-out validation runner + tests)
// ---------------------------------------------------------------------------

/**
 * The minimum coverage the held-out set guarantees
 * per family. The runner + the test surface assert
 * the held-out set is at-or-above these floors. A
 * future expansion is free to grow any family; a
 * contraction below these floors is a deliberate,
 * visible change.
 */
export const HELD_OUT_MIN_FAMILY_COUNTS: Readonly<Record<string, number>> = {
  exact: 4,
  paraphrase: 6,
  temporal: 4,
  "multi-hop": 4,
  "no-answer": 6,
  orientation: 4,
};

/**
 * The minimum no-answer count the held-out set
 * guarantees. Pinned separately so a future
 * contraction that drops no-answer queries to 0
 * (which would make the TNR metric uninformative)
 * is a deliberate, visible change.
 */
export const HELD_OUT_MIN_NO_ANSWER_COUNT = 6;

/**
 * The total count of the held-out set. The brief
 * targets ~24-40 queries; the runner asserts the
 * held-out set is at-or-above the floor (24) and
 * is in the meaningful range for a prospective
 * probe.
 */
export const HELD_OUT_TOTAL_COUNT = HELD_OUT_QUERIES.length;

/**
 * The list of query ids the held-out set uses, in
 * declaration order. Surfaced on the artifact so a
 * reviewer can re-derive the held-out slice by
 * id-set intersection.
 */
export const HELD_OUT_QUERY_IDS: ReadonlyArray<string> = HELD_OUT_QUERIES.map((q) => q.id);
