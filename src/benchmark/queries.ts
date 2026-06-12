/**
 * Retrieval benchmark query corpus.
 *
 * Each query has:
 *   - `id`           — stable string id, used in failure reports.
 *   - `family`       — one of the families below. Used for the
 *                      per-family breakdown metric.
 *   - `query`        — the text we hand to the ranker. This is the
 *                      "user query" the harness simulates.
 *   - `expectedIds`      — the memory ids that a correct
 *                          retrieval should include in the top-K.
 *                          For `family: "no-answer"`, this list is
 *                          empty. A retrieval is correct if its
 *                          top-K contains AT LEAST ONE of the
 *                          expected ids for positive families, and
 *                          if its top-K is EMPTY for `no-answer`
 *                          queries.
 *   - `currentTruthIds`  — the memory ids that represent the
 *                          CURRENT truth for this query. For
 *                          non-temporal families this is the same
 *                          as `expectedIds` (the "right" answer
 *                          is always the current one). For most
 *                          `temporal` queries it is also the same
 *                          as `expectedIds` — the expected id IS
 *                          the current fact, and the old fact is
 *                          a known distractor. A small labeled
 *                          set of `temporal` queries deliberately
 *                          has `expectedIds` containing both the
 *                          old and the new fact, with
 *                          `currentTruthIds` containing only the
 *                          new fact; this makes the
 *                          `currentTruth` diagnostic meaningful
 *                          for the "did the ranker rank the
 *                          current fact above the old one?"
 *                          question. The field is kept separate
 *                          from `expectedIds` so the stricter
 *                          "current-truth@1" metric is a labeled,
 *                          first-class concept in the data:
 *                          temporal gaps are visible without
 *                          needing a separate query type.
 *   - `note`             — short human description of what the
 *                          query is testing.
 *
 * Families:
 *
 *   - "exact"                  — exact technical term recall. The
 *                                query shares most of its content
 *                                tokens verbatim with a record.
 *                                This is the easy case for the
 *                                lexical baseline.
 *
 *   - "paraphrase"             — paraphrase recall. The query uses
 *                                different words than the record
 *                                for the same idea. The lexical
 *                                baseline is expected to fail or
 *                                partially pass; this family
 *                                measures how brittle the
 *                                token-overlap approach is.
 *
 *   - "temporal"               — supersession / temporal-style
 *                                query. The query asks about the
 *                                "current" fact; the corpus has
 *                                both an old and a new record, and
 *                                the expected id (and
 *                                `currentTruthIds`) is the NEW one.
 *                                The lexical baseline has no
 *                                temporal signal and is expected
 *                                to FAIL at rank-1: it will
 *                                frequently return the OLD fact
 *                                at the top of the list. The
 *                                hit@K contract still treats these
 *                                as a hit if the new fact
 *                                appears anywhere in the top-K, but
 *                                the new rank-1 / current-truth@1
 *                                metric makes the gap visible in
 *                                the headline number.
 *
 *   - "multi-hop"              — multi-hop synthesis candidate
 *                                retrieval. The query requires
 *                                pulling together multiple memory
 *                                ids to answer. We expect the
 *                                top-K to contain at least one of
 *                                the relevant ids; "complete"
 *                                coverage is not required to count
 *                                as a hit, since the lexical
 *                                baseline is only doing candidate
 *                                retrieval, not synthesis.
 *                                `multi-hopAny` and
 *                                `multiHopComplete` in the
 *                                derived metrics expose the
 *                                partial-vs-complete coverage
 *                                gap.
 *
 *   - "no-answer"              — no-answer / abstention. The query
 *                                has no relevant memory in the
 *                                corpus. The lexical baseline
 *                                should return zero hits above
 *                                the threshold. The expanded
 *                                checkpoint adds a labeled set
 *                                of "hard-negative" no-answer
 *                                queries that share tokens with
 *                                real records, so the no-answer
 *                                TNR is exercised against
 *                                confabulation pressure, not
 *                                only against zero-overlap
 *                                queries.
 *
 *   - "orientation"            — project-status query. The
 *                                query asks about the current
 *                                state of the project. The
 *                                expected ids are the records
 *                                that together describe that
 *                                current state. Scoring is
 *                                retrieval-only: expected id
 *                                coverage in the top-K, not
 *                                answer prose. The
 *                                answer-quality scaffold is
 *                                disabled in this phase, so
 *                                the orientation family is not
 *                                judged for prose quality.
 *                                A project-status query is
 *                                expected NOT to surface
 *                                office / historical
 *                                distractor records; the
 *                                `noisyReturnRate` orientation
 *                                metric (see
 *                                `OrientationMetrics` in
 *                                `src/benchmark/metrics.ts`)
 *                                captures that gap.
 *
 * Stability:
 *   - Query ids are stable strings. Reports reference them by id.
 *   - The corpus is paired with `BENCHMARK_RECORDS` in
 *     `corpus.ts`; the integrity test in
 *     `tests/retrieval-benchmark.test.ts` asserts that every
 *     expected id resolves to a real record.
 *
 * Adversarial-expansion query count: the adversarial-expansion
 * checkpoint contains 176 queries across the six families
 * (exact=20, paraphrase=32, temporal=26, multi-hop=26,
 * no-answer=46, orientation=26). The 80 added queries are
 * split as: exact +6, paraphrase +20, temporal +14, multi-hop
 * +10, no-answer +22, orientation +8. The 96-query
 * expanded-checkpoint set is preserved as the baseline; the
 * 80 added queries exercise the adversarial shapes the
 * expansion targets (hard-negatives on current clusters,
 * OOD entities, negation-shaped queries, false-premise
 * queries, divergent-current-truth temporal queries, deep
 * paraphrases with low lexical overlap, near-miss
 * disambiguation, multi-hop with a near-miss distractor on
 * one hop, and orientation queries with legacy /
 * near-miss distractor pressure).
 *
 * Five of the temporal queries are labeled
 * "divergent current-truth" cases (the two from the prior
 * expanded checkpoint — `temp-storage-raw-text` and
 * `temp-controller-validation` — plus three new ones in
 * the adversarial expansion: `temp-divergent-postgres-15`,
 * `temp-divergent-controller-validation`, and
 * `temp-divergent-oncall-handoff`). The labeled set is a
 * strict subset of the temporal family and the per-query
 * `currentTruthIds` field is a strict subset of
 * `expectedIds` for those queries. Adding a new divergent
 * query requires updating the `divergentIds` set in
 * `tests/retrieval-benchmark.test.ts`.
 *
 * Adversarial-property labels: a subset of the new
 * queries carry an OPTIONAL `labels?: string[]` field on
 * the query object. The field is purely additive
 * (existing queries do NOT have it) and the recognized
 * values are documented on the `BenchmarkQuery` type
 * below. The labels are fixture truth, not derived from
 * a detector; the query-shape detector approximates them
 * at runtime.
 */

export type BenchmarkQueryFamily =
  | "exact"
  | "paraphrase"
  | "temporal"
  | "multi-hop"
  | "no-answer"
  | "orientation";

export interface BenchmarkQuery {
  id: string;
  family: BenchmarkQueryFamily;
  query: string;
  /**
   * Memory ids that should appear in the top-K. For
   * `family: "no-answer"`, this list is empty.
   */
  expectedIds: number[];
  /**
   * Memory ids that represent the CURRENT truth for this query.
   * For non-temporal families this is the same as `expectedIds`
   * (the "right" answer is always the current one). For most
   * `temporal` queries it is also the same as `expectedIds` —
   * the expected id IS the current fact, and the old fact is
   * a known distractor. A small labeled set of `temporal`
   * queries deliberately has `expectedIds` containing both the
   * old and the new fact, with `currentTruthIds` containing only
   * the new fact; this makes the `currentTruth` diagnostic
   * meaningful for the "did the ranker rank the current fact
   * above the old one?" question. The field is kept separate
   * from `expectedIds` so the stricter "current-truth@1" metric
   * is a labeled, first-class concept in the data:
   * temporal gaps are visible without needing a separate
   * query type.
   */
  currentTruthIds: number[];
  /**
   * Optional, OPT-IN adversarial-property labels the
   * expanded-checkpoint corpus adds. The field is
   * strictly additive: existing queries do NOT have
   * it, and tests / metrics that key on the absence of
   * a label (e.g. "queries without a `hardNegative`
   * label") are still well-formed when the field is
   * missing. The recognized values are:
   *
   *   - `"hardNegative"` — a no-answer query that
   *     shares strong tokens with a real record and is
   *     expected to confabulate (the
   *     `isNoAnswerHardNegative` flag is the detector
   *     side; this label is the fixture-truth side).
   *   - `"falsePremise"` — a query that asserts a
   *     premise the corpus does not name (matches the
   *     `isFalsePremiseLike` detector intent at the
   *     fixture level).
   *   - `"negation"` — the query contains a negation
   *     token (a sub-label of `falsePremise` /
   *     `hardNegative` / answerable depending on the
   *     family).
   *   - `"adversarialParaphrase"` — a paraphrase
   *     query deliberately chosen for low lexical
   *     overlap with the expected record (the
   *     hardest case for the token-overlap ranker).
   *   - `"divergentTemporal"` — a temporal query with
   *     `expectedIds` and `currentTruthIds`
   *     deliberately diverged (the labeled
   *     "current-truth@1" gap cases; see the
   *     `DIVERGENT_TEMPORAL_IDS` set in
   *     `abstention-audit-runner.ts`).
   *   - `"nearMissCurrentCluster"` — a query whose
   *     top-1 is expected to be a near-miss distractor
   *     (a record in the same topical cluster as the
   *     expected record but with the wrong specific
   *     fact, e.g. the wrong / previous tool version).
   *     A reviewer can read this as "this query is
   *     designed to test the cluster-level
   *     disambiguation, not the
   *     within-cluster-relevance" gap.
   *
   * The labels are NOT derived from the query-shape
   * detector; they are the fixture's hand-curated
   * truth. The detector is the heuristic that
   * approximates the labels at runtime; a labeled
   * query is the anchor the detector can be checked
   * against.
   *
   * A label is also NOT a guarantee that the ranker
   * fails on the query: a `hardNegative` label says
   * the query is confabulation pressure, not that the
   * ranker will confabulate. The test surface pins
   * the *floor* of labeled queries per family and per
   * label, not the exact outcome of the ranker on
   * each one.
   */
  labels?: string[];
  /** Short human description of what the query is testing. */
  note: string;
}

export const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  // -------------------------------------------------------------------------
  // Family: exact (5) — verbatim-ish token overlap.
  // The lexical baseline should pass these comfortably.
  // -------------------------------------------------------------------------
  {
    id: "exact-postgres-storage",
    family: "exact",
    query: "What database does the project use?",
    expectedIds: [1],
    currentTruthIds: [1],
    note: "Direct question about the primary store; should hit record 1.",
  },
  {
    id: "exact-typescript-runtime",
    family: "exact",
    query: "What language and runtime does the server use?",
    expectedIds: [2],
    currentTruthIds: [2],
    note: "Direct question about server stack; should hit record 2.",
  },
  {
    id: "exact-storage-location",
    family: "exact",
    query: "Where is the project storage located on disk?",
    expectedIds: [4],
    currentTruthIds: [4],
    note: "Direct question about storage layout; should hit record 4.",
  },
  {
    id: "exact-ci-pipeline",
    family: "exact",
    query: "What does the CI pipeline do?",
    expectedIds: [6],
    currentTruthIds: [6],
    note: "Direct question about CI; should hit record 6.",
  },
  {
    id: "exact-oncall-runbook",
    family: "exact",
    query: "Where is the on-call runbook?",
    expectedIds: [18],
    currentTruthIds: [18],
    note: "Direct question about the runbook path; should hit record 18.",
  },

  // -------------------------------------------------------------------------
  // Family: paraphrase (4) — same idea, different words.
  // The lexical baseline is expected to FAIL or partially pass.
  // -------------------------------------------------------------------------
  {
    id: "para-deploy-strategy",
    family: "paraphrase",
    query: "How do we ship changes to users safely?",
    expectedIds: [5, 7, 8],
    currentTruthIds: [5, 7, 8],
    note:
      "Paraphrase of release + deploy strategy. Expected to miss 5, 7, 8 because the records use 'release' / 'rolling restart' / 'staging' vocabulary, not 'ship to users'.",
  },
  {
    id: "para-review-style",
    family: "paraphrase",
    query: "How picky should we be when looking at pull requests?",
    expectedIds: [9, 10],
    currentTruthIds: [9, 10],
    note:
      "Paraphrase of code review expectations. Expected to miss because the records use 'code review' / 'pull request titles' vocabulary.",
  },
  {
    id: "para-storage-detail",
    family: "paraphrase",
    query: "Where on the filesystem do we keep our saved notes?",
    expectedIds: [4],
    currentTruthIds: [4],
    note:
      "Paraphrase of the .cortex storage location. Expected to miss because the record says 'hidden .cortex directory' / 'SQLite file', not 'filesystem' / 'saved notes'.",
  },
  {
    id: "para-architecture-decisions",
    family: "paraphrase",
    query: "How do we keep track of big design choices?",
    expectedIds: [12],
    currentTruthIds: [12],
    note:
      "Paraphrase of ADR practice. Expected to miss because the record uses 'architectural decisions' / 'ADRs', not 'big design choices'.",
  },

  // -------------------------------------------------------------------------
  // Family: temporal (3) — current fact expected; old record is a
  // known distractor. The lexical baseline has no temporal signal
  // and is expected to FAIL — these queries measure the gap.
  // -------------------------------------------------------------------------
  {
    id: "temp-postgres-version",
    family: "temporal",
    query: "What version of Postgres does the project use now?",
    expectedIds: [1],
    currentTruthIds: [1],
    note:
      "Asks for the CURRENT Postgres version. Record 1 (Postgres 16) is current; record 21 (Postgres 14) is the old fact. Baseline will likely return BOTH because they share tokens, and the OLD fact is expected to win rank-1.",
  },
  {
    id: "temp-release-process",
    family: "temporal",
    query: "What is the current release cut schedule?",
    expectedIds: [7],
    currentTruthIds: [7],
    note:
      "Asks for the CURRENT release schedule. Record 7 (Tuesday main-branch cut) is current; record 22 (Thursday release-branch cut) is the old process. Baseline will likely return BOTH; the current fact is expected to win rank-1 because it shares the strongest query tokens.",
  },
  {
    id: "temp-retrieval-design",
    family: "temporal",
    query: "What does the current retrieval layer look like?",
    expectedIds: [3],
    currentTruthIds: [3],
    note:
      "Asks for the CURRENT retrieval design. Record 3 (re-ranking before synthesis) is current; record 23 (single-pass) is the old design. Baseline will likely return BOTH, and the OLD fact is expected to win rank-1.",
  },

  // -------------------------------------------------------------------------
  // Family: multi-hop (4) — answer requires joining multiple
  // memories. We only require at least one expected id in the
  // top-K; the lexical baseline does not do synthesis.
  // -------------------------------------------------------------------------
  {
    id: "multi-deploy-and-release",
    family: "multi-hop",
    query: "What is the deploy process and when do releases happen?",
    expectedIds: [5, 7, 8],
    currentTruthIds: [5, 7, 8],
    note:
      "Needs deploy (5/8) and release schedule (7) together. At least one expected id in top-K counts as a hit.",
  },
  {
    id: "multi-oncall-and-runbook",
    family: "multi-hop",
    query: "How is the on-call rotation organized and where is the runbook?",
    expectedIds: [11, 18],
    currentTruthIds: [11, 18],
    note:
      "Needs rotation (11) and runbook path (18). At least one expected id in top-K counts as a hit.",
  },
  {
    id: "multi-docs-and-arch",
    family: "multi-hop",
    query: "Where are the project docs and architecture notes?",
    expectedIds: [17, 19, 20],
    currentTruthIds: [17, 19, 20],
    note:
      "Needs the docs layout (17/19/20). At least one expected id in top-K counts as a hit.",
  },
  {
    id: "multi-team-and-process",
    family: "multi-hop",
    query: "What are the team conventions for code review and pull requests?",
    expectedIds: [9, 10],
    currentTruthIds: [9, 10],
    note:
      "Needs review (9) and PR title style (10). At least one expected id in top-K counts as a hit.",
  },

  // -------------------------------------------------------------------------
  // Family: no-answer (4) — no relevant memory in the corpus.
  // The lexical baseline should return zero hits.
  // -------------------------------------------------------------------------
  {
    id: "nonexistent-company-picnic",
    family: "no-answer",
    query: "When is the company picnic?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a picnic; baseline should return no hits.",
  },
  {
    id: "nonexistent-auth-library",
    family: "no-answer",
    query: "Which authentication library do we use for the web dashboard?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "Corpus has no record about a web dashboard or auth library; baseline should return no hits.",
  },
  {
    id: "nonexistent-mobile-app",
    family: "no-answer",
    query: "What is the mobile app's deployment target?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "Corpus has no record about a mobile app; baseline should return no hits.",
  },
  {
    id: "nonexistent-customer-count",
    family: "no-answer",
    query: "How many active customers do we have?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "Corpus has no record about customer counts; baseline should return no hits.",
  },

  // -------------------------------------------------------------------------
  // Family: orientation (4) — project-status queries.
  // The orientation family is intentionally a thin project-status
  // slice for this phase. We do NOT yet expand into broad
  // open-domain "what is the project" questions; that comes in a
  // later phase. The current family exercises:
  //   - "current state" recall (which records describe the
  //     project as it is now)
  //   - multi-slot coverage (a status query may need 2+ records
  //     to answer, e.g. storage + release + on-call)
  //   - noise filtering (a status query should not surface
  //     office / historical distractor records)
  // Scoring is RETRIEVAL-ONLY: we count expected ids in the
  // top-K, not answer prose quality. The future
  // answer-quality scaffold is disabled in this phase.
  // -------------------------------------------------------------------------
  {
    id: "orient-stack-status",
    family: "orientation",
    query: "What is the current project stack?",
    expectedIds: [1, 2, 4],
    currentTruthIds: [1, 2, 4],
    note:
      "Status: storage + runtime + on-disk layout. Three-slot query, all expected ids are current.",
  },
  {
    id: "orient-deploy-status",
    family: "orientation",
    query: "How does the project deploy and release today?",
    expectedIds: [5, 7, 8],
    currentTruthIds: [5, 7, 8],
    note:
      "Status: staging-vs-prod shape, current release schedule, rolling restart policy.",
  },
  {
    id: "orient-oncall-status",
    family: "orientation",
    query: "What is the on-call setup and where is the runbook?",
    expectedIds: [11, 18],
    currentTruthIds: [11, 18],
    note:
      "Status: rotation + runbook path. Two-slot query, both expected ids are current.",
  },
  {
    id: "orient-docs-status",
    family: "orientation",
    query: "Where do project docs and architecture notes live?",
    expectedIds: [17, 19, 20],
    currentTruthIds: [17, 19, 20],
    note:
      "Status: handbook + architecture diagram + provider prototype docs. Three-slot query.",
  },

  // -------------------------------------------------------------------------
  // Family: exact (additional) — verbatim-ish token overlap, but
  // for the new topical clusters. The lexical baseline should
  // pass these comfortably. (5 new queries; family total: 10.)
  // -------------------------------------------------------------------------
  {
    id: "exact-mcp-transport",
    family: "exact",
    query: "Which MCP transport does the server use?",
    expectedIds: [51],
    currentTruthIds: [51],
    note: "Direct question about the MCP transport; should hit record 51.",
  },
  {
    id: "exact-test-runner",
    family: "exact",
    query: "What test runner does the project use?",
    expectedIds: [26],
    currentTruthIds: [26],
    note: "Direct question about the test runner; should hit record 26.",
  },
  {
    id: "exact-package-manager",
    family: "exact",
    query: "Which package manager and lockfile does the project use?",
    expectedIds: [33],
    currentTruthIds: [33],
    note: "Direct question about the package manager; should hit record 33.",
  },
  {
    id: "exact-memory-kinds",
    family: "exact",
    query: "What are the allowed kinds for a memory record?",
    expectedIds: [45],
    currentTruthIds: [45],
    note: "Direct question about the kinds enum; should hit record 45.",
  },
  {
    id: "exact-public-tools",
    family: "exact",
    query: "How many public tools does the MCP server expose?",
    expectedIds: [56],
    currentTruthIds: [56],
    note: "Direct question about the public tool surface; should hit record 56.",
  },

  // -------------------------------------------------------------------------
  // Family: paraphrase (additional) — same idea, different words,
  // for the new clusters. The lexical baseline is expected to FAIL
  // or partially pass. (4 new queries; family total: 8.)
  // -------------------------------------------------------------------------
  {
    id: "para-secret-handling",
    family: "paraphrase",
    query: "How do we keep API credentials out of the repo?",
    expectedIds: [29, 30],
    currentTruthIds: [29, 30],
    note:
      "Paraphrase of the env-only key handling + HTTP-client error scrub. Records use 'environment variables' / 'Authorization' / 'scrubs', not 'repo' / 'credentials'.",
  },
  {
    id: "para-upgrade-cadence",
    family: "paraphrase",
    query: "How often do we pull in framework updates?",
    expectedIds: [34, 35, 36],
    currentTruthIds: [34, 35, 36],
    note:
      "Paraphrase of dependency policy. Records use 'pinned' / 'weekly job' / 'quarterly cadence', not 'framework updates'.",
  },
  {
    id: "para-domain-shape",
    family: "paraphrase",
    query: "What kind of things can we save to memory?",
    expectedIds: [45, 46, 47, 48],
    currentTruthIds: [45, 46, 47, 48],
    note:
      "Paraphrase of the memory record kinds / states / confidence / safety flags surface. Records use 'kind' / 'state' / 'confidence' / 'safety flags', not 'things' / 'save'.",
  },
  {
    id: "para-incident-comms",
    family: "paraphrase",
    query: "How do we tell people something is on fire?",
    expectedIds: [37, 38, 39, 40],
    currentTruthIds: [37, 38, 39, 40],
    note:
      "Paraphrase of the alerting / log-level / runbook posture. Records use 'stderr' / 'log level' / 'alerts' / 'runbook', not 'on fire'.",
  },

  // -------------------------------------------------------------------------
  // Family: temporal (additional) — supersession-style queries,
  // for the new clusters. (3 new queries; family total: 6.) One
  // of these queries (`temp-storage-raw-text`) is a labeled
  // "divergent current-truth" case: `expectedIds` contains both
  // the old (57) and the new (50) fact, and `currentTruthIds`
  // contains only the new fact (50). The other two new temporal
  // queries follow the existing convention (expected ==
  // current, old fact is a distractor).
  // -------------------------------------------------------------------------
  {
    id: "temp-schema-migrations",
    family: "temporal",
    query: "How does the project handle database schema changes today?",
    expectedIds: [50],
    currentTruthIds: [50],
    note:
      "Asks for the CURRENT schema migration policy. Record 50 (additive / idempotent) is current; record 57 (raw text alongside summaries) is the old schema, not directly a distractor here but a same-cluster legacy.",
  },
  {
    id: "temp-ci-runner",
    family: "temporal",
    query: "Where does the CI pipeline run tests today?",
    expectedIds: [6],
    currentTruthIds: [6],
    note:
      "Asks for the CURRENT CI runner. Record 6 is current; record 58 (single self-hosted runner) is the old CI shape.",
  },
  {
    id: "temp-storage-raw-text",
    family: "temporal",
    // Labeled "divergent current-truth" case. `expectedIds`
    // contains both the old (57) and the new (50) facts so
    // hit@K can pass with either one in the top-K. The
    // `currentTruthIds` is the strict current fact (50)
    // only. A retrieval that surfaces 57 at the top with 50
    // somewhere in the top-K will pass `hit@K` and fail
    // `currentTruthAt1` — the divergence the metric was
    // designed to surface.
    query: "How are memory summaries stored now, and what changed?",
    expectedIds: [50, 57],
    currentTruthIds: [50],
    labels: ["divergentTemporal"],
    note:
      "Divergent current-truth temporal query. expectedIds=[50, 57] (both old and new), currentTruthIds=[50] (current only). The lexical baseline tends to return 57 at the top because its summary is more direct, leaving 50 lower in the top-K; currentTruthAt1 therefore fails while hit@K passes.",
  },

  // -------------------------------------------------------------------------
  // Family: multi-hop (additional) — answer requires joining
  // multiple memories. (6 new queries; family total: 10.) Some
  // are large-list queries (4+ expected ids) so the complete vs
  // partial coverage metric has more range.
  // -------------------------------------------------------------------------
  {
    id: "multi-security-posture",
    family: "multi-hop",
    query: "What is the project's security posture across keys, auth, and reviews?",
    expectedIds: [29, 30, 31, 32],
    currentTruthIds: [29, 30, 31, 32],
    note:
      "Needs key handling (29) + HTTP error scrub (30) + per-env signing keys (31) + dependency review for crypto (32). Four-slot query, all current.",
  },
  {
    id: "multi-deps-policy",
    family: "multi-hop",
    query: "How are dependencies pinned, reviewed, and upgraded?",
    expectedIds: [33, 34, 35, 36],
    currentTruthIds: [33, 34, 35, 36],
    note:
      "Needs npm + lockfile (33) + pinned versions (34) + weekly upgrade PR (35) + quarterly MCP SDK upgrade (36). Four-slot query.",
  },
  {
    id: "multi-monitoring-posture",
    family: "multi-hop",
    query: "How does the project observe and respond to runtime issues?",
    expectedIds: [37, 38, 39, 40],
    currentTruthIds: [37, 38, 39, 40],
    note:
      "Needs stderr-only logs (37) + log level env (38) + alert routing (39) + runbook reference (40). Four-slot query.",
  },
  {
    id: "multi-team-cadence",
    family: "multi-hop",
    query: "What is the team's process for planning, decisions, and PR review?",
    expectedIds: [41, 42, 43, 44],
    currentTruthIds: [41, 42, 43, 44],
    note:
      "Needs planning sync (41) + ADR policy (42) + communication channel (43) + PR review SLA (44). Four-slot query.",
  },
  {
    id: "multi-domain-shape",
    family: "multi-hop",
    query: "What fields and shapes do memory records carry?",
    expectedIds: [45, 46, 47, 48],
    currentTruthIds: [45, 46, 47, 48],
    note:
      "Needs kind enum (45) + state enum (46) + confidence range (47) + safety flags (48). Four-slot query.",
  },
  {
    id: "multi-test-policy",
    family: "multi-hop",
    query: "What does the project's test policy cover?",
    expectedIds: [25, 26, 27, 28, 53, 54, 55, 56],
    currentTruthIds: [25, 26, 27, 28, 53, 54, 55, 56],
    note:
      "Eight-slot list query spanning cluster 7 and cluster 14. At least one expected id in top-K counts as a partial hit; the derived multiHopComplete metric exposes the list-coverage gap.",
  },

  // -------------------------------------------------------------------------
  // Family: no-answer (additional) — no relevant memory in the
  // corpus. The lexical baseline should return zero hits.
  // (6 new queries; family total: 10.)
  // -------------------------------------------------------------------------
  {
    id: "nonexistent-graphql-endpoint",
    family: "no-answer",
    query: "Is there a public GraphQL endpoint for the project?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions GraphQL; baseline should return no hits.",
  },
  {
    id: "nonexistent-ios-app",
    family: "no-answer",
    query: "Is there an iOS application for the project?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions an iOS app; baseline should return no hits.",
  },
  {
    id: "nonexistent-pricing-tier",
    family: "no-answer",
    query: "What are the project's pricing tiers?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions pricing; baseline should return no hits.",
  },
  {
    id: "nonexistent-sla",
    family: "no-answer",
    query: "What is the public SLA for the project?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a public SLA; baseline should return no hits.",
  },
  {
    id: "nonexistent-webhook",
    family: "no-answer",
    query: "Does the project expose a webhook for downstream tools?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a webhook; baseline should return no hits.",
  },
  {
    id: "nonexistent-localization",
    family: "no-answer",
    query: "What languages does the user interface support?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions localization or i18n; baseline should return no hits.",
  },

  // -------------------------------------------------------------------------
  // Family: orientation (additional) — project-status queries,
  // for the new topical clusters. (6 new queries; family total:
  // 10.) The new queries add more slot / category coverage so
  // the orientation metrics have a wider range.
  // -------------------------------------------------------------------------
  {
    id: "orient-testing-status",
    family: "orientation",
    query: "What is the project's current test policy?",
    expectedIds: [25, 26, 27, 28],
    currentTruthIds: [25, 26, 27, 28],
    note:
      "Status: test layout + runner + coverage + safety fixture regression. Four-slot query.",
  },
  {
    id: "orient-security-status",
    family: "orientation",
    query: "What is the project's current security posture?",
    expectedIds: [29, 30, 31, 32],
    currentTruthIds: [29, 30, 31, 32],
    note:
      "Status: env-only keys + HTTP error scrub + per-env signing keys + crypto review. Four-slot query.",
  },
  {
    id: "orient-deps-status",
    family: "orientation",
    query: "How are dependencies managed today?",
    expectedIds: [33, 34, 35, 36],
    currentTruthIds: [33, 34, 35, 36],
    note:
      "Status: npm + lockfile + pinned versions + weekly upgrade PR + quarterly MCP SDK upgrade. Four-slot query.",
  },
  {
    id: "orient-monitoring-status",
    family: "orientation",
    query: "How is the project observed and alerted on?",
    expectedIds: [37, 38, 39, 40],
    currentTruthIds: [37, 38, 39, 40],
    note:
      "Status: stderr-only logs + log level env + alert routing + runbook reference. Four-slot query.",
  },
  {
    id: "orient-team-status",
    family: "orientation",
    query: "What are the team's process conventions?",
    expectedIds: [41, 42, 43, 44],
    currentTruthIds: [41, 42, 43, 44],
    note:
      "Status: planning sync + ADR policy + channel + PR review SLA. Four-slot query.",
  },
  {
    id: "orient-domain-status",
    family: "orientation",
    query: "What does a memory record look like?",
    expectedIds: [45, 46, 47, 48],
    currentTruthIds: [45, 46, 47, 48],
    note:
      "Status: kind enum + state enum + confidence range + safety flags. Four-slot query — gives the orientation metrics a fourth-shape slot (4 ids) beyond the 2- and 3-id queries the original family had.",
  },

  // -------------------------------------------------------------------------
  // EXPANDED-CHECKPOINT QUERIES (96-query set, 100-record corpus)
  //
  // The expanded checkpoint is the second step between the
  // 60-record / 54-query intermediate set and a future
  // 132-record / 108-query adversarial set. The new queries
  // deepen coverage of the weakest benchmark families
  // identified in prior phases (paraphrase, temporal,
  // no-answer) and add more orientation / multi-hop slots so
  // the per-family percentages have less run-to-run swing.
  //
  // Per-family distribution in the expanded set:
  //   exact: 14 (10 + 4)
  //   paraphrase: 12 (8 + 4)
  //   temporal: 12 (6 + 6, including 1 new divergent case)
  //   multi-hop: 16 (10 + 6)
  //   no-answer: 24 (10 + 14, including 1 labeled
  //                     hard-negative that the lexical baseline
  //                     is expected to confabulate on)
  //   orientation: 18 (10 + 8)
  //   TOTAL: 96
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Family: exact (additional) — verbatim-ish token overlap for
  // the new clusters 16-25. (4 new queries; family total: 14.)
  // -------------------------------------------------------------------------
  {
    id: "exact-feature-flags-env",
    family: "exact",
    query: "Where are feature flags read from?",
    expectedIds: [85],
    currentTruthIds: [85],
    note:
      "Direct question about the feature-flag source; should hit record 85.",
  },
  {
    id: "exact-pipeline-backup",
    family: "exact",
    query: "How often are database backups created?",
    expectedIds: [78],
    currentTruthIds: [78],
    note: "Direct question about the backup cadence; should hit record 78.",
  },
  {
    id: "exact-audit-retention",
    family: "exact",
    query: "How long are audit logs retained?",
    expectedIds: [72],
    currentTruthIds: [72],
    note: "Direct question about the audit window; should hit record 72.",
  },
  {
    id: "exact-recall-pagination",
    family: "exact",
    query: "Does the recall tool support pagination?",
    expectedIds: [75],
    currentTruthIds: [75],
    note: "Direct question about the recall limit; should hit record 75.",
  },

  // -------------------------------------------------------------------------
  // Family: paraphrase (additional) — same idea, different words,
  // for the new clusters 16-23. The lexical baseline is
  // expected to FAIL or partially pass. (4 new queries; family
  // total: 12.)
  // -------------------------------------------------------------------------
  {
    id: "para-rotation-handoff",
    family: "paraphrase",
    query: "When does the on-call duty change over?",
    expectedIds: [11],
    currentTruthIds: [11],
    note:
      "Paraphrase of the on-call rotation handoff. Record 11 says 'Mondays at 10:00 local time'; the query says 'change over' / 'duty'.",
  },
  {
    id: "para-rate-limit",
    family: "paraphrase",
    query: "How do we keep the AI provider from being throttled?",
    expectedIds: [70],
    currentTruthIds: [70],
    note:
      "Paraphrase of the rate-limit policy. Record 70 says 'CORTEX_PROVIDER_RATE_LIMIT' / 'sixty requests per minute'; the query says 'throttled' / 'AI provider'.",
  },
  {
    id: "para-cache-strategy",
    family: "paraphrase",
    query: "Why don't we keep provider responses around for the next call?",
    expectedIds: [76],
    currentTruthIds: [76],
    note:
      "Paraphrase of the in-memory cache scope. Record 76 says 'caches provider responses in-memory for the lifetime of a single process'; the query says 'keep ... for the next call' / 'around'.",
  },
  {
    id: "para-input-gate",
    family: "paraphrase",
    query: "How do we keep junk from reaching the AI provider?",
    expectedIds: [69],
    currentTruthIds: [69],
    note:
      "Paraphrase of the safety classifier input gate. Record 69 says 'safety classifier runs on every input before the controller; raw-dump and secret classifications are dropped'; the query says 'junk from reaching' / 'AI provider'.",
  },

  // -------------------------------------------------------------------------
  // Family: temporal (additional) — supersession-style queries
  // for the new clusters 18-23, with the new legacy cluster
  // (93..96) as a distractor set. (6 new queries; family total:
  // 12.) One of the new queries
  // (`temp-controller-validation`) is a labeled "divergent
  // current-truth" case: `expectedIds` contains both the
  // legacy (96) and the current (69) fact, and
  // `currentTruthIds` contains only the current fact (69). The
  // other five new temporal queries follow the existing
  // convention (expected == current, legacy is a distractor).
  // -------------------------------------------------------------------------
  {
    id: "temp-feature-flags-restart",
    family: "temporal",
    query: "How do feature flag changes take effect?",
    expectedIds: [87],
    currentTruthIds: [87],
    note:
      "Asks for the CURRENT feature-flag lifecycle. Record 87 (per-process; restart required) is current. Legacy distractors 57-60 do not share strong tokens; this is a cleaner case than the legacy-vs-newer supersession pair.",
  },
  {
    id: "temp-fallback-key",
    family: "temporal",
    query: "Where is the fallback provider key read from?",
    expectedIds: [90],
    currentTruthIds: [90],
    note:
      "Asks for the CURRENT fallback-provider env var. Record 90 is current. Legacy record 59 (single primary endpoint) is a distractor that shares 'provider' tokens.",
  },
  {
    id: "temp-rate-limit",
    family: "temporal",
    query: "How is the AI provider rate-limited today?",
    expectedIds: [70],
    currentTruthIds: [70],
    note:
      "Asks for the CURRENT rate-limit policy. Record 70 (CORTEX_PROVIDER_RATE_LIMIT, default sixty) is current. Legacy record 59 (single primary endpoint) is a distractor that shares 'provider' tokens.",
  },
  {
    id: "temp-tls-requirement",
    family: "temporal",
    query: "What TLS version does provider traffic require?",
    expectedIds: [71],
    currentTruthIds: [71],
    note:
      "Asks for the CURRENT TLS policy. Record 71 (TLS 1.2 or higher) is current. No strong legacy distractor; this is a clean exact-ish current fact.",
  },
  {
    id: "temp-recall-pagination",
    family: "temporal",
    query: "Does the recall tool support pagination now?",
    expectedIds: [75],
    currentTruthIds: [75],
    note:
      "Asks for the CURRENT recall limit. Record 75 (DEFAULT_TOP_K = 5, pagination not supported) is current. No strong legacy distractor.",
  },
  {
    id: "temp-controller-validation",
    family: "temporal",
    // Labeled "divergent current-truth" case (the second
    // divergent query in the benchmark, joining
    // `temp-storage-raw-text`). `expectedIds` contains both
    // the current (69) and the legacy (96) fact so hit@K
    // can pass with either one in the top-K. The
    // `currentTruthIds` is the strict current fact (69)
    // only. A retrieval that surfaces 96 at the top with 69
    // somewhere in the top-K will pass `hit@K` and fail
    // `currentTruthAt1` — the divergence the metric was
    // designed to surface. Record 96 is the more direct
    // hit for the query text "How does the controller
    // decide what to save" (it says "controller" and
    // "validates ... before persisting"); record 69 is
    // about the safety classifier and is the current truth
    // for the *gating* decision. The lexical ranker is
    // expected to surface 96 at the top.
    query: "How does the controller decide what to save?",
    expectedIds: [69, 96],
    currentTruthIds: [69],
    labels: ["divergentTemporal"],
    note:
      "Divergent current-truth temporal query. expectedIds=[69, 96] (current safety gate + legacy no-validation), currentTruthIds=[69] (current only). The lexical baseline is expected to surface 96 at the top because 'controller' + 'validates' is a closer match than 'classifier' + 'drops'.",
  },

  // -------------------------------------------------------------------------
  // Family: multi-hop (additional) — answer requires joining
  // multiple memories from the new clusters 16-23. (6 new
  // queries; family total: 16.)
  // -------------------------------------------------------------------------
  {
    id: "multi-feature-flags-policy",
    family: "multi-hop",
    query: "How are feature flags read, defaulted, and rolled out?",
    expectedIds: [85, 86, 87, 88],
    currentTruthIds: [85, 86, 87, 88],
    note:
      "Needs CORTEX_FEATURE_FLAGS source (85) + default empty (86) + per-process evaluation (87) + verbose-summary mode gate (88). Four-slot query.",
  },
  {
    id: "multi-provider-failover",
    family: "multi-hop",
    query: "How does the provider pick a healthy endpoint, retry on rate limit, and fall back?",
    expectedIds: [89, 90, 91, 92],
    currentTruthIds: [89, 90, 91, 92],
    note:
      "Needs primary/fallback routing (89) + CORTEX_PROVIDER_FALLBACK_KEY (90) + exponential backoff on 429 (91) + typed result union (92). Four-slot query.",
  },
  {
    id: "multi-data-pipeline",
    family: "multi-hop",
    query: "How are memories persisted, backed up, timestamped, and soft-deleted?",
    expectedIds: [77, 78, 79, 80],
    currentTruthIds: [77, 78, 79, 80],
    note:
      "Needs SQLite WAL (77) + nightly backup rotation (78) + createdAt/updatedAt (79) + state=invalidated (80). Four-slot query.",
  },
  {
    id: "multi-agent-runtime",
    family: "multi-hop",
    query: "What does the agent runtime look like in terms of process model, mutex, and recall limits?",
    expectedIds: [73, 74, 75, 76],
    currentTruthIds: [73, 74, 75, 76],
    note:
      "Needs single Node process / stdio multiplex (73) + per-key mutex (74) + DEFAULT_TOP_K=5 limit (75) + in-memory response cache (76). Four-slot query.",
  },
  {
    id: "multi-security-extensions",
    family: "multi-hop",
    query: "How is input sanitized, rate limited, encrypted in transit, and audited?",
    expectedIds: [69, 70, 71, 72],
    currentTruthIds: [69, 70, 71, 72],
    note:
      "Needs safety classifier (69) + rate limit (70) + TLS 1.2+ (71) + 30-day audit retention (72). Four-slot query.",
  },
  {
    id: "multi-observability-extensions",
    family: "multi-hop",
    query: "What metrics, request ids, and digests are produced for ops visibility?",
    expectedIds: [65, 66, 68, 67],
    currentTruthIds: [65, 66, 68, 67],
    note:
      "Needs Prometheus endpoint (65) + request id stitching (66) + weekly on-call digest (68) + error log redaction (67). Four-slot query — note the slot order is non-monotonic to exercise per-slot evaluation.",
  },

  // -------------------------------------------------------------------------
  // Family: no-answer (additional) — no relevant memory in the
  // corpus. The lexical baseline should return zero hits.
  // (14 new queries; family total: 24.) Several of the new
  // no-answer queries deliberately share tokens with real
  // records so the no-answer TNR is exercised against
  // confabulation pressure, not only against zero-overlap
  // queries. The confabulation-prone queries are still
  // expected to surface zero hits at the production default
  // threshold (0.2); the contract is that the corpus has
  // *no* relevant memory, not that the ranker never returns
  // a candidate.
  // -------------------------------------------------------------------------
  {
    id: "nonexistent-cdn-config",
    family: "no-answer",
    query: "What CDN does the project use for static assets?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a CDN; baseline should return no hits.",
  },
  {
    id: "nonexistent-rollback",
    family: "no-answer",
    query: "How do we roll back a bad release?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a rollback procedure; the release records (7, 22) talk about cutting and hotfixes, not rolling back. Shares 'release' tokens with cluster 2.",
  },
  {
    id: "nonexistent-sso",
    family: "no-answer",
    query: "Does the project use SSO for internal access?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions SSO; the security records (29-32, 69-72) cover env-only keys and input gating, not SSO. Shares 'security' / 'auth' tokens with clusters 8 and 18.",
  },
  {
    id: "nonexistent-load-balancer",
    family: "no-answer",
    // LABELLED HARD-NEGATIVE. This query shares strong
    // tokens ('MCP', 'server', 'port') with the agent
    // runtime records (73, 75) and stack records (2, 51).
    // The lexical baseline is expected to return at least
    // one hit because of the high token overlap, so this
    // query is the labeled false-positive case the
    // expanded-checkpoint test pins: it should appear in
    // the per-query failure list with `passed === false`
    // and a non-empty `topIds`. The query text is
    // deliberately calibrated to overlap the corpus
    // without naming a real record, so the no-answer TNR
    // gets confabulation pressure at the production
    // default threshold.
    query: "What load balancer sits in front of the MCP server?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "LABELLED HARD-NEGATIVE. No record mentions a load balancer, but the query shares 'MCP' / 'server' / 'port' tokens with the agent runtime and stack records. The expanded-checkpoint test pins this query as a labeled false-positive case.",
  },
  {
    id: "nonexistent-feature-branch-policy",
    family: "no-answer",
    query: "How long should a feature branch live?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a feature-branch policy; the release records (7, 22) talk about cutting from main, not branch lifetime. Shares 'release' / 'branch' tokens with cluster 2.",
  },
  {
    id: "nonexistent-sla-tier",
    family: "no-answer",
    query: "What SLA tier do we promise paying customers?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions an SLA tier; the runbook / monitoring records (18, 37-40) talk about incident response, not contractual SLAs. Shares 'customer' / 'SLA' tokens weakly.",
  },
  {
    id: "nonexistent-cookie-policy",
    family: "no-answer",
    query: "What's the cookie retention policy?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions cookies; the project has no web UI. Shares 'policy' / 'retention' tokens with the audit retention record (72).",
  },
  {
    id: "nonexistent-data-retention",
    family: "no-answer",
    query: "What is the user data deletion policy?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions user data deletion; the soft-delete record (80) covers state=invalidated for memories, not user data. Shares 'data' / 'deletion' tokens with the data-pipeline cluster (77-80).",
  },
  {
    id: "nonexistent-staging-access",
    family: "no-answer",
    query: "How do contractors get access to staging?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions contractor access; the deploy / security records (5, 6, 29-32) cover env shape and key handling, not external access. Shares 'staging' / 'access' tokens with cluster 2.",
  },
  {
    id: "nonexistent-rate-limit-budget",
    family: "no-answer",
    query: "What's the daily API call budget per user?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a per-user daily budget; the rate-limit record (70) covers per-environment request-per-minute, not per-user daily. Shares 'rate' / 'API' / 'limit' tokens with the security-extensions cluster.",
  },
  {
    id: "nonexistent-time-tracking",
    family: "no-answer",
    query: "What time-tracking tool does the team use?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions time tracking; the team-process records (41-44) cover cadence and channels, not time tracking. Shares 'team' tokens with cluster 11.",
  },
  {
    id: "nonexistent-pairing-rotation",
    family: "no-answer",
    query: "When does the team do pair programming rotations?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions pair programming or rotations; the on-call rotation record (11) is the only rotation in the corpus, and it is for on-call, not pairing. Shares 'rotation' tokens weakly.",
  },
  {
    id: "nonexistent-quiet-hours",
    family: "no-answer",
    query: "What are the team's quiet hours for non-urgent messages?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions quiet hours; the on-call digest record (68) covers weekly digests, not quiet hours. Shares 'team' / 'urgent' tokens with clusters 10 and 11.",
  },
  {
    id: "nonexistent-shared-calendar",
    family: "no-answer",
    query: "Where is the shared team calendar?",
    expectedIds: [],
    currentTruthIds: [],
    note:
      "No record mentions a shared calendar; the planning-sync record (41) is the only meeting cadence in the corpus, and it does not reference a calendar tool. Shares 'team' / 'shared' tokens with clusters 11 and 4.",
  },

  // -------------------------------------------------------------------------
  // Family: orientation (additional) — project-status queries
  // for the new clusters 16-23 and 25. (8 new queries; family
  // total: 18.) The new queries add per-slot shape variety
  // (3-slot and 4-slot) so the orientation slot coverage
  // metric has a wider range.
  // -------------------------------------------------------------------------
  {
    id: "orient-ci-extensions-status",
    family: "orientation",
    query: "What is the current CI surface for lint, coverage, and matrix?",
    expectedIds: [61, 62, 63],
    currentTruthIds: [61, 62, 63],
    note:
      "Status: lint required-status-check (61) + coverage merge gate (62) + Node 20/22 matrix (63). Three-slot query.",
  },
  {
    id: "orient-feature-flags-status",
    family: "orientation",
    query: "What is the feature flag system today?",
    expectedIds: [85, 86, 87],
    currentTruthIds: [85, 86, 87],
    note:
      "Status: env-var source (85) + default empty (86) + per-process evaluation (87). Three-slot query.",
  },
  {
    id: "orient-provider-routing-status",
    family: "orientation",
    query: "How does the provider adapter route and retry today?",
    expectedIds: [89, 90, 91, 92],
    currentTruthIds: [89, 90, 91, 92],
    note:
      "Status: primary/fallback routing (89) + CORTEX_PROVIDER_FALLBACK_KEY (90) + exponential backoff on 429 (91) + typed result union (92). Four-slot query.",
  },
  {
    id: "orient-data-pipeline-status",
    family: "orientation",
    query: "How is data persisted and managed today?",
    expectedIds: [77, 78, 79, 80],
    currentTruthIds: [77, 78, 79, 80],
    note:
      "Status: SQLite WAL (77) + nightly backup rotation (78) + createdAt/updatedAt (79) + soft-delete via state=invalidated (80). Four-slot query.",
  },
  {
    id: "orient-agent-runtime-status",
    family: "orientation",
    query: "What is the current agent runtime shape?",
    expectedIds: [73, 74, 75, 76],
    currentTruthIds: [73, 74, 75, 76],
    note:
      "Status: single Node process (73) + per-key mutex (74) + DEFAULT_TOP_K=5 (75) + in-memory cache (76). Four-slot query.",
  },
  {
    id: "orient-observability-extensions-status",
    family: "orientation",
    query: "What does the project's extended observability surface look like?",
    expectedIds: [65, 66, 67, 68],
    currentTruthIds: [65, 66, 67, 68],
    note:
      "Status: Prometheus endpoint (65) + request id stitching (66) + error log redaction (67) + weekly on-call digest (68). Four-slot query.",
  },
  {
    id: "orient-security-extensions-status",
    family: "orientation",
    query: "What is the layered security posture for input, transport, and audit?",
    expectedIds: [69, 70, 71, 72],
    currentTruthIds: [69, 70, 71, 72],
    note:
      "Status: safety classifier (69) + per-env rate limit (70) + TLS 1.2+ (71) + 30-day audit retention (72). Four-slot query.",
  },
  {
    id: "orient-client-sdk-status",
    family: "orientation",
    query: "What does the public client SDK look like today?",
    expectedIds: [81, 82, 83, 84],
    currentTruthIds: [81, 82, 83, 84],
    note:
      "Status: @cortex-mcp/sdk package (81) + stdio-only transport (82) + lockstep versioning (83) + no-client-cache (84). Four-slot query.",
  },

  // -------------------------------------------------------------------------
  // ADVERSARIAL-EXPANSION CHECKPOINT (80 new queries / 132 records)
  //
  // The 80 new queries exercise the adversarial shapes the
  // expansion targets. They are organized by family below.
  // The 96-query expanded-checkpoint set is preserved
  // unchanged; the new queries are additive.
  //
  // The per-family growth (added in this phase) is:
  //   exact:       +6  (target 20)
  //   paraphrase:  +20 (target 32; 12 deep positive paraphrases,
  //                        4 adversarial positive paraphrases
  //                        with low lexical overlap, 2 positive
  //                        paraphrases that resemble no-answer /
  //                        false-premise wording but have valid
  //                        evidence, and 2 of the existing
  //                        paraphrase queries carry the
  //                        `adversarialParaphrase` label)
  //   temporal:    +14 (target 26; 5 labeled divergent
  //                        current-truth cases total, 2-3
  //                        stale-fact traps, 2 "current vs
  //                        previous" disambiguation queries)
  //   multi-hop:   +10 (target 26; temporal multi-hop, mixed
  //                        current/superseded evidence, 1
  //                        near-miss-distractor hop)
  //   no-answer:   +22 (target 46; 10-12 hard-negatives on
  //                        current clusters, 4-5 OOD entities
  //                        not in the legacy token list, 4
  //                        negation-shaped queries, 2-3
  //                        logical/factual false-premise
  //                        queries)
  //   orientation: +8  (target 26; new clusters covered,
  //                        legacy / near-miss distractor
  //                        pressure on 2 queries)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Family: exact (additional) — verbatim-ish token overlap
  // for the new clusters 26-33. (6 new queries; family
  // total: 20.)
  // -------------------------------------------------------------------------
  {
    id: "exact-false-premise-anchor-sidecar",
    family: "exact",
    query: "Was a vector-exporter sidecar adopted for the MCP server's metrics?",
    expectedIds: [121],
    currentTruthIds: [121],
    note:
      "Direct question about the false-premise-anchor record 121; should hit record 121 (the project uses a Prometheus endpoint, not a sidecar).",
  },
  {
    id: "exact-false-premise-anchor-vector-index",
    family: "exact",
    query: "Did the team adopt a Vector index for embeddings?",
    expectedIds: [122],
    currentTruthIds: [122],
    note:
      "Direct question about the false-premise-anchor record 122; should hit record 122 (the dense path runs in-memory only, no Vector index).",
  },
  {
    id: "exact-orientation-extension-nightly-benchmark",
    family: "exact",
    query: "Does the nightly CI job publish a retrieval benchmark badge?",
    expectedIds: [125],
    currentTruthIds: [125],
    note:
      "Direct question about the orientation-extension record 125; should hit record 125 (nightly benchmark + status badge).",
  },
  {
    id: "exact-multi-hop-bridge-audit-digest",
    family: "exact",
    query: "Is the audit log consumed by the weekly on-call digest?",
    expectedIds: [129],
    currentTruthIds: [129],
    note:
      "Direct question about the multi-hop-bridge record 129; should hit record 129 (audit retention feeds the weekly digest).",
  },
  {
    id: "exact-multi-hop-bridge-stdio-stderr",
    family: "exact",
    query: "Do application logs go to stderr and never to the stdio protocol port?",
    expectedIds: [132],
    currentTruthIds: [132],
    note:
      "Direct question about the multi-hop-bridge record 132; should hit record 132 (stdio transport, stderr-only logs).",
  },
  {
    id: "exact-superseded-anchor-postgres-15",
    family: "exact",
    query: "Is the project currently using Postgres 15 as the primary data store?",
    expectedIds: [105],
    currentTruthIds: [105],
    note:
      "Direct question about the superseded-anchor record 105 (labeled: it is the OLD fact); the current fact is record 1 (Postgres 16). The current-truth-id is 105 because the query is asking about Postgres 15 specifically (a labeled stale-fact trap).",
  },

  // -------------------------------------------------------------------------
  // Family: paraphrase (additional) — same idea, different
  // words, for the new clusters 26-33. (20 new queries;
  // family total: 32.) The new queries include:
  //   - 12 deep positive paraphrases for the new clusters
  //     (low lexical overlap with the source record, but
  //     semantically the right question).
  //   - 4 adversarial positive paraphrases with very low
  //     lexical overlap (the `adversarialParaphrase` label).
  //   - 2 positive paraphrases that resemble no-answer /
  //     false-premise wording but have valid evidence.
  //   - 2 paraphrases of the near-miss records (the
  //     `nearMissCurrentCluster` label).
  // -------------------------------------------------------------------------
  {
    id: "para-storage-twin",
    family: "paraphrase",
    query: "Where on disk are the saved project notes kept?",
    expectedIds: [113],
    currentTruthIds: [113],
    labels: ["adversarialParaphrase"],
    note:
      "Adversarial positive paraphrase. Targets the paraphrase-twin record 113 (low lexical overlap with the original 'cortex' / 'sqlite' vocabulary; uses 'saved notes' / 'on disk' instead).",
  },
  {
    id: "para-review-twin",
    family: "paraphrase",
    query: "What kind of writeup is expected when proposing a code change?",
    expectedIds: [114],
    currentTruthIds: [114],
    labels: ["adversarialParaphrase"],
    note:
      "Adversarial positive paraphrase. Targets the paraphrase-twin record 114 (uses 'writeup' / 'proposing' instead of 'pull request title' / 'review note').",
  },
  {
    id: "para-provider-twin",
    family: "paraphrase",
    query: "How does the model backend handle transient unavailability?",
    expectedIds: [115],
    currentTruthIds: [115],
    labels: ["adversarialParaphrase"],
    note:
      "Adversarial positive paraphrase. Targets the paraphrase-twin record 115 (uses 'model backend' / 'transient unavailability' instead of 'provider' / 'fallback').",
  },
  {
    id: "para-observability-twin",
    family: "paraphrase",
    query: "Is there a separate port exposing project metrics?",
    expectedIds: [116],
    currentTruthIds: [116],
    labels: ["adversarialParaphrase"],
    note:
      "Adversarial positive paraphrase. Targets the paraphrase-twin record 116 (uses 'separate port' / 'project metrics' instead of 'Prometheus endpoint' / 'observability').",
  },
  {
    id: "para-near-miss-postgres-team",
    family: "paraphrase",
    query: "Which team uses a different Postgres version?",
    expectedIds: [109],
    currentTruthIds: [109],
    labels: ["nearMissCurrentCluster"],
    note:
      "Deep paraphrase. Targets the near-miss record 109 (mobile team uses Postgres 14 while the platform team uses Postgres 16). The current record 1 IS in the corpus but the question is 'which team uses a different version', so the right expected id is the near-miss.",
  },
  {
    id: "para-near-miss-mcp-team",
    family: "paraphrase",
    query: "Which team uses a different MCP transport?",
    expectedIds: [110],
    currentTruthIds: [110],
    labels: ["nearMissCurrentCluster"],
    note:
      "Deep paraphrase. Targets the near-miss record 110 (web team's HTTP bridge vs. the platform team's stdio SDK).",
  },
  {
    id: "para-near-miss-oncall-team",
    family: "paraphrase",
    query: "Which team has a different on-call handoff schedule?",
    expectedIds: [111],
    currentTruthIds: [111],
    labels: ["nearMissCurrentCluster"],
    note:
      "Deep paraphrase. Targets the near-miss record 111 (data team's Wednesday handoff vs. the platform team's Monday handoff).",
  },
  {
    id: "para-false-premise-anchor-shapes-like",
    family: "paraphrase",
    query: "Tell me about the sidecar you adopted for the metrics port.",
    expectedIds: [121],
    currentTruthIds: [121],
    note:
      "Positive paraphrase that resembles no-answer / false-premise wording ('Tell me about the sidecar you adopted' suggests the sidecar exists). The anchor record 121 explicitly says the sidecar was NOT adopted. The query has a valid answer (record 121) and the expected id is the anchor — the lexical ranker should find the anchor by sharing 'sidecar' / 'metrics' tokens.",
  },
  {
    id: "para-false-premise-anchor-vector-index-shapes-like",
    family: "paraphrase",
    query: "Show me the Vector index you added for embeddings.",
    expectedIds: [122],
    currentTruthIds: [122],
    note:
      "Positive paraphrase that resembles no-answer / false-premise wording ('the Vector index you added' suggests the index exists). The anchor record 122 says the index was NOT adopted. The query has a valid answer (record 122).",
  },
  {
    id: "para-conflict-secrets-file",
    family: "paraphrase",
    query: "Is the secrets file the runtime source of truth?",
    expectedIds: [101],
    currentTruthIds: [101],
    note:
      "Positive paraphrase of the conflict record 101. The query wording ('Is the secrets file the runtime source of truth') mirrors the record's wording. A naive paraphrase trap: the record's summary is in the corpus as an EXTRA / conflict record; a future phase could deprecate it, but for now it is a valid expected id.",
  },
  {
    id: "para-conflict-auth-log",
    family: "paraphrase",
    query: "Do you log the auth credential header on a 401?",
    expectedIds: [102],
    currentTruthIds: [102],
    note:
      "Positive paraphrase of the conflict record 102 (HTTP client logs the auth credential header on 401). A naive paraphrase trap: the record exists in the corpus and the query is a valid paraphrase of it.",
  },
  {
    id: "para-superseded-postgres-15",
    family: "paraphrase",
    query: "Was the project's primary data store Postgres 15 last quarter?",
    expectedIds: [105],
    currentTruthIds: [105],
    note:
      "Paraphrase of the superseded record 105 (the OLD fact). The current fact (Postgres 16, record 1) is in the corpus; the query asks about the OLD fact and the expected id is the superseded anchor. A labeled stale-fact trap.",
  },
  {
    id: "para-superseded-node-20",
    family: "paraphrase",
    query: "Did the runtime previously run on Node 20?",
    expectedIds: [106],
    currentTruthIds: [106],
    note:
      "Paraphrase of the superseded record 106 (the OLD runtime). The current runtime is Node 22 (record 2). The query asks about the OLD runtime; expected id is the superseded anchor.",
  },
  {
    id: "para-superseded-controller-validation",
    family: "paraphrase",
    query: "Did the controller previously accept any provider output without validation?",
    expectedIds: [107],
    currentTruthIds: [107],
    note:
      "Paraphrase of the superseded record 107 (the OLD controller). The current controller validates (record 96 / record 50). Expected id is the superseded anchor.",
  },
  {
    id: "para-current-vs-previous-postgres",
    family: "paraphrase",
    query: "How does the current Postgres setup differ from the previous one?",
    expectedIds: [117],
    currentTruthIds: [117],
    note:
      "Deep paraphrase of the current-vs-previous record 117. The query asks about the CURRENT vs the PREVIOUS; the expected id is the current-vs-previous anchor (which has both in one record). The other current record (1) is also in the corpus; the disambiguation is the focus.",
  },
  {
    id: "para-current-vs-previous-release",
    family: "paraphrase",
    query: "What changed between the previous release cut and the current one?",
    expectedIds: [118],
    currentTruthIds: [118],
    note:
      "Deep paraphrase of the current-vs-previous record 118. The query asks about the CURRENT vs the PREVIOUS; the expected id is the current-vs-previous anchor.",
  },
  {
    id: "para-bridge-audit-digest",
    family: "paraphrase",
    query: "Where do the audit retention days and the weekly on-call summary meet?",
    expectedIds: [129],
    currentTruthIds: [129],
    note:
      "Deep paraphrase of the multi-hop-bridge record 129 (audit retention feeds the digest). The query wording forces the ranker to find the bridge record, not the audit-only (72) or digest-only (68) records.",
  },
  {
    id: "para-bridge-rate-limit-retry",
    family: "paraphrase",
    query: "How does the rate-limit interact with the retry on 429?",
    expectedIds: [130],
    currentTruthIds: [130],
    note:
      "Deep paraphrase of the multi-hop-bridge record 130 (rate-limit feeds the exponential-backoff retry). The query forces the ranker to find the bridge record.",
  },
  {
    id: "para-bridge-recall-cache",
    family: "paraphrase",
    query: "Does the recall path share the in-memory provider response cache?",
    expectedIds: [131],
    currentTruthIds: [131],
    note:
      "Deep paraphrase of the multi-hop-bridge record 131 (recall fetches fresh, the in-memory cache is not shared with recall). The query forces the ranker to find the bridge record, not the cache-only (76) or recall-only (75) records.",
  },
  {
    id: "para-orientation-extension-coverage",
    family: "paraphrase",
    query: "Where does the coverage delta report go?",
    expectedIds: [126],
    currentTruthIds: [126],
    note:
      "Deep paraphrase of the orientation-extension record 126 (CI uploads the coverage delta to the team dashboard).",
  },

  // -------------------------------------------------------------------------
  // Family: temporal (additional) — supersession-style
  // queries for the new clusters 26-33. (14 new queries;
  // family total: 26; 5 labeled divergent cases total.)
  // The new queries include:
  //   - 3 more labeled divergent current-truth cases
  //     (raising total divergent from 2 to 5).
  //   - 3 stale-fact traps where the OLD evidence is
  //     lexically stronger than the current fact (the
  //     superseded-anchor records 105-108).
  //   - 2 "current vs previous" disambiguation queries
  //     that require the ranker to surface the
  //     current-vs-previous anchor (records 117-120).
  //   - 2 control temporal queries (the legacy
  //     supersession pattern from the prior
  //     expanded-checkpoint).
  //   - 4 multi-hop temporal queries (mixed
  //     current / superseded evidence; see the
  //     multi-hop section below).
  // -------------------------------------------------------------------------
  {
    id: "temp-superseded-postgres-15-current",
    family: "temporal",
    query: "What version of Postgres does the project use now, and what was it last quarter?",
    expectedIds: [1, 105],
    currentTruthIds: [1],
    labels: ["divergentTemporal"],
    note:
      "Labeled divergent current-truth temporal query. expectedIds=[1 (current), 105 (superseded anchor)]. The superseded record 105 is the LEXICALLY STRONGER 'last quarter' trap; a temporal query about 'now' should surface 1, and a query about 'last quarter' should surface 105. The current-truth id is 1 (the current fact).",
  },
  {
    id: "temp-superseded-controller-validation-current",
    family: "temporal",
    query: "Does the controller validate the provider output now, or accept anything?",
    expectedIds: [50, 107],
    currentTruthIds: [50],
    labels: ["divergentTemporal"],
    note:
      "Labeled divergent current-truth temporal query. expectedIds=[50 (current schema), 107 (superseded controller)]. The superseded record 107 is the LEXICALLY STRONGER 'accept anything' trap; the current fact (record 50) is the validation policy. currentTruth=50.",
  },
  {
    id: "temp-superseded-oncall-handoff-current",
    family: "temporal",
    query: "Is the on-call handoff on Mondays at 10:00 now, or was it on Fridays at 16:00 before?",
    expectedIds: [11, 120],
    currentTruthIds: [11],
    labels: ["divergentTemporal"],
    note:
      "Labeled divergent current-truth temporal query. expectedIds=[11 (current oncall), 120 (current-vs-previous anchor for the oncall schedule)]. The anchor 120 includes BOTH the current and previous schedule; the current-truth id is 11 (the current fact alone).",
  },
  {
    id: "temp-superseded-stale-fact-trap-postgres",
    family: "temporal",
    query: "What is the current primary data store, and what was the project using before?",
    expectedIds: [1, 21, 105],
    currentTruthIds: [1],
    labels: ["divergentTemporal"],
    note:
      "Labeled divergent current-truth temporal query. expectedIds=[1 (current), 21 (old Postgres 14), 105 (superseded Postgres 15)]. The lexical ranker must rank 1 at rank-1; 105 and 21 are the lexically stronger 'Postgres' traps. The fixture's current-truth id is 1.",
  },
  {
    id: "temp-current-vs-previous-postgres",
    family: "temporal",
    query: "How does the current Postgres replication setup differ from the previous one?",
    expectedIds: [117],
    currentTruthIds: [117],
    note:
      "Temporal query that requires distinguishing the current-vs-previous anchor (117) from the current-only (1) and the prior temporal-old records (21, 57-60). The anchor explicitly names BOTH the current and previous setups; the query asks for the difference.",
  },
  {
    id: "temp-current-vs-previous-release",
    family: "temporal",
    query: "How does the current release cut differ from the previous one?",
    expectedIds: [118],
    currentTruthIds: [118],
    note:
      "Temporal query that requires distinguishing the current-vs-previous anchor (118) from the current-only (7) and the prior temporal-old records (22).",
  },
  {
    id: "temp-current-vs-previous-safety",
    family: "temporal",
    query: "How does the current safety pipeline differ from the previous one?",
    expectedIds: [119],
    currentTruthIds: [119],
    note:
      "Temporal query that requires distinguishing the current-vs-previous anchor (119) from the current-only (69) and the prior temporal-old records (24, 108).",
  },
  {
    id: "temp-stale-fact-trap-runtime",
    family: "temporal",
    query: "What runtime does the server use today?",
    expectedIds: [2],
    currentTruthIds: [2],
    note:
      "Stale-fact trap: the current record 2 (Node 22) is in the corpus; the superseded record 106 (Node 20) is also in the corpus and is the lexically stronger 'Node' trap. The query asks for the CURRENT runtime.",
  },
  {
    id: "temp-stale-fact-trap-safety",
    family: "temporal",
    query: "What safety mechanism is in use today?",
    expectedIds: [69],
    currentTruthIds: [69],
    note:
      "Stale-fact trap: the current record 69 (regex-based classifier with allow-list) is in the corpus; the superseded record 108 (hard-coded blocklist) is also in the corpus and is the lexically stronger 'blocklist' trap.",
  },
  {
    id: "temp-conflict-controller-vs-classifier",
    family: "temporal",
    query: "Does the safety classifier or the controller decide what to save?",
    expectedIds: [69],
    currentTruthIds: [69],
    note:
      "Conflict record test: the conflict record 96 ('controller validates') is in the corpus; the current record 69 ('classifier runs before the controller') is the current truth. The query asks which one decides, and the answer is the classifier (which gates BEFORE the controller).",
  },
  {
    id: "temp-superseded-retrieval-design-current",
    family: "temporal",
    query: "What does the current retrieval layer look like, and what was it before?",
    expectedIds: [3, 104],
    currentTruthIds: [3],
    labels: ["divergentTemporal"],
    note:
      "Labeled divergent current-truth temporal query. expectedIds=[3 (current), 104 (conflict-superseded)], currentTruthIds=[3] (current only). The conflict record 104 says 'single pass, no re-ranking' (the OLD design), which the conflict cluster deliberately keeps in the corpus as a stronger distractor.",
  },
  {
    id: "temp-current-vs-previous-oncall",
    family: "temporal",
    query: "What changed between the previous on-call handoff and the current one?",
    expectedIds: [120],
    currentTruthIds: [120],
    note:
      "Temporal query that requires the current-vs-previous anchor (120) for the on-call schedule. The other temporal-old records (11, 96-100) do not name BOTH the current and the previous handoff.",
  },
  {
    id: "temp-stale-fact-trap-release",
    family: "temporal",
    query: "When does the team cut releases today?",
    expectedIds: [7],
    currentTruthIds: [7],
    note:
      "Stale-fact trap: the current record 7 (Tuesday main-branch cut) is in the corpus; the conflict record 103 (Thursday release-branch cut) and the temporal-old record 22 are also in the corpus. The query asks for the CURRENT cut.",
  },
  {
    id: "temp-superseded-conflict-secrets",
    family: "temporal",
    query: "Is the API key material stored in .cortex/secrets.json at runtime?",
    expectedIds: [29],
    currentTruthIds: [29],
    note:
      "Conflict record test: the conflict record 101 ('API keys stored in .cortex/secrets.json') is in the corpus; the current record 29 ('API keys read from environment variables only') is the current truth. The query asks about the current state.",
  },

  // -------------------------------------------------------------------------
  // Family: multi-hop (additional) — answer requires joining
  // multiple memories from the new clusters. (10 new queries;
  // family total: 26.) The new queries include:
  //   - 4 temporal multi-hop queries (mixed current /
  //     superseded evidence; the lexical ranker has to
  //     surface both the current and the old fact).
  //   - 1 multi-hop with a near-miss distractor on one
  //     hop (the near-miss record is the wrong version
  //     of the same team / service / product).
  //   - 5 control multi-hop queries (the prior
  //     multi-hop pattern, on the new clusters 26-33).
  // -------------------------------------------------------------------------
  {
    id: "multi-temporal-current-and-superseded-postgres",
    family: "multi-hop",
    query: "What is the current primary data store AND the previous version the team is migrating from?",
    expectedIds: [1, 105],
    currentTruthIds: [1, 105],
    note:
      "Temporal multi-hop. expectedIds=[1 (current), 105 (superseded)]. The query needs BOTH the current Postgres 16 record AND the superseded Postgres 15 record; the lexical ranker has to surface both.",
  },
  {
    id: "multi-temporal-current-and-superseded-controller",
    family: "multi-hop",
    query: "What does the current controller validation do AND what was the previous behavior?",
    expectedIds: [50, 107],
    currentTruthIds: [50, 107],
    note:
      "Temporal multi-hop. expectedIds=[50 (current schema), 107 (superseded controller)]. The query needs BOTH the current validation record AND the superseded no-validation record.",
  },
  {
    id: "multi-temporal-current-and-superseded-runtime",
    family: "multi-hop",
    query: "What is the current runtime AND what was the previous runtime version?",
    expectedIds: [2, 106],
    currentTruthIds: [2, 106],
    note:
      "Temporal multi-hop. expectedIds=[2 (current), 106 (superseded)]. The query needs BOTH the current Node 22 record AND the superseded Node 20 record.",
  },
  {
    id: "multi-temporal-current-and-superseded-safety",
    family: "multi-hop",
    query: "What is the current safety classifier AND what was the previous mechanism?",
    expectedIds: [69, 108],
    currentTruthIds: [69, 108],
    note:
      "Temporal multi-hop. expectedIds=[69 (current), 108 (superseded)]. The query needs BOTH the current regex-based classifier AND the superseded hard-coded blocklist record.",
  },
  {
    id: "multi-bridge-audit-digest-and-retention",
    family: "multi-hop",
    query: "How does the audit retention window connect to the on-call digest?",
    expectedIds: [72, 129],
    currentTruthIds: [72, 129],
    note:
      "Multi-hop with a bridge. expectedIds=[72 (audit retention), 129 (the bridge record)]. The query needs BOTH the audit retention record AND the bridge record that explicitly ties retention to the digest. The bridge is the multi-hop-bridge cluster's record 129.",
  },
  {
    id: "multi-bridge-rate-limit-and-retry",
    family: "multi-hop",
    query: "How does the rate-limit policy and the exponential-backoff retry on 429 fit together?",
    expectedIds: [70, 130],
    currentTruthIds: [70, 130],
    note:
      "Multi-hop with a bridge. expectedIds=[70 (rate-limit), 130 (the bridge record)]. The query needs BOTH the rate-limit record AND the bridge record that explicitly ties the rate-limit to the retry.",
  },
  {
    id: "multi-bridge-recall-and-cache",
    family: "multi-hop",
    query: "What is the relationship between the recall tool and the in-memory provider cache?",
    expectedIds: [75, 131],
    currentTruthIds: [75, 131],
    note:
      "Multi-hop with a bridge. expectedIds=[75 (recall limit), 131 (the bridge record)]. The query needs BOTH the recall-limit record AND the bridge record that explicitly says recall does NOT share the cache.",
  },
  {
    id: "multi-near-miss-postgres-versions",
    family: "multi-hop",
    query: "Which teams use which Postgres versions, and which is the platform team's?",
    expectedIds: [1, 109],
    currentTruthIds: [1, 109],
    labels: ["nearMissCurrentCluster"],
    note:
      "Multi-hop with a near-miss distractor. expectedIds=[1 (platform team's Postgres 16), 109 (the near-miss record for the mobile team's Postgres 14)]. The query needs BOTH the platform team's current record AND the near-miss distractor; the lexical ranker must surface the near-miss to disambiguate.",
  },
  {
    id: "multi-near-miss-oncall-schedules",
    family: "multi-hop",
    query: "Which team has which on-call handoff schedule, and which is the platform team's?",
    expectedIds: [11, 111],
    currentTruthIds: [11, 111],
    labels: ["nearMissCurrentCluster"],
    note:
      "Multi-hop with a near-miss distractor. expectedIds=[11 (platform team's Monday handoff), 111 (the near-miss record for the data team's Wednesday handoff)]. The query needs BOTH the platform team's current record AND the near-miss distractor.",
  },
  {
    id: "multi-bridge-stdio-and-stderr",
    family: "multi-hop",
    query: "How do the stdio transport and the stderr-only logging fit together?",
    expectedIds: [37, 132],
    currentTruthIds: [37, 132],
    note:
      "Multi-hop with a bridge. expectedIds=[37 (stderr-only logging), 132 (the bridge record that names both stdio and stderr)]. The query needs BOTH the logging record AND the bridge record that ties logging to the transport.",
  },

  // -------------------------------------------------------------------------
  // Family: no-answer (additional) — no relevant memory in
  // the corpus. (22 new queries; family total: 46.) The
  // new queries include:
  //   - 10 hard-negatives overlapping current non-legacy
  //     clusters (the new false-premise-anchor records
  //     + a few conflict / near-miss overlaps).
  //   - 5 OOD entities NOT in the legacy
  //     FALSE_PREMISE_TOKENS / OOD_ENTITY_TOKENS list
  //     (the brief's "new entity, not in the legacy
  //     list" requirement).
  //   - 4 negation-shaped no-answer queries
  //     (`is the project NOT using X`).
  //   - 3 logical / factual false-premise queries
  //     (the question is well-formed but the premise
  //     is wrong; the corpus explicitly addresses the
  //     premise in a way that confirms the no-answer).
  // -------------------------------------------------------------------------
  {
    id: "nonexistent-vector-exporter-sidecar",
    family: "no-answer",
    query: "How is the vector-exporter sidecar configured for the metrics port?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 121 shares 'sidecar' / 'metrics' / 'port' tokens with the query but the sidecar was NOT adopted. The lexical baseline is expected to confabulate on this query. The query is asking about a tool the corpus does not have.",
  },
  {
    id: "nonexistent-vector-index-embeddings",
    family: "no-answer",
    query: "How is the Vector index kept in sync with the embeddings table?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 122 shares 'Vector' / 'embeddings' tokens with the query but the Vector index was NOT adopted. The dense path runs in-memory only.",
  },
  {
    id: "nonexistent-kafka-events",
    family: "no-answer",
    query: "How is the Kafka topic partitioned for cross-process event delivery?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 123 shares 'Kafka' / 'events' / 'process' tokens with the query but the project does NOT use Kafka. The event bus is in-process.",
  },
  {
    id: "nonexistent-lambda-deploy",
    family: "no-answer",
    query: "How is the AWS Lambda deployment target configured?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 124 shares 'AWS' / 'Lambda' / 'deployment target' tokens with the query but the project does NOT run on AWS Lambda. The deployment target is the team-managed cluster.",
  },
  {
    id: "nonexistent-sidecar-cache",
    family: "no-answer",
    query: "How is the agent sidecar cache kept consistent?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 121 (sidecar NOT adopted) and the agent runtime records 73-76 share 'agent' / 'cache' tokens. The project does NOT have a sidecar.",
  },
  {
    id: "nonexistent-eventbridge-bus",
    family: "no-answer",
    query: "How is the EventBridge bus used for cross-process events?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 123 (Kafka not adopted) and the agent runtime records share 'events' / 'process' tokens. The project does NOT have an EventBridge bus either.",
  },
  {
    id: "nonexistent-vector-sidecar-metrics",
    family: "no-answer",
    query: "How is the Vector sidecar collecting metrics?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor records 121 (vector-exporter sidecar) and 122 (Vector index) both share 'Vector' / 'sidecar' / 'metrics' tokens. Neither tool is in the project.",
  },
  {
    id: "nonexistent-pulsar-events",
    family: "no-answer",
    query: "How is the Pulsar topic configured for events?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 123 (Kafka not adopted) and the agent runtime records share 'events' tokens. The project does NOT use Pulsar either.",
  },
  {
    id: "nonexistent-lambda-edge-runtime",
    family: "no-answer",
    query: "How is the AWS Lambda@Edge runtime configured?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor record 124 (AWS Lambda not adopted) and the agent runtime records share 'AWS' / 'Lambda' / 'runtime' tokens. The project does NOT use Lambda@Edge.",
  },
  {
    id: "nonexistent-flink-pipeline",
    family: "no-answer",
    query: "How is the Flink pipeline checkpointed?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The new false-premise-anchor records 123 (Kafka not adopted) and the data pipeline records share 'pipeline' tokens. The project does NOT use Flink.",
  },
  {
    id: "nonexistent-tigris-storage",
    family: "no-answer",
    query: "How is the Tigris storage bucket configured?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The data pipeline records 77-80 share 'storage' / 'sqlite' tokens with the new false-premise-anchor pattern. The project does NOT use Tigris.",
  },
  {
    id: "nonexistent-terraform-apply",
    family: "no-answer",
    query: "How is the Terraform apply workflow gated?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The deploy cluster records 5-8 share 'deploy' / 'rolling' tokens with the false-premise pattern. The project does NOT use Terraform (deploy is via the team-managed cluster).",
  },
  {
    id: "nonexistent-argo-rollouts",
    family: "no-answer",
    query: "How is the Argo Rollouts controller configured?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The deploy cluster records 5-8 share 'deploy' / 'rolling' tokens with the false-premise pattern. The project does NOT use Argo Rollouts.",
  },
  {
    id: "nonexistent-istio-mesh",
    family: "no-answer",
    query: "How is the Istio service mesh configured for the agent runtime?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The agent runtime records 73-76 share 'agent' / 'runtime' / 'service' tokens with the false-premise pattern. The project does NOT use Istio.",
  },
  {
    id: "nonexistent-otel-collector",
    family: "no-answer",
    query: "How is the OTel collector configured for traces?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["hardNegative"],
    note:
      "LABELLED HARD-NEGATIVE. The observability-extension records 65-68 share 'metrics' / 'traces' / 'request' tokens with the false-premise pattern. The project does NOT use the OTel collector (tracing uses the request id stitching).",
  },
  {
    id: "nonexistent-not-mobile",
    family: "no-answer",
    query: "What is NOT the deployment target of the mobile app?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["negation", "falsePremise"],
    note:
      "NEGATION-SHAPED no-answer query. The question is well-formed but the corpus has no 'mobile app' record. The negation token 'NOT' fires the negation detector; the false-premise token 'mobile app' fires the false-premise detector.",
  },
  {
    id: "nonexistent-not-lambda",
    family: "no-answer",
    query: "What runtime is the project NOT deployed on?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["negation", "falsePremise"],
    note:
      "NEGATION-SHAPED no-answer query. The corpus says the project is on the team-managed cluster; the query asks what it is NOT deployed on. The 'AWS Lambda' / 'Lambda' tokens are negated. The negation token 'NOT' fires the negation detector; the false-premise token 'lambda' fires the false-premise detector.",
  },
  {
    id: "nonexistent-not-vector-index",
    family: "no-answer",
    query: "Which embedding index does the project NOT use?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["negation", "falsePremise"],
    note:
      "NEGATION-SHAPED no-answer query. The corpus says the dense path runs in-memory only. The query asks which index the project does NOT use. The 'Vector' / 'index' tokens fire the false-premise detector.",
  },
  {
    id: "nonexistent-not-kafka",
    family: "no-answer",
    query: "Which event bus does the project NOT use?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["negation", "falsePremise"],
    note:
      "NEGATION-SHAPED no-answer query. The corpus says the event bus is in-process. The query asks which event bus the project does NOT use. The 'Kafka' / 'event bus' tokens fire the false-premise detector.",
  },
  {
    id: "nonexistent-fp-sidecar-runtime",
    family: "no-answer",
    query: "When was the sidecar runtime added to the deployment?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["falsePremise"],
    note:
      "LOGICAL/FACTUAL FALSE-PREMISE. The premise 'the sidecar runtime' is wrong; the project does NOT have a sidecar. The corpus has the false-premise-anchor record 121 that explicitly says the sidecar was NOT adopted, so the question is a no-answer even though the corpus DOES mention a sidecar (in a record that refutes the premise).",
  },
  {
    id: "nonexistent-fp-lambda-cold-start",
    family: "no-answer",
    query: "What is the cold-start latency budget for the Lambda function?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["falsePremise"],
    note:
      "LOGICAL/FACTUAL FALSE-PREMISE. The premise 'the Lambda function' is wrong; the project does NOT use Lambda. The corpus has the false-premise-anchor record 124 that explicitly says the team does NOT run on AWS Lambda.",
  },
  {
    id: "nonexistent-fp-kafka-consumer-group",
    family: "no-answer",
    query: "What is the consumer group id for the Kafka topic?",
    expectedIds: [],
    currentTruthIds: [],
    labels: ["falsePremise"],
    note:
      "LOGICAL/FACTUAL FALSE-PREMISE. The premise 'the Kafka topic' is wrong; the project does NOT use Kafka. The corpus has the false-premise-anchor record 123 that explicitly says Kafka was not adopted.",
  },
  // queries for the new clusters 26-33. (8 new queries;
  // family total: 26.) The new queries include:
  //   - 4 orientation queries over the new clusters
  //     (the false-premise-anchor cluster, the
  //     orientation-extension cluster, the
  //     multi-hop-bridge cluster, the conflict /
  //     superseded / near-miss clusters).
  //   - 2 orientation queries with legacy /
  //     near-miss distractor pressure (the
  //     `nearMissCurrentCluster` label).
  //   - 2 orientation queries over the orientation-
  //     extension cluster that exercise the
  //     "newer record" while still having the
  //     older record as a near-miss.
  // -------------------------------------------------------------------------
  {
    id: "orient-false-premise-anchor-status",
    family: "orientation",
    query: "What tools has the team evaluated but not adopted for the metrics and embedding paths?",
    expectedIds: [121, 122, 124],
    currentTruthIds: [121, 122, 124],
    note:
      "Status: vector-exporter sidecar (121) + Vector index (122) + AWS Lambda (124). Three-slot query that exercises the false-premise-anchor cluster. The expected ids are the anchors; the question is about tools the team explicitly did NOT adopt.",
  },
  {
    id: "orient-orientation-extension-status",
    family: "orientation",
    query: "What is the orientation-extension CI surface?",
    expectedIds: [125, 126, 127, 128],
    currentTruthIds: [125, 126, 127, 128],
    note:
      "Status: nightly benchmark badge (125) + coverage delta to dashboard (126) + no-skip invariant (127) + Node 20/22 matrix (128). Four-slot query that exercises the orientation-extension cluster.",
  },
  {
    id: "orient-multi-hop-bridge-status",
    family: "orientation",
    query: "What are the multi-hop bridges between the security, provider, and agent clusters?",
    expectedIds: [129, 130, 131, 132],
    currentTruthIds: [129, 130, 131, 132],
    note:
      "Status: audit-digest bridge (129) + rate-limit-retry bridge (130) + recall-cache bridge (131) + stdio-stderr bridge (132). Four-slot query that exercises the multi-hop-bridge cluster.",
  },
  {
    id: "orient-conflict-status",
    family: "orientation",
    query: "What conflict / supersession records are in the corpus today?",
    expectedIds: [101, 102, 103, 104],
    currentTruthIds: [101, 102, 103, 104],
    note:
      "Status: secrets-file conflict (101) + auth-log conflict (102) + release-branch conflict (103) + retrieval-design conflict (104). Four-slot query that exercises the conflict cluster. A reviewer who wants the project to NEVER surface these as top-1 hits can use the query to audit the ranker's behavior on conflict records.",
  },
  {
    id: "orient-near-miss-status",
    family: "orientation",
    query: "Which teams have which near-miss operational differences?",
    expectedIds: [109, 110, 111, 112],
    currentTruthIds: [109, 110, 111, 112],
    labels: ["nearMissCurrentCluster"],
    note:
      "Status: mobile team's Postgres 14 (109) + web team's HTTP bridge (110) + data team's Wednesday handoff (111) + docs team's Friday release (112). Four-slot query with near-miss distractor pressure. The query deliberately asks about the near-miss cluster so a reviewer can audit whether the ranker surfaces the near-miss as a top-1 hit on a generic team-difference query.",
  },
  {
    id: "orient-superseded-status",
    family: "orientation",
    query: "What superseded records are in the corpus today?",
    expectedIds: [105, 106, 107, 108],
    currentTruthIds: [105, 106, 107, 108],
    labels: ["nearMissCurrentCluster"],
    note:
      "Status: Postgres 15 (105) + Node 20 (106) + no-validation controller (107) + hard-coded blocklist (108). Four-slot query with near-miss / superseded distractor pressure.",
  },
  {
    id: "orient-current-vs-previous-status",
    family: "orientation",
    query: "What current-vs-previous pairs are in the corpus today?",
    expectedIds: [117, 118, 119, 120],
    currentTruthIds: [117, 118, 119, 120],
    note:
      "Status: postgres (117) + release (118) + safety (119) + oncall (120). Four-slot query over the current-vs-previous cluster. A reviewer can use this query to audit whether the ranker surfaces the current-vs-previous anchors on a generic 'what changed' query.",
  },
  {
    id: "orient-adversarial-extension-pair",
    family: "orientation",
    query: "What is the current CI surface and the older extension that pre-dates it?",
    expectedIds: [61, 62, 125, 126],
    currentTruthIds: [61, 62, 125, 126],
    note:
      "Status: lint required (61) + coverage merge gate (62) + nightly benchmark badge (125) + coverage delta to dashboard (126). Four-slot orientation query that mixes the original ci-extensions cluster (61, 62) with the new orientation-extension cluster (125, 126). A reviewer can audit whether the ranker surfaces the newer record on a generic CI query.",
  },
];
