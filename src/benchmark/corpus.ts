/**
 * Retrieval benchmark fixture corpus.
 *
 * A hand-curated set of sanitized memory summaries that
 * approximates the kind of content `remember` would persist after
 * controller normalization. The corpus is intentionally
 * hand-curated and is the **expanded** checkpoint (100 records)
 * between the 60-record intermediate corpus and a future
 * 132-record adversarial corpus. The expanded checkpoint adds
 * ten additional topical clusters (CI extensions, observability
 * extensions, security extensions, agent runtime, data pipeline,
 * client SDK, feature flags, provider routing, legacy extensions,
 * testing extensions-2) so the ranker's failure modes are less
 * volatile run-to-run, while keeping the corpus small enough to
 * be hand-curated and reviewed.
 *
 * The topical clusters are:
 *
 *   - "stack"                  — Postgres, TypeScript, Node, MCP, sqlite
 *   - "deploy"                 — CI pipeline, staging vs production, releases
 *   - "people"                 — team conventions, code review, on-call
 *   - "office"                 — non-project context (kitchen, plants, etc.)
 *   - "docs"                   — handbook and on-call runbook pointers
 *   - "temporal-old"           — historical / superseded previous versions
 *   - "testing"                — test conventions, fixtures, CI, coverage
 *   - "security"               — safety, secrets handling, auth posture
 *   - "dependencies"           — package mgmt, upgrade policy, lockfile
 *   - "monitoring"             — logs, metrics, alerts, on-call paging
 *   - "team-process"           — meetings, comms, planning cadence
 *   - "entity-domain"          — domain entities / record kinds
 *   - "stack-extensions"       — additional stack details that share tokens
 *                                with cluster 1
 *   - "testing-extensions"     — additional test infrastructure details
 *   - "historical-extensions"  — additional historical / superseded records
 *   - "ci-extensions"          — CI lint, coverage, matrix, nightly schedule
 *   - "observability-extensions" — metrics endpoint, request id, digest
 *   - "security-extensions"    — input gate, rate limit, TLS, audit
 *   - "agent-runtime"          — process model, mutex, recall limit, cache
 *   - "data-pipeline"          — SQLite WAL, backups, timestamps, soft delete
 *   - "client-sdk"             — public TS client SDK surface
 *   - "feature-flags"          — env-var source, default-empty, lifecycle
 *   - "provider-routing"       — primary/fallback, retry, typed result union
 *   - "legacy-extensions"      — additional historical / superseded records
 *                                (NOT in the orientation distractor set; the
 *                                distractor set stays {13..16, 21..24})
 *   - "testing-extensions-2"   — additional test infrastructure details
 *   - "adversarial-conflict"   — a labeled record that
 *                                DELIBERATELY contradicts a
 *                                current cluster-8/18/22 fact
 *                                so the conflict/contradiction
 *                                is visible in the corpus (a
 *                                reviewer can audit whether
 *                                the ranker is misled by a
 *                                contradicting record).
 *   - "adversarial-superseded"— a labeled record that
 *                                represents a SUPERSEDED
 *                                version of a current fact
 *                                (paired with the current
 *                                fact in the corpus, e.g.
 *                                "Postgres 15" alongside
 *                                "Postgres 16"), with a
 *                                CLEARER lexical hook than
 *                                the previous temporal-old
 *                                records. Used to test
 *                                "lexically stronger old
 *                                fact" temporal traps.
 *   - "adversarial-near-miss"  — a labeled record that is
 *                                intentionally close to a
 *                                current cluster but
 *                                names a different specific
 *                                fact (e.g. a different
 *                                team owner, a different
 *                                service, a different
 *                                product area). The
 *                                near-miss records are the
 *                                within-cluster distractors
 *                                the `nearMissCurrentCluster`
 *                                label exercises.
 *   - "adversarial-paraphrase-twin" — a labeled record
 *                                that paraphrases a current
 *                                cluster record with
 *                                deliberately LOW
 *                                lexical-overlap vocabulary.
 *                                The twin is the corpus-
 *                                side anchor for the
 *                                `adversarialParaphrase`
 *                                label: a positive query
 *                                that targets the twin has
 *                                to find the right
 *                                paraphrase, not a more
 *                                lexically obvious current
 *                                record in the same
 *                                cluster.
 *   - "adversarial-temporal-current-vs-previous" — a
 *                                labeled record that pairs
 *                                a CURRENT fact with a
 *                                NEAR-MISS / PREVIOUS fact
 *                                in the same cluster, so a
 *                                "current vs previous"
 *                                temporal query has to
 *                                distinguish them by
 *                                semantic detail (not by
 *                                lexical rarity).
 *   - "adversarial-false-premise-anchor" — a labeled
 *                                record that mentions a
 *                                NEAR-MISS tool that the
 *                                corpus does NOT
 *                                officially use. The
 *                                anchor is the
 *                                corpus-side co-occurrence
 *                                surface for the new
 *                                "OOD entity not in the
 *                                legacy token list"
 *                                no-answer queries: a
 *                                no-answer query that
 *                                mentions the near-miss
 *                                tool will share tokens
 *                                with the anchor and
 *                                become a labeled
 *                                confabulation pressure.
 *   - "adversarial-orientation-extension" — a labeled
 *                                record that extends an
 *                                existing orientation
 *                                cluster (e.g. an
 *                                additional CI extension
 *                                detail) so orientation
 *                                queries can test the
 *                                "newer" record while
 *                                still having the older
 *                                record as a near-miss
 *                                distractor.
 *   - "adversarial-multi-hop-bridge" — a labeled
 *                                record that is the
 *                                MISSING BRIDGE in a
 *                                multi-hop query: a
 *                                query that needs a
 *                                fact from cluster A
 *                                AND a fact from
 *                                cluster B can only
 *                                succeed if the
 *                                bridge record is
 *                                surfaced. The bridge
 *                                is the corpus-side
 *                                anchor for the
 *                                "multi-hop with a
 *                                near-miss distractor
 *                                on one hop" query.
 *
 * Each record has:
 *   - `id`       — stable, positive integer. Used as the expected id
 *                  in queries. IDs are deterministic so the benchmark
 *                  can be re-run across machines and produce
 *                  comparable reports.
 *   - `kind`     — one of the `MemoryKind` values from storage.
 *   - `summary`  — the controller-normalized summary. NEVER raw
 *                  input, NEVER containing a credential-shaped
 *                  fragment (the corpus is regression-checked in
 *                  `tests/retrieval-benchmark.test.ts`).
 *   - `tags`     — optional, used to exercise tag-overlap scoring.
 *
 * The benchmark runner treats the corpus as read-only, in-memory
 * candidate set. It does not open a SQLite database. This is a
 * measurement harness for the lexical baseline, not a storage
 * integration test.
 *
 * The runner loads these records into `LexicalCandidate` objects
 * and runs the production `rankLexical` function from
 * `src/retrieval/lexical.ts` against the queries below. The
 * production retrieval path is therefore exercised end-to-end
 * without touching the database or any provider.
 */

import type { MemoryKind } from "../storage/storage.js";

export interface BenchmarkMemoryRecord {
  /** Stable, positive integer. Used as the expected id in queries. */
  id: number;
  kind: MemoryKind;
  summary: string;
  tags?: string[];
}

/**
 * The benchmark corpus. Stable order. IDs are dense and
 * sequential (1..N) so failure reports can show the same id a
 * query expected and what came back. The corpus is the
 * adversarial-expansion checkpoint of 132 records, 33 topical
 * clusters of 4 records each (see the new clusters below).
 * The exact record count is part of the benchmark contract;
 * tests pin a minimum size and a per-family distribution.
 */
export const BENCHMARK_RECORDS: BenchmarkMemoryRecord[] = [
  // -------------------------------------------------------------------------
  // Cluster 1: stack (4)
  // -------------------------------------------------------------------------
  {
    id: 1,
    kind: "fact",
    summary:
      "The project uses Postgres 16 for the primary data store, chosen for stronger JSON support and mature tooling.",
    tags: ["postgres", "storage", "database"],
  },
  {
    id: 2,
    kind: "fact",
    summary:
      "The server is written in TypeScript on Node 22 with the Model Context Protocol SDK for the stdio transport.",
    tags: ["typescript", "node", "mcp"],
  },
  {
    id: 3,
    kind: "fact",
    summary:
      "The retrieval layer starts with a lexical ranker that uses normalized token overlap with a small exact-phrase boost.",
    tags: ["retrieval", "lexical", "ranking"],
  },
  {
    id: 4,
    kind: "fact",
    summary:
      "Project-local storage lives in a hidden .curion directory at the repository root, backed by a single SQLite file.",
    tags: ["storage", "sqlite", "curion"],
  },

  // -------------------------------------------------------------------------
  // Cluster 2: deploy (4)
  // -------------------------------------------------------------------------
  {
    id: 5,
    kind: "decision",
    summary:
      "Staging runs on a single small VM; production runs on a managed cluster with at least two replicas per service.",
    tags: ["deploy", "staging", "production"],
  },
  {
    id: 6,
    kind: "fact",
    summary:
      "The CI pipeline builds a TypeScript image, runs the safety fixture self-check, and uploads a coverage report.",
    tags: ["ci", "pipeline", "tests"],
  },
  {
    id: 7,
    kind: "decision",
    summary:
      "Releases are cut from the main branch on Tuesdays; hotfixes may ship any weekday after a maintainer review.",
    tags: ["release", "process", "schedule"],
  },
  {
    id: 8,
    kind: "fact",
    summary:
      "Rolling restarts are preferred over hard cuts in production; the deploy script waits for healthy probes between batches.",
    tags: ["deploy", "rollout", "operations"],
  },

  // -------------------------------------------------------------------------
  // Cluster 3: people (4)
  // -------------------------------------------------------------------------
  {
    id: 9,
    kind: "preference",
    summary:
      "Code review is expected to leave at least one substantive comment per nontrivial change, even on small PRs.",
    tags: ["review", "process", "team"],
  },
  {
    id: 10,
    kind: "preference",
    summary:
      "Pull request titles should be written in the imperative mood and describe the user-visible outcome of the change.",
    tags: ["review", "style", "team"],
  },
  {
    id: 11,
    kind: "context",
    summary:
      "The on-call rotation is shared across the platform team; handoff happens on Mondays at 10:00 local time.",
    tags: ["oncall", "process", "team"],
  },
  {
    id: 12,
    kind: "decision",
    summary:
      "All architectural decisions are recorded as ADRs in the docs directory and are linked from the relevant module README.",
    tags: ["architecture", "docs", "process"],
  },

  // -------------------------------------------------------------------------
  // Cluster 4: office (4) — deliberate distractors
  // -------------------------------------------------------------------------
  {
    id: 13,
    kind: "context",
    summary:
      "The office kitchen dishwasher runs nightly at 11pm Eastern; please load it before leaving for the day.",
    tags: ["office", "kitchen"],
  },
  {
    id: 14,
    kind: "context",
    summary:
      "Office plants are watered on a biweekly rotation by the facilities team; do not overwater the fern near the window.",
    tags: ["office", "plants"],
  },
  {
    id: 15,
    kind: "context",
    summary:
      "The standing desk converter in the back pod squeaks when raised; Facilities has been notified and a replacement is on order.",
    tags: ["office", "equipment"],
  },
  {
    id: 16,
    kind: "context",
    summary:
      "Friday lunch is catered; dietary preferences are tracked in the shared spreadsheet linked from the team channel.",
    tags: ["office", "lunch", "team"],
  },

  // -------------------------------------------------------------------------
  // Cluster 5: docs (4)
  // -------------------------------------------------------------------------
  {
    id: 17,
    kind: "reference",
    summary:
      "The project handbook is published from the docs directory and is rebuilt by the docs CI workflow on every merge to main.",
    tags: ["docs", "handbook"],
  },
  {
    id: 18,
    kind: "reference",
    summary:
      "The on-call runbook covers incident triage, common alerts, and the escalation path; the runbook lives at docs/runbook.md.",
    tags: ["docs", "runbook", "oncall"],
  },
  {
    id: 19,
    kind: "fact",
    summary:
      "The architecture overview diagram is generated from the source tree at build time and is checked into docs/architecture.md.",
    tags: ["docs", "architecture"],
  },
  {
    id: 20,
    kind: "reference",
    summary:
      "The provider prototype runner is documented in the README under the Provider prototype runner section.",
    tags: ["docs", "provider", "prototype"],
  },

  // -------------------------------------------------------------------------
  // Cluster 6: temporal / supersession-style (4)
  // -------------------------------------------------------------------------
  {
    id: 21,
    kind: "fact",
    summary:
      "As of the Q2 review, the project primary data store was Postgres 14; the team was evaluating an upgrade to a newer major version.",
    tags: ["postgres", "history"],
  },
  {
    id: 22,
    kind: "fact",
    summary:
      "Previously, releases were cut from a release branch on Thursdays; the team switched to a main-branch Tuesday cut in late 2024.",
    tags: ["release", "history", "process"],
  },
  {
    id: 23,
    kind: "fact",
    summary:
      "Earlier iterations of the retrieval layer used a single pass over summaries; the current design re-ranks candidates before provider synthesis.",
    tags: ["retrieval", "history"],
  },
  {
    id: 24,
    kind: "fact",
    summary:
      "The first version of the safety policy used a hard-coded blocklist; the current classifier is regex-based with a small allow-list for test scope.",
    tags: ["safety", "history"],
  },

  // -------------------------------------------------------------------------
  // Cluster 7: testing (4)
  // -------------------------------------------------------------------------
  {
    id: 25,
    kind: "preference",
    summary:
      "Unit tests are colocated with the source file they cover and follow a describe/it structure; integration tests live under tests/.",
    tags: ["testing", "style", "process"],
  },
  {
    id: 26,
    kind: "decision",
    summary:
      "The test runner is the built-in node:test module with tsx; new dependencies are not added for testing infrastructure.",
    tags: ["testing", "runner", "tooling"],
  },
  {
    id: 27,
    kind: "fact",
    summary:
      "Coverage is reported by the CI pipeline on every merge; a regression of more than two percentage points fails the safety fixture self-check.",
    tags: ["testing", "coverage", "ci"],
  },
  {
    id: 28,
    kind: "reference",
    summary:
      "Safety fixtures under src/safety/fixtures.ts are regression-checked against the classifier in tests/safety-fixtures.test.ts.",
    tags: ["testing", "fixtures", "safety"],
  },

  // -------------------------------------------------------------------------
  // Cluster 8: security (4)
  // -------------------------------------------------------------------------
  {
    id: 29,
    kind: "decision",
    summary:
      "API keys are read from environment variables only; no key material is ever written to disk or to the .curion/ store.",
    tags: ["security", "secrets", "config"],
  },
  {
    id: 30,
    kind: "fact",
    summary:
      "The HTTP client scrubs Authorization and Bearer headers from any error message it returns so a key never leaks through a failure path.",
    tags: ["security", "http", "sanitization"],
  },
  {
    id: 31,
    kind: "decision",
    summary:
      "Production deployments require a separate signing key per environment; staging and production keys must never overlap.",
    tags: ["security", "deploy", "keys"],
  },
  {
    id: 32,
    kind: "preference",
    summary:
      "Dependency upgrades that touch authentication or crypto code require a security review before they are merged.",
    tags: ["security", "review", "process"],
  },

  // -------------------------------------------------------------------------
  // Cluster 9: dependencies (4)
  // -------------------------------------------------------------------------
  {
    id: 33,
    kind: "decision",
    summary:
      "The project uses npm with a checked-in package-lock.json; yarn and pnpm lockfiles are not accepted in PRs.",
    tags: ["dependencies", "npm", "lockfile"],
  },
  {
    id: 34,
    kind: "preference",
    summary:
      "Direct dependencies are pinned to an exact version range; transitive upgrades are reviewed in the weekly dependency review.",
    tags: ["dependencies", "versions", "process"],
  },
  {
    id: 35,
    kind: "fact",
    summary:
      "A weekly job opens a draft PR for out-of-date dependencies; the PR is reviewed, not auto-merged, even when CI is green.",
    tags: ["dependencies", "automation", "ci"],
  },
  {
    id: 36,
    kind: "decision",
    summary:
      "Major-version upgrades of the MCP SDK are scheduled on a quarterly cadence to limit blast radius across the stdio transport.",
    tags: ["dependencies", "mcp", "schedule"],
  },

  // -------------------------------------------------------------------------
  // Cluster 10: monitoring (4)
  // -------------------------------------------------------------------------
  {
    id: 37,
    kind: "fact",
    summary:
      "Application logs go to stderr only; the stdio transport must never write to stdout outside of MCP protocol frames.",
    tags: ["monitoring", "logging", "stdio"],
  },
  {
    id: 38,
    kind: "decision",
    summary:
      "Log level is controlled by the CURION_LOG_LEVEL environment variable and defaults to info; debug logs are filtered out at runtime.",
    tags: ["monitoring", "logging", "config"],
  },
  {
    id: 39,
    kind: "preference",
    summary:
      "Production alerts are routed to the on-call rotation; non-urgent warnings are summarized in the weekly ops digest.",
    tags: ["monitoring", "alerts", "oncall"],
  },
  {
    id: 40,
    kind: "reference",
    summary:
      "Common alert shapes and the escalation path are documented in the on-call runbook at docs/runbook.md.",
    tags: ["monitoring", "runbook", "oncall"],
  },

  // -------------------------------------------------------------------------
  // Cluster 11: team-process (4)
  // -------------------------------------------------------------------------
  {
    id: 41,
    kind: "preference",
    summary:
      "The team holds a short planning sync on Mondays; design discussions are deferred to the Wednesday architecture hour.",
    tags: ["team", "meetings", "process"],
  },
  {
    id: 42,
    kind: "decision",
    summary:
      "Async decisions are recorded as ADRs in the docs directory; verbal agreement in chat does not count as a decision.",
    tags: ["team", "decisions", "process"],
  },
  {
    id: 43,
    kind: "fact",
    summary:
      "The team communicates in a single shared channel; topic-specific threads are spun off only for active incidents.",
    tags: ["team", "communication", "process"],
  },
  {
    id: 44,
    kind: "preference",
    summary:
      "Pull request reviews are expected to land within one business day; stale PRs are surfaced in the Monday planning sync.",
    tags: ["team", "review", "process"],
  },

  // -------------------------------------------------------------------------
  // Cluster 12: entity-domain (4)
  // -------------------------------------------------------------------------
  {
    id: 45,
    kind: "reference",
    summary:
      "A memory record's kind is one of: decision, fact, preference, context, conflict, reference, finding; the controller normalizes provider output to one of these.",
    tags: ["domain", "memory", "kinds"],
  },
  {
    id: 46,
    kind: "reference",
    summary:
      "A memory's state is one of: active, superseded, invalidated; the active state is the only one the recall path returns.",
    tags: ["domain", "memory", "states"],
  },
  {
    id: 47,
    kind: "decision",
    summary:
      "Confidence is a float in [0, 1] reported by the provider; the recall path surfaces records whose confidence is at least 0.5 by default.",
    tags: ["domain", "memory", "confidence"],
  },
  {
    id: 48,
    kind: "fact",
    summary:
      "Safety flags are a comma-separated set of classifier labels attached to a record; the recall path filters out records flagged as secret or raw-dump.",
    tags: ["domain", "memory", "safety"],
  },

  // -------------------------------------------------------------------------
  // Cluster 13: stack-extensions (4) — additional stack details that
  // share tokens with cluster 1 to exercise lexical overlap / phrase
  // disambiguation. NOT distractors: they are current project context.
  // -------------------------------------------------------------------------
  {
    id: 49,
    kind: "fact",
    summary:
      "The schema layer uses better-sqlite3 with WAL journaling; foreign keys are enforced for the memories and embeddings tables.",
    tags: ["stack", "sqlite", "schema"],
  },
  {
    id: 50,
    kind: "fact",
    summary:
      "Schema migrations are additive and idempotent; column adds are wrapped so a partial upgrade cannot leave the schema in a mixed state.",
    tags: ["stack", "storage", "migrations"],
  },
  {
    id: 51,
    kind: "decision",
    summary:
      "The MCP SDK is pinned to the 1.x major version; the stdio transport is the only supported transport in this phase.",
    tags: ["stack", "mcp", "transport"],
  },
  {
    id: 52,
    kind: "fact",
    summary:
      "The controller is a small set of pure validation and normalization helpers; the provider adapter is the only network-touching layer.",
    tags: ["stack", "controller", "architecture"],
  },

  // -------------------------------------------------------------------------
  // Cluster 14: testing-extensions (4) — additional test infrastructure
  // details. Pairs with cluster 7 to give multi-hop queries a richer
  // list to retrieve from.
  // -------------------------------------------------------------------------
  {
    id: 53,
    kind: "decision",
    summary:
      "End-to-end tests for the prototype runner are gated by environment variables; they are not part of the default CI run.",
    tags: ["testing", "prototype", "ci"],
  },
  {
    id: 54,
    kind: "fact",
    summary:
      "The benchmark runner writes its JSON report under .curion/benchmark/ and is gitignored; the report is for local inspection only.",
    tags: ["testing", "benchmark", "artifacts"],
  },
  {
    id: 55,
    kind: "reference",
    summary:
      "Provider prototype fixtures P1 through P6 cover the structured-output schema; they are exercised by the prototype runner, not the MCP stdio server.",
    tags: ["testing", "provider", "fixtures"],
  },
  {
    id: 56,
    kind: "fact",
    summary:
      "The benchmark contract test pins the public MCP surface to exactly two tools, remember and recall; any future tool addition is a deliberate, visible change.",
    tags: ["testing", "contract", "public-api"],
  },

  // -------------------------------------------------------------------------
  // Cluster 15: historical-extensions (4) — additional historical /
  // superseded records. These are CURRENTLY NOT in the orientation
  // distractor set (that set stays {13..16, 21..24}); they are
  // available as legacy distractors for the new temporal queries
  // that exercise currentTruth divergence (the new "current" fact
  // is in expectedIds, the old fact is in this cluster).
  // -------------------------------------------------------------------------
  {
    id: 57,
    kind: "fact",
    summary:
      "Earlier the project stored raw input alongside normalized summaries; the current schema persists summaries only and the raw input column has been removed.",
    tags: ["storage", "history", "schema"],
  },
  {
    id: 58,
    kind: "fact",
    summary:
      "The original CI pipeline ran tests on a single self-hosted runner; it has since been moved to a managed CI service with matrix builds.",
    tags: ["ci", "history", "pipeline"],
  },
  {
    id: 59,
    kind: "fact",
    summary:
      "The first provider integration used a single primary endpoint; the current adapter supports a primary and a fallback endpoint with a typed result union.",
    tags: ["provider", "history", "adapter"],
  },
  {
    id: 60,
    kind: "fact",
    summary:
      "The previous monitoring setup polled external endpoints every minute; the current setup pushes structured events from the application on the same path.",
    tags: ["monitoring", "history", "events"],
  },

  // -------------------------------------------------------------------------
  // Cluster 16: ci-extensions (4) — additional CI / CD coverage. Pairs
  // with cluster 2 (deploy) to give the CI / pipeline queries a richer
  // top-K and to add exact / paraphrase anchors for the new CI queries.
  // -------------------------------------------------------------------------
  {
    id: 61,
    kind: "fact",
    summary:
      "The CI runs linters (eslint, prettier) on every push; the lint step is a required status check before a pull request can be merged.",
    tags: ["ci", "lint", "process"],
  },
  {
    id: 62,
    kind: "decision",
    summary:
      "The CI uploads a coverage report to the team dashboard; coverage drops of more than one percentage point on changed lines fail the merge gate.",
    tags: ["ci", "coverage", "process"],
  },
  {
    id: 63,
    kind: "fact",
    summary:
      "The CI uses a matrix of Node 20 and Node 22 for the test job; a single OS (Ubuntu) is used to keep the matrix narrow and predictable.",
    tags: ["ci", "matrix", "testing"],
  },
  {
    id: 64,
    kind: "reference",
    summary:
      "Nightly CI runs the full benchmark suite end-to-end and publishes the result as a status badge in the project README.",
    tags: ["ci", "benchmark", "schedule"],
  },

  // -------------------------------------------------------------------------
  // Cluster 17: observability-extensions (4) — additional observability
  // coverage. Pairs with cluster 10 (monitoring) to extend the
  // observability surface: metrics, request id stitching, error log
  // redaction, and the on-call digest cadence.
  // -------------------------------------------------------------------------
  {
    id: 65,
    kind: "fact",
    summary:
      "Application metrics are exported via a Prometheus endpoint on a separate port; the main MCP stdio port is unchanged.",
    tags: ["observability", "metrics", "prometheus"],
  },
  {
    id: 66,
    kind: "decision",
    summary:
      "Each request is logged with a request id; the same id is returned to the client in the response so traces can be stitched end-to-end.",
    tags: ["observability", "tracing", "request-id"],
  },
  {
    id: 67,
    kind: "decision",
    summary:
      "Stack traces are redacted of Authorization and Bearer headers before being persisted to the error log so a key never leaks through a failure path.",
    tags: ["observability", "security", "redaction"],
  },
  {
    id: 68,
    kind: "preference",
    summary:
      "The on-call digest is a weekly summary of non-urgent warnings; the digest is posted to the team channel every Monday morning at 9:00 local time.",
    tags: ["observability", "oncall", "digest"],
  },

  // -------------------------------------------------------------------------
  // Cluster 18: security-extensions (4) — additional security posture
  // coverage. Pairs with cluster 8 (security) to add input gating,
  // rate limit, TLS, and audit retention. The cluster overlaps with
  // cluster 8 on some tokens (auth, security) to test lexical
  // disambiguation between the two layers.
  // -------------------------------------------------------------------------
  {
    id: 69,
    kind: "decision",
    summary:
      "The safety classifier runs on every input before the controller; raw-dump and secret classifications are dropped without reaching the provider.",
    tags: ["security", "input-gate", "classifier"],
  },
  {
    id: 70,
    kind: "fact",
    summary:
      "Provider requests are rate-limited per environment; the limit is read from CURION_PROVIDER_RATE_LIMIT and defaults to sixty requests per minute.",
    tags: ["security", "rate-limit", "provider"],
  },
  {
    id: 71,
    kind: "decision",
    summary:
      "All HTTP traffic to providers uses TLS 1.2 or higher; HTTP/1.1 plaintext endpoints are not allowed in any environment.",
    tags: ["security", "tls", "transport"],
  },
  {
    id: 72,
    kind: "fact",
    summary:
      "Audit logs of remember and recall calls are retained for thirty days; the retention window is configured via CURION_AUDIT_RETENTION_DAYS.",
    tags: ["security", "audit", "retention"],
  },

  // -------------------------------------------------------------------------
  // Cluster 19: agent-runtime (4) — agent / MCP runtime shape. Pairs
  // with cluster 1 (stack) to add a richer view of the runtime: process
  // model, per-key serialization, recall limits, and the in-memory
  // provider response cache.
  // -------------------------------------------------------------------------
  {
    id: 73,
    kind: "fact",
    summary:
      "The MCP server runs in a single Node process; the stdio transport multiplexes all requests over a single stdin and stdout channel.",
    tags: ["agent", "runtime", "process"],
  },
  {
    id: 74,
    kind: "decision",
    summary:
      "Provider calls are serialized through a per-key mutex; concurrent calls from the same key wait for the previous one to complete.",
    tags: ["agent", "runtime", "mutex"],
  },
  {
    id: 75,
    kind: "fact",
    summary:
      "The recall tool returns at most DEFAULT_TOP_K (five) memories; pagination is intentionally not supported in this phase.",
    tags: ["agent", "recall", "limit"],
  },
  {
    id: 76,
    kind: "fact",
    summary:
      "The agent runtime caches provider responses in-memory for the lifetime of a single process; persistent caching is not yet implemented.",
    tags: ["agent", "cache", "runtime"],
  },

  // -------------------------------------------------------------------------
  // Cluster 20: data-pipeline (4) — data persistence and lifecycle.
  // Pairs with cluster 1 (stack) to add storage lifecycle details:
  // SQLite WAL mode, nightly backups, createdAt/updatedAt, and the
  // soft-delete (state='invalidated') model.
  // -------------------------------------------------------------------------
  {
    id: 77,
    kind: "fact",
    summary:
      "Memory persistence uses a single SQLite file under .curion/; the file is opened with WAL journaling for concurrent reads.",
    tags: ["data", "persistence", "sqlite"],
  },
  {
    id: 78,
    kind: "decision",
    summary:
      "Database backups are created nightly and rotated weekly; the most recent seven backups are kept on disk at any time.",
    tags: ["data", "backup", "rotation"],
  },
  {
    id: 79,
    kind: "fact",
    summary:
      "Memory records carry a createdAt and updatedAt timestamp; updatedAt is bumped on every successful controller write.",
    tags: ["data", "timestamps", "schema"],
  },
  {
    id: 80,
    kind: "decision",
    summary:
      "Soft-deleted records are kept in the memories table with state set to invalidated; the recall path does not return invalidated records.",
    tags: ["data", "soft-delete", "state"],
  },

  // -------------------------------------------------------------------------
  // Cluster 21: client-sdk (4) — public TypeScript client SDK surface.
  // Pairs with cluster 13 (stack-extensions) to add a richer client-
  // facing view: the published package, the supported transport, the
  // version policy, and the no-cache contract.
  // -------------------------------------------------------------------------
  {
    id: 81,
    kind: "fact",
    summary:
      "The TypeScript client SDK is published as @curion/sdk; the package is built from src/client/ and is published from CI on every release.",
    tags: ["client", "sdk", "publish"],
  },
  {
    id: 82,
    kind: "decision",
    summary:
      "The client SDK supports a single transport (stdio) in this phase; HTTP transport is a planned future addition.",
    tags: ["client", "sdk", "transport"],
  },
  {
    id: 83,
    kind: "decision",
    summary:
      "The client SDK is versioned in lockstep with the server; the same major version is required for client and server to communicate.",
    tags: ["client", "sdk", "versioning"],
  },
  {
    id: 84,
    kind: "fact",
    summary:
      "The client SDK does not maintain its own cache; recall responses are fetched fresh from the server on every call.",
    tags: ["client", "sdk", "cache"],
  },

  // -------------------------------------------------------------------------
  // Cluster 22: feature-flags (4) — feature flag system. Pairs with
  // cluster 9 (dependencies) to add a richer release-gating view:
  // env-var source, default-empty, per-process evaluation, and the
  // verbose-summary mode gate.
  // -------------------------------------------------------------------------
  {
    id: 85,
    kind: "fact",
    summary:
      "Feature flags are read from the CURION_FEATURE_FLAGS environment variable; the value is a comma-separated list of flag names.",
    tags: ["feature-flags", "config", "env"],
  },
  {
    id: 86,
    kind: "decision",
    summary:
      "The default feature flag set is empty; all new features ship as off by default and are rolled out via the flag system.",
    tags: ["feature-flags", "rollout", "process"],
  },
  {
    id: 87,
    kind: "fact",
    summary:
      "Feature flags are evaluated per process; a flag toggle requires a server restart to take effect in this phase.",
    tags: ["feature-flags", "runtime", "lifecycle"],
  },
  {
    id: 88,
    kind: "decision",
    summary:
      "The remember tool's verbose summary mode is gated behind the verbose-summary feature flag; without the flag the summary is concise.",
    tags: ["feature-flags", "remember", "summary"],
  },

  // -------------------------------------------------------------------------
  // Cluster 23: provider-routing (4) — provider adapter routing and
  // retry policy. Pairs with cluster 8 (security) and cluster 14
  // (testing-extensions) to add a richer view of the provider adapter:
  // primary/fallback order, fallback key env, retry-with-backoff, and
  // the typed result union that controllers switch on.
  // -------------------------------------------------------------------------
  {
    id: 89,
    kind: "decision",
    summary:
      "The provider adapter tries the primary first; on a 429 or 5xx it falls back to the secondary and returns a typed result union.",
    tags: ["provider", "routing", "fallback"],
  },
  {
    id: 90,
    kind: "fact",
    summary:
      "The fallback provider is configured via CURION_PROVIDER_FALLBACK_KEY; an unset key disables fallback and the adapter errors out cleanly.",
    tags: ["provider", "routing", "config"],
  },
  {
    id: 91,
    kind: "decision",
    summary:
      "The provider adapter retries on 429 with exponential backoff (one second, two seconds, four seconds); after three failed attempts it gives up and returns a typed error.",
    tags: ["provider", "routing", "retry"],
  },
  {
    id: 92,
    kind: "fact",
    summary:
      "The provider adapter's typed result union has three variants: ok, retryable_error, and fatal_error; controllers MUST switch on the variant.",
    tags: ["provider", "routing", "types"],
  },

  // -------------------------------------------------------------------------
  // Cluster 24: legacy-extensions (4) — additional historical /
  // superseded records. Like cluster 6 and cluster 15, these are NOT
  // in the orientation distractor set (the distractor set stays
  // {13..16, 21..24}); they are available as legacy distractors for
  // the new temporal queries that exercise currentTruth divergence
  // and for the new paraphrase / multi-hop queries that share tokens
  // with the current cluster 18-23 records. The distractor /
  // history-archive boundary is documented in
  // `src/benchmark/metrics.ts` under `getKnownDistractorIds`.
  // -------------------------------------------------------------------------
  {
    id: 93,
    kind: "fact",
    summary:
      "Earlier the project used a single global index for all memory kinds; the current design uses a kind-scoped index for the recall path.",
    tags: ["history", "index", "schema"],
  },
  {
    id: 94,
    kind: "fact",
    summary:
      "Previously the recall path was synchronous with the provider; it is now async and uses a per-key mutex to serialize provider calls.",
    tags: ["history", "async", "mutex"],
  },
  {
    id: 95,
    kind: "fact",
    summary:
      "The original HTTP client kept connections open for the lifetime of the process; the current client opens a new connection per request for isolation.",
    tags: ["history", "http", "client"],
  },
  {
    id: 96,
    kind: "fact",
    summary:
      "Earlier the controller accepted any provider output; the current controller validates the output against a Zod schema before persisting.",
    tags: ["history", "validation", "controller"],
  },

  // -------------------------------------------------------------------------
  // Cluster 25: testing-extensions-2 (4) — additional test
  // infrastructure details. Pairs with cluster 7 (testing) and
  // cluster 14 (testing-extensions) to give the multi-slot test
  // queries a richer top-K. The cluster covers property-based tests,
  // snapshot tests, the no-skip CI invariant, and the test
  // co-location convention.
  // -------------------------------------------------------------------------
  {
    id: 97,
    kind: "fact",
    summary:
      "Property-based tests use fast-check; the test runner is configured to cap the number of generated examples at one hundred per case.",
    tags: ["testing", "property", "tooling"],
  },
  {
    id: 98,
    kind: "reference",
    summary:
      "Snapshot tests for the benchmark report live under tests/__snapshots__/; the snapshots are checked in and reviewed as part of pull request review.",
    tags: ["testing", "snapshot", "review"],
  },
  {
    id: 99,
    kind: "decision",
    summary:
      "The CI fails the build if any test is marked todo or skip on the default branch; skipped tests are only allowed on long-lived feature branches.",
    tags: ["testing", "ci", "policy"],
  },
  {
    id: 100,
    kind: "fact",
    summary:
      "Test files are co-located with the source file they cover; integration tests live under tests/ and run as part of the default CI job.",
    tags: ["testing", "layout", "convention"],
  },

  // -------------------------------------------------------------------------
  // Cluster 26: adversarial-conflict (4) — labeled records
  // that DELIBERATELY contradict a current cluster fact so
  // the conflict/contradiction is visible in the corpus.
  // The records are NOT marked "wrong" in storage (the
  // benchmark fixture has no notion of a "wrong" record);
  // they are EXTRA records that share many tokens with a
  // current fact but assert a different conclusion. A
  // paraphrase or temporal query that has a clean
  // current-truth target will, on this cluster, see the
  // conflict record as a near-miss distractor. The
  // cluster pairs deliberately: (101, 102) vs. the
  // current cluster-8 / cluster-22 facts; (103, 104) vs.
  // the current cluster-9 / cluster-18 facts.
  // -------------------------------------------------------------------------
  {
    id: 101,
    kind: "fact",
    summary:
      "API keys are stored in the .curion/secrets.json file with a chmod 600 permission; the file is gitignored but is the source of truth at runtime.",
    tags: ["adversarial", "conflict", "security", "secrets"],
  },
  {
    id: 102,
    kind: "decision",
    summary:
      "The HTTP client logs the full auth credential header on a 401 so on-call has the key shape for an auth-bypass investigation.",
    tags: ["adversarial", "conflict", "http", "sanitization"],
  },
  {
    id: 103,
    kind: "decision",
    summary:
      "Releases are cut from a long-lived release branch on Thursdays; the release branch is rebased onto main weekly and hotfixes are cherry-picked onto the release branch.",
    tags: ["adversarial", "conflict", "release", "process"],
  },
  {
    id: 104,
    kind: "fact",
    summary:
      "The retrieval layer uses a single pass over summaries with no re-ranking; the design predates the current re-rank-before-synthesis layout.",
    tags: ["adversarial", "conflict", "retrieval", "history"],
  },

  // -------------------------------------------------------------------------
  // Cluster 27: adversarial-superseded (4) — labeled records
  // that represent a SUPERSEDED version of a current fact,
  // paired with the current fact in the corpus. Each
  // superseded record has a CLEARER lexical hook than the
  // legacy records 21..24 / 57..60 / 93..96 so it is the
  // deliberate "old fact that is lexically stronger than
  // the current fact" temporal trap. The trap is what
  // the new "temporal stale-fact trap" queries exercise.
  // -------------------------------------------------------------------------
  {
    id: 105,
    kind: "fact",
    summary:
      "As of last quarter, the project primary data store is Postgres 15; the migration to a newer major version is being scoped.",
    tags: ["adversarial", "superseded", "postgres", "history"],
  },
  {
    id: 106,
    kind: "fact",
    summary:
      "Until recently the runtime was Node 20 with the legacy ESM loader; the team has since moved to Node 22 with the modern ESM resolver.",
    tags: ["adversarial", "superseded", "node", "history"],
  },
  {
    id: 107,
    kind: "decision",
    summary:
      "Previously the controller accepted any provider output without validation; the current controller validates against a Zod schema before persisting.",
    tags: ["adversarial", "superseded", "controller", "validation"],
  },
  {
    id: 108,
    kind: "fact",
    summary:
      "Earlier the safety classifier was a hard-coded blocklist; the current classifier is regex-based with a small allow-list for test scope.",
    tags: ["adversarial", "superseded", "safety", "history"],
  },

  // -------------------------------------------------------------------------
  // Cluster 28: adversarial-near-miss (4) — labeled records
  // that are intentionally close to a current cluster but
  // name a different specific fact (different team, different
  // service, different product area). The near-miss
  // records are the within-cluster distractors the
  // `nearMissCurrentCluster` query label exercises. Each
  // record is anchored to a current cluster so a paraphrase
  // / exact / multi-hop query that should hit the current
  // fact will also see the near-miss as a top-1 candidate.
  // -------------------------------------------------------------------------
  {
    id: 109,
    kind: "fact",
    summary:
      "The mobile team's primary data store is Postgres 14 with a separate read replica; the platform team uses Postgres 16 in a different cluster.",
    tags: ["adversarial", "near-miss", "postgres", "team"],
  },
  {
    id: 110,
    kind: "decision",
    summary:
      "The web team's MCP transport is a community HTTP bridge; the platform team's MCP transport is the official stdio SDK.",
    tags: ["adversarial", "near-miss", "mcp", "transport"],
  },
  {
    id: 111,
    kind: "fact",
    summary:
      "The data team's on-call rotation is shared with the analytics team and handoff happens on Wednesdays at 14:00; the platform team handoff is on Mondays at 10:00.",
    tags: ["adversarial", "near-miss", "oncall", "team"],
  },
  {
    id: 112,
    kind: "decision",
    summary:
      "The docs team's release cut schedule is bi-weekly on Fridays from a docs-only branch; the platform team cuts from main on Tuesdays.",
    tags: ["adversarial", "near-miss", "release", "docs"],
  },

  // -------------------------------------------------------------------------
  // Cluster 29: adversarial-paraphrase-twin (4) — labeled
  // records that paraphrase a current cluster record with
  // deliberately LOW lexical-overlap vocabulary. The twin
  // is the corpus-side anchor for the `adversarialParaphrase`
  // label: a positive query that targets the twin has to
  // find the right paraphrase, not a more lexically obvious
  // current record in the same cluster. The twins are
  // the additional paraphrase stress the new "deep
  // positive paraphrases" queries target.
  // -------------------------------------------------------------------------
  {
    id: 113,
    kind: "fact",
    summary:
      "The project keeps its saved insights in a hidden folder at the repository root, in a single self-contained database file.",
    tags: ["adversarial", "paraphrase-twin", "storage", "sqlite"],
  },
  {
    id: 114,
    kind: "fact",
    summary:
      "Code change requests are expected to summarize the user-visible outcome in the title and to leave at least one substantive review note per nontrivial change.",
    tags: ["adversarial", "paraphrase-twin", "review", "style"],
  },
  {
    id: 115,
    kind: "decision",
    summary:
      "The model provider tries the primary endpoint first; on a transient failure it falls back to the secondary and returns a typed result the controller can switch on.",
    tags: ["adversarial", "paraphrase-twin", "provider", "routing"],
  },
  {
    id: 116,
    kind: "fact",
    summary:
      "Application observability is exposed through a separate metrics port; the main protocol port is reserved for the protocol transport and is unchanged.",
    tags: ["adversarial", "paraphrase-twin", "observability", "prometheus"],
  },

  // -------------------------------------------------------------------------
  // Cluster 30: adversarial-temporal-current-vs-previous
  // (4) — labeled records that pair a CURRENT fact with a
  // NEAR-MISS / PREVIOUS fact in the same cluster, so a
  // "current vs previous" temporal query has to distinguish
  // them by semantic detail (not by lexical rarity). The
  // pair is the corpus-side anchor for the new
  // "distinguishing current from previous" temporal
  // queries. The labels on the queries (`divergentTemporal`
  // for the labeled gap, `nearMissCurrentCluster` for the
  // current-vs-near-miss disambiguation) drive the fixture
  // truth; the ranker sees both records and has to pick
  // the current one.
  // -------------------------------------------------------------------------
  {
    id: 117,
    kind: "fact",
    summary:
      "The current primary data store is Postgres 16 with logical replication to a warm standby; the previous setup was Postgres 14 with a single hot standby.",
    tags: ["adversarial", "current-vs-previous", "postgres", "history"],
  },
  {
    id: 118,
    kind: "decision",
    summary:
      "The current release cut is from main on Tuesdays; the previous cut was from a release branch on Thursdays with a weekly rebase.",
    tags: ["adversarial", "current-vs-previous", "release", "process"],
  },
  {
    id: 119,
    kind: "fact",
    summary:
      "The current safety pipeline runs the classifier on every input before the controller; the previous pipeline ran the classifier on a sampled subset only.",
    tags: ["adversarial", "current-vs-previous", "safety", "pipeline"],
  },
  {
    id: 120,
    kind: "fact",
    summary:
      "The current on-call handoff is on Mondays at 10:00 local time; the previous handoff was on Fridays at 16:00 local time.",
    tags: ["adversarial", "current-vs-previous", "oncall", "schedule"],
  },

  // -------------------------------------------------------------------------
  // Cluster 31: adversarial-false-premise-anchor (4) —
  // labeled records that mention a NEAR-MISS tool the
  // corpus does NOT officially use. The anchor is the
  // corpus-side co-occurrence surface for the new "OOD
  // entity not in the legacy token list" no-answer
  // queries: a no-answer query that mentions the
  // near-miss tool will share tokens with the anchor
  // and become a labeled confabulation pressure. The
  // four anchors are deliberately chosen to be CLOSE to
  // an existing cluster (so the token overlap is real
  // but the answer is still "no relevant memory") and
  // are NOT in the existing `FALSE_PREMISE_TOKENS` /
  // `OOD_ENTITY_TOKENS` lists in `query-shapes.ts` —
  // that is the "new entity, not in the legacy list"
  // requirement the brief asks for.
  // -------------------------------------------------------------------------
  {
    id: 121,
    kind: "fact",
    summary:
      "The team briefly evaluated a Prometheus sidecar called vector-exporter for the MCP server's metrics; the sidecar was not adopted and the project's metrics are exported directly via a Prometheus endpoint on a separate port.",
    tags: ["adversarial", "false-premise-anchor", "observability", "sidecar"],
  },
  {
    id: 122,
    kind: "fact",
    summary:
      "A previous spike evaluated a Vector index for embeddings alongside SQLite; the team chose to keep the dependency surface small and the dense path runs in-memory only.",
    tags: ["adversarial", "false-premise-anchor", "index", "vector"],
  },
  {
    id: 123,
    kind: "decision",
    summary:
      "The team has decided not to add a Kafka topic for cross-process event delivery; the project-local event bus is a single-process in-memory channel.",
    tags: ["adversarial", "false-premise-anchor", "events", "kafka"],
  },
  {
    id: 124,
    kind: "fact",
    summary:
      "The project's deployment target is the team-managed cluster; the team does not run any portion of the service on AWS Lambda or any other serverless runtime.",
    tags: ["adversarial", "false-premise-anchor", "deploy", "lambda"],
  },

  // -------------------------------------------------------------------------
  // Cluster 32: adversarial-orientation-extension (4) —
  // labeled records that EXTEND an existing orientation
  // cluster (e.g. an additional CI extension detail) so
  // orientation queries can test the "newer" record while
  // still having the older record as a near-miss
  // distractor. The cluster also includes a labeled
  // "legacy distractor" record so the
  // `nearMissCurrentCluster` orientation query has a
  // pair of near-miss distractors to choose from.
  // -------------------------------------------------------------------------
  {
    id: 125,
    kind: "decision",
    summary:
      "The CI runs a nightly job that exercises the retrieval benchmark against the current corpus and publishes the headline numbers as a status badge in the project README.",
    tags: ["adversarial", "orientation-extension", "ci", "benchmark"],
  },
  {
    id: 126,
    kind: "fact",
    summary:
      "The CI uploads a coverage delta to the team dashboard; coverage drops on changed lines of more than one percentage point fail the merge gate.",
    tags: ["adversarial", "orientation-extension", "ci", "coverage"],
  },
  {
    id: 127,
    kind: "fact",
    summary:
      "The CI enforces the deterministic no-skip invariant: any test marked todo or skip on the default branch fails the build before the coverage report is generated.",
    tags: ["adversarial", "orientation-extension", "ci", "policy"],
  },
  {
    id: 128,
    kind: "fact",
    summary:
      "The CI uses a matrix of Node 20 and Node 22 on Ubuntu for the test job; the team intentionally keeps the matrix narrow to keep the build predictable.",
    tags: ["adversarial", "orientation-extension", "ci", "matrix"],
  },

  // -------------------------------------------------------------------------
  // Cluster 33: adversarial-multi-hop-bridge (4) — labeled
  // records that are the MISSING BRIDGE in a multi-hop
  // query: a query that needs a fact from cluster A AND
  // a fact from cluster B can only succeed if the bridge
  // record is surfaced. The bridges are the corpus-side
  // anchor for the "multi-hop with a near-miss
  // distractor on one hop" query: each bridge is the
  // single record that links two otherwise-disconnected
  // clusters, and a near-miss distractor (a record that
  // mentions one side of the bridge but not the other)
  // is included in the same cluster so the multi-hop
  // query has to surface the right bridge. The labeled
  // "current-vs-previous" records above are the
  // single-hop temporal near-miss; these bridges are the
  // two-hop bridge near-miss.
  // -------------------------------------------------------------------------
  {
    id: 129,
    kind: "fact",
    summary:
      "The audit retention window is configured via CURION_AUDIT_RETENTION_DAYS and the audit log is consumed by the weekly on-call digest; the digest is posted to the team channel every Monday morning at 9:00 local time.",
    tags: ["adversarial", "multi-hop-bridge", "security", "monitoring"],
  },
  {
    id: 130,
    kind: "fact",
    summary:
      "The provider rate-limit is read from CURION_PROVIDER_RATE_LIMIT and defaults to sixty requests per minute; the rate-limit interacts with the exponential-backoff retry on 429 that the provider adapter applies before giving up.",
    tags: ["adversarial", "multi-hop-bridge", "provider", "rate-limit"],
  },
  {
    id: 131,
    kind: "fact",
    summary:
      "The recall tool returns at most DEFAULT_TOP_K (five) memories; the in-memory provider response cache is scoped to a single process and is not shared with the recall path, which always fetches fresh from the server.",
    tags: ["adversarial", "multi-hop-bridge", "recall", "cache"],
  },
  {
    id: 132,
    kind: "fact",
    summary:
      "The MCP stdio transport multiplexes all requests over a single stdin and stdout channel; application logs go to stderr only and the protocol port is never written to outside of MCP protocol frames.",
    tags: ["adversarial", "multi-hop-bridge", "agent", "stdio"],
  },
];
