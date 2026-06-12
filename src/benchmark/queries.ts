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
 * Expanded-checkpoint query count: the expanded checkpoint
 * contains 96 queries across the six families (exact=14,
 * paraphrase=12, temporal=12, multi-hop=16, no-answer=24,
 * orientation=18). Two of the temporal queries are labeled
 * "divergent current-truth" cases (`temp-storage-raw-text` and
 * `temp-controller-validation`); the labeled set is a strict
 * subset of the temporal family and the per-query
 * `currentTruthIds` field is a strict subset of `expectedIds`
 * for those queries. Adding a new divergent query requires
 * updating the `divergentIds` set in
 * `tests/retrieval-benchmark.test.ts`.
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
   * `temporal` queries the expected id IS the current fact, so
   * `currentTruthIds` matches `expectedIds`; the field is kept
   * separate so the current-truth@1 metric is a labeled,
   * first-class concept in the data and in the report, not an
   * implicit property of the family name.
   *
   * A small labeled set of `temporal` queries (the "divergent
   * current-truth" cases) deliberately has `expectedIds`
   * containing both the old and the new fact, with
   * `currentTruthIds` containing only the new fact. For these
   * queries the ranker can pass `hit@K` (it surfaced the new
   * fact) and still fail `currentTruthAt1` (the old fact was at
   * the top). The contract test in
   * `tests/retrieval-benchmark.test.ts` pins which queries are
   * allowed to diverge.
   */
  currentTruthIds: number[];
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
];
