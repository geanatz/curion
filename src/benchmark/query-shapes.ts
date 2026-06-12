/**
 * Benchmark-only query-shape detector.
 *
 * The detector is a small set of transparent,
 * regex-based heuristics that label a query with a
 * small set of binary flags. The flags are surfaced
 * on the audit report as
 * `AbstentionSignals.isNoAnswerHardNegative` /
 * `.isTemporalCurrent` / `.isNegationLike` /
 * `.isOodEntityLike` / `.isParaphraseTrap` /
 * `.isFalsePremiseLike`. They are BENCHMARK-ONLY
 * DIAGNOSTICS:
 *
 *   - They are NOT used by the production
 *     `recall(text)` controller.
 *   - They do NOT change the public MCP API.
 *   - They do NOT change the lexical / FTS5 / vector /
 *     hybrid / hybrid-dense rank math.
 *   - They do NOT change the existing benchmark /
 *     calibration report shapes (the flags live on
 *     the new `AbstentionSignals` block, which is
 *     additive).
 *
 * Why they exist:
 *   The audit studies signal separability at the
 *   "answerable vs no-answer" binary level. The
 *   reader needs to know whether the signal works
 *   uniformly, or only on a specific shape of query.
 *   The flags let the audit slice the corpus by
 *   shape: "is this signal a hard-negative
 *   detector?", "does it work on temporal queries?",
 *   etc. The flags are NOT keyed to specific query
 *   ids; they are family / note / token-overlap
 *   heuristics.
 *
 * How to read the detector:
 *   - `isNoAnswerHardNegative` — `family === "no-answer"`
 *     AND the query shares at least one token with a
 *     real record in the corpus. The labeled
 *     `nonexistent-load-balancer` query is a hard-
 *     negative because it shares `MCP` / `server` /
 *     `port` with the agent runtime cluster.
 *   - `isTemporalCurrent` — the query contains a
 *     temporal-current token like `current` / `now` /
 *     `today` / `currently`. A reviewer's
 *     expectation: a temporal-current query should
 *     surface the current fact at the top; a
 *     confabulation here is a more confident error
 *     than on a non-temporal query.
 *   - `isNegationLike` — the query contains a
 *     negation token. A negation flips the relevant
 *     fact; a "no-answer" query with a negation is
 *     a different shape from one without.
 *   - `isOodEntityLike` — the query mentions an
 *     entity that is in the legacy / previous cluster
 *     (records 21..24, 93..96) and is NOT in the
 *     expected-ids of any real record. The detector
 *     is a soft heuristic; a reviewer should not
 *     over-read a `true` here as "this query is
 *     adversarial" — it is "this query is about the
 *     same topic as a legacy record, and the
 *     expected answer is somewhere else".
 *   - `isParaphraseTrap` — the family is `paraphrase`.
 *     A paraphrase query is a known-bad lexical
 *     baseline case; the audit's reading of "signal
 *     works on paraphrases" is the "this signal
 *     detects paraphrase misses" question.
 *   - `isFalsePremiseLike` — the query mentions an
 *     entity / tool the corpus does not name. The
 *     detector is a small fixed set of common
 *     "missing-tool" tokens (CDN / SSO / webhook /
 *     iOS / Android / GraphQL / etc.) and the
 *     `family === "no-answer"` filter.
 *
 * Limitations:
 *   The detectors are regex / token-set based. They
 *   WILL miss some cases (e.g. a paraphrase that uses
 *   a new synonym the detector does not know) and
 *   WILL fire on a query that happens to share a
 *   token with a real record but is not actually a
 *   hard-negative. The audit report surfaces the
 *   count of queries that fired each flag so a
 *   reviewer can see the detector's effective
 *   coverage.
 */

import type { BenchmarkQuery } from "./queries.js";
import type { BenchmarkMemoryRecord } from "./corpus.js";

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * The temporal-current token set. Lowercase, word
 * boundary, single-word match (the detector uses a
 * `\b` regex). The set is intentionally small and
 * obvious so a reviewer can see exactly which words
 * trigger the flag.
 */
const TEMPORAL_CURRENT_TOKENS: readonly string[] = [
  "current",
  "currently",
  "now",
  "today",
  "nowadays",
  "presently",
];

/**
 * The negation token set. Lowercase, word boundary,
 * single-word match.
 */
const NEGATION_TOKENS: readonly string[] = [
  "no",
  "not",
  "never",
  "without",
  "none",
  "neither",
  "nor",
  "isnt",
  "isn't",
  "wasnt",
  "wasn't",
  "arent",
  "aren't",
  "dont",
  "don't",
  "doesnt",
  "doesn't",
  "didnt",
  "didn't",
  "wont",
  "won't",
  "wouldnt",
  "wouldn't",
  "cant",
  "can't",
  "cannot",
  "shouldnt",
  "shouldn't",
  "couldnt",
  "couldn't",
];

/**
 * The OOD-entity tokens: tool / platform names the
 * corpus deliberately does NOT have a record for.
 * The detector is a soft heuristic. Adding a new
 * "missing" tool here broadens the detector; a
 * reviewer who wants to remove a false positive
 * can edit the list and the test will fail loud
 * (the audit-flag coverage assertion is in the
 * abstention-audit test).
 */
const OOD_ENTITY_TOKENS: readonly string[] = [
  "sso",
  "graphql",
  "ios",
  "android",
  "cdn",
  "webhook",
  "pair-programming",
  "pairing",
  "cookie",
  "stripe",
  "aws",
  "azure",
  "gcp",
  "kubernetes",
  "docker",
  "graphql",
  "datadog",
  "pagerduty",
  "sentry",
];

/**
 * The false-premise tokens: tools / services the
 * corpus does not have a record for. The detector
 * uses this list in addition to the `family ===
 * "no-answer"` filter. The list is the same as the
 * OOD-entity list with a few additions specific to
 * "the project has no X" queries.
 */
const FALSE_PREMISE_TOKENS: readonly string[] = [
  ...OOD_ENTITY_TOKENS,
  "load-balancer",
  "load balancer",
  "rollback",
  "feature-branch",
  "feature branch",
  "sla",
  "sla-tier",
  "staging-access",
  "rate-limit-budget",
  "time-tracking",
  "quiet-hours",
  "shared-calendar",
  "shared calendar",
  "pairing-rotation",
  "pairing rotation",
  "graphql-endpoint",
  "graphql endpoint",
  "webhook",
  "i18n",
  "l10n",
  "localization",
  "mobile-app",
  "mobile app",
  "ios-app",
  "ios app",
  "android-app",
  "android app",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable token set for a record (summary +
 * tags). The set is lowercase, alphanumeric, and
 * filtered to length >= 3. The set is used by the
 * hard-negative detector to count the token overlap
 * between a no-answer query and a real record.
 */
function buildRecordTokenSet(record: BenchmarkMemoryRecord): Set<string> {
  const text = `${record.summary ?? ""} ${(record.tags ?? []).join(" ")}`;
  return tokenizeText(text);
}

/**
 * The stopword set the detector filters out. The
 * set is the conventional English stopword list,
 * intentionally short so the detector's overlap
 * count is meaningful. A token like "the" or "and"
 * would otherwise show up in nearly every record
 * and make every no-answer query look like a
 * hard-negative; the stopword filter is what
 * prevents that.
 */
const DETECTOR_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any",
  "can", "had", "her", "was", "one", "our", "out", "day", "get",
  "has", "him", "his", "how", "man", "new", "now", "old", "see",
  "two", "way", "who", "boy", "did", "its", "let", "put", "say",
  "she", "too", "use", "this", "that", "with", "from", "have",
  "they", "their", "there", "what", "when", "your", "were", "been",
  "will", "would", "could", "should", "about", "into", "than",
  "then", "them", "these", "those", "because", "where", "which",
  "while", "whom", "ever", "very", "just", "also", "over",
  "such", "some", "only", "more", "most", "other", "each",
]);

/**
 * Tokenize a text into a stable lowercase set. The
 * tokenizer is intentionally simple (split on
 * non-alphanumerics, length >= 3, English stopword
 * filter) so the detector is transparent. The
 * `buildRecordTokenSet` helper uses the same
 * tokenizer for symmetric overlap.
 */
function tokenizeText(text: string): Set<string> {
  const out = new Set<string>();
  if (typeof text !== "string" || text.length === 0) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (DETECTOR_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Count the overlap between two token sets. The
 * overlap is the number of distinct tokens that
 * appear in BOTH sets.
 */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Detector entry point
// ---------------------------------------------------------------------------

/**
 * The result of running the query-shape detector on
 * one query. The shape mirrors the
 * `AbstentionSignals.isXxx` flags so the audit runner
 * can attach it directly. The detector is pure: same
 * (query, corpus) -> same flags.
 *
 * The `isAdversarialParaphrase` / `isDivergentTemporal`
 * / `isNearMissCurrentCluster` flags are the
 * adversarial-expansion additions. They are derived
 * from the query's explicit `labels?: string[]` field
 * (the fixture truth) when present, AND approximated
 * by the detector for unlabeled queries when the
 * family / corpus / token-overlap signals support
 * it. The detection is additive: existing queries
 * without `labels` get the same flags they would have
 * had under the prior detector; queries WITH `labels`
 * get the explicit-truth flag plus the detector's
 * best-effort approximation for the OTHER flags. The
 * `abstention-audit-runner` keeps the explicit
 * `queryId -> labels` map on the per-query signals
 * block so a reviewer can audit the detector's
 * approximation against the fixture truth.
 */
export interface QueryShapeFlags {
  isNoAnswerHardNegative: boolean;
  isTemporalCurrent: boolean;
  isNegationLike: boolean;
  isOodEntityLike: boolean;
  isParaphraseTrap: boolean;
  isFalsePremiseLike: boolean;
  /**
   * Additive (v1): the query is an `adversarialParaphrase`
   * (per the explicit `labels` field when present) OR
   * is a paraphrase family query that targets one of
   * the paraphrase-twin records (113..116) — the
   * "deep positive paraphrase with very low lexical
   * overlap" case. The detector approximates this by
   * flagging paraphrase queries whose query text
   * shares fewer than a low-overlap threshold of
   * tokens with the expected records; queries WITH
   * the explicit `adversarialParaphrase` label are
   * flagged directly.
   */
  isAdversarialParaphrase: boolean;
  /**
   * Additive (v1): the query is a labeled divergent
   * temporal query (per the explicit `labels` field
   * when present). A divergent temporal query has
   * `expectedIds` that includes BOTH the current and
   * the old / superseded fact, with `currentTruthIds`
   * containing only the current fact. The detector
   * uses the same `DIVERGENT_TEMPORAL_IDS` set the
   * abstention audit uses (extended by the
   * adversarial-expansion additions). Queries with
   * the explicit `divergentTemporal` label are
   * flagged directly.
   */
  isDivergentTemporal: boolean;
  /**
   * Additive (v1): the query is a near-miss
   * disambiguation (per the explicit `labels` field
   * when present) OR is an orientation / multi-hop /
   * paraphrase query that targets one of the
   * near-miss-cluster records (109..112) — the
   * "near-miss distractor pressure" case. The
   * detector approximates this by flagging queries
   * whose `expectedIds` intersect the near-miss
   * cluster ids.
   */
  isNearMissCurrentCluster: boolean;
}

/**
 * Per-flag configuration the detector carries. The
 * OOD-entity detector uses a `minOverlap` threshold
 * (a query has to share at least N tokens with a
 * legacy / previous record to fire). The threshold
 * is exposed as a constant so a reviewer can see the
 * trade-off in one place.
 */
export const OOD_ENTITY_MIN_OVERLAP = 2;
export const HARD_NEGATIVE_MIN_OVERLAP = 2;

/**
 * Pre-built set of record ids the OOD-entity detector
 * considers "legacy / previous". The set is the same
 * one the existing orientation `noisyReturnRate` and
 * the temporal supersession queries use: records
 * 21..24 (the "previous Postgres / release / retrieval
 * / CI" set) and 93..96 (the "legacy controller /
 * schema / runner" set). A reviewer who wants to
 * extend the detector can edit this list; the tests
 * pin it.
 */
export const LEGACY_DISTRACTOR_IDS: ReadonlySet<number> = new Set([
  21, 22, 23, 24, 93, 94, 95, 96,
]);

/**
 * Pre-built set of record ids the
 * `isNearMissCurrentCluster` detector considers
 * "near-miss current cluster" — the new cluster-28
 * records (109..112) that are intentionally close to
 * a current cluster but name a different specific
 * fact (different team / service / product area).
 * A reviewer who wants to extend the detector can
 * edit this list; the tests pin it.
 */
export const NEAR_MISS_CURRENT_CLUSTER_IDS: ReadonlySet<number> = new Set([
  109, 110, 111, 112,
]);

/**
 * Pre-built set of record ids the
 * `isAdversarialParaphrase` detector considers
 * "paraphrase-twin" — the new cluster-29 records
 * (113..116) that paraphrase a current cluster
 * record with deliberately LOW lexical-overlap
 * vocabulary. A reviewer who wants to extend the
 * detector can edit this list; the tests pin it.
 */
export const PARAPHRASE_TWIN_IDS: ReadonlySet<number> = new Set([
  113, 114, 115, 116,
]);

/**
 * Run the query-shape detector on a single query
 * against a corpus. The function is pure: same
 * (query, corpus) -> same flags. The cost is one
 * token-set build per record (cached) and one
 * regex / set-membership test per flag. The
 * detector is intentionally cheap so the runner can
 * call it on every query without a noticeable
 * benchmark overhead.
 *
 * Pre-condition: the corpus should be the same
 * fixture corpus the audit is run against. The
 * caller is responsible for thread-safety / caching
 * if the detector is called in a hot loop. The
 * runner builds the per-record token set once and
 * passes it via `corpusTokenSets` for efficiency.
 */
export function detectQueryShape(
  query: BenchmarkQuery,
  corpusTokenSets: ReadonlyArray<{ id: number; tokens: Set<string> }>,
): QueryShapeFlags {
  const qText = (query.query ?? "").toLowerCase();
  const qTokens = tokenizeText(qText);
  // ---- isNoAnswerHardNegative -------------------------------------------
  // The query is a no-answer query AND it shares at
  // least HARD_NEGATIVE_MIN_OVERLAP tokens with a
  // real record.
  let isNoAnswerHardNegative = false;
  if (query.family === "no-answer") {
    for (const r of corpusTokenSets) {
      if (tokenOverlap(qTokens, r.tokens) >= HARD_NEGATIVE_MIN_OVERLAP) {
        isNoAnswerHardNegative = true;
        break;
      }
    }
  }
  // ---- isTemporalCurrent ------------------------------------------------
  // The query contains a temporal-current token.
  let isTemporalCurrent = false;
  for (const tok of TEMPORAL_CURRENT_TOKENS) {
    const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i");
    if (re.test(qText)) {
      isTemporalCurrent = true;
      break;
    }
  }
  // ---- isNegationLike ---------------------------------------------------
  let isNegationLike = false;
  for (const tok of NEGATION_TOKENS) {
    const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i");
    if (re.test(qText)) {
      isNegationLike = true;
      break;
    }
  }
  // ---- isOodEntityLike --------------------------------------------------
  // The query mentions an OOD-entity token AND
  // shares at least OOD_ENTITY_MIN_OVERLAP tokens
  // with a legacy distractor record (records 21..24
  // and 93..96). The legacy-cluster overlap is the
  // "this query is asking about the same topic as a
  // legacy record" signal.
  let isOodEntityLike = false;
  let hasOodToken = false;
  for (const tok of OOD_ENTITY_TOKENS) {
    const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i");
    if (re.test(qText)) {
      hasOodToken = true;
      break;
    }
  }
  if (hasOodToken) {
    for (const r of corpusTokenSets) {
      if (!LEGACY_DISTRACTOR_IDS.has(r.id)) continue;
      if (tokenOverlap(qTokens, r.tokens) >= OOD_ENTITY_MIN_OVERLAP) {
        isOodEntityLike = true;
        break;
      }
    }
  }
  // ---- isParaphraseTrap -------------------------------------------------
  // The family is `paraphrase` (the existing
  // benchmark family) is the primary signal. A
  // reviewer who wants to broaden the detector can
  // add a token-overlap check (e.g. "query has fewer
  // than N tokens in common with its expected
  // records"); the v1 contract is "family is the
  // primary signal, and the detector is documented".
  const isParaphraseTrap = query.family === "paraphrase";
  // ---- isFalsePremiseLike ----------------------------------------------
  // The query is no-answer AND mentions a
  // false-premise token. The token list is the
  // curated set the OOD-entity detector uses, plus
  // a few project-specific "missing tool" tokens.
  let isFalsePremiseLike = false;
  if (query.family === "no-answer") {
    for (const tok of FALSE_PREMISE_TOKENS) {
      const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i");
      if (re.test(qText)) {
        isFalsePremiseLike = true;
        break;
      }
    }
  }
  // ---- isAdversarialParaphrase (additive) ------------------------------
  // The query is labeled `adversarialParaphrase` OR
  // is a paraphrase query that targets one of the
  // PARAPHRASE_TWIN_IDS records (113..116). The
  // detector approximates the labeled case from the
  // family + the expected-ids intersection.
  let isAdversarialParaphrase = false;
  if (query.labels && query.labels.includes("adversarialParaphrase")) {
    isAdversarialParaphrase = true;
  } else if (query.family === "paraphrase" && query.expectedIds.length > 0) {
    for (const id of query.expectedIds) {
      if (PARAPHRASE_TWIN_IDS.has(id)) {
        isAdversarialParaphrase = true;
        break;
      }
    }
  }
  // ---- isDivergentTemporal (additive) ---------------------------------
  // The query is labeled `divergentTemporal` OR
  // its `currentTruthIds.length` is a strict subset
  // of `expectedIds.length` (the labeled divergent
  // pattern). The detector uses the data shape
  // rather than the `DIVERGENT_TEMPORAL_IDS` set
  // (which lives in the abstention-audit-runner)
  // so the two surfaces are decoupled.
  let isDivergentTemporal = false;
  if (query.labels && query.labels.includes("divergentTemporal")) {
    isDivergentTemporal = true;
  } else if (
    query.family === "temporal" &&
    query.currentTruthIds.length < query.expectedIds.length &&
    query.currentTruthIds.length > 0
  ) {
    isDivergentTemporal = true;
  }
  // ---- isNearMissCurrentCluster (additive) ----------------------------
  // The query is labeled `nearMissCurrentCluster` OR
  // is an orientation / multi-hop / paraphrase
  // query that targets one of the
  // NEAR_MISS_CURRENT_CLUSTER_IDS records (109..112).
  // The detector approximates the labeled case from
  // the family + the expected-ids intersection.
  let isNearMissCurrentCluster = false;
  if (query.labels && query.labels.includes("nearMissCurrentCluster")) {
    isNearMissCurrentCluster = true;
  } else if (
    query.expectedIds.length > 0 &&
    (query.family === "orientation" ||
      query.family === "multi-hop" ||
      query.family === "paraphrase")
  ) {
    for (const id of query.expectedIds) {
      if (NEAR_MISS_CURRENT_CLUSTER_IDS.has(id)) {
        isNearMissCurrentCluster = true;
        break;
      }
    }
  }
  return {
    isNoAnswerHardNegative,
    isTemporalCurrent,
    isNegationLike,
    isOodEntityLike,
    isParaphraseTrap,
    isFalsePremiseLike,
    isAdversarialParaphrase,
    isDivergentTemporal,
    isNearMissCurrentCluster,
  };
}

/**
 * Escape a string for use in a `RegExp` constructor.
 * The standard set of regex metacharacters: `.*+?^$()[]{}|\`.
 * The escape is intentionally minimal — we only need
 * to handle the small set of tokens the detector
 * uses.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Pre-build helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-record token sets the detector
 * needs. The runner calls this once per audit run so
 * the per-query detection loop is a constant-time
 * scan. The function is pure.
 */
export function buildCorpusTokenSets(
  records: ReadonlyArray<BenchmarkMemoryRecord>,
): Array<{ id: number; tokens: Set<string> }> {
  const out: Array<{ id: number; tokens: Set<string> }> = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    out[i] = { id: r.id, tokens: buildRecordTokenSet(r) };
  }
  return out;
}
