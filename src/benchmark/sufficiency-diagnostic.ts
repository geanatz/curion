/**
 * Benchmark-only candidate-set sufficiency diagnostic.
 *
 * A small, PURE, DETERMINISTIC helper that classifies the
 * candidate set a ranker returned for a single query as
 * `sufficient` / `partial` / `insufficient` /
 * `wrong-current-truth` / `near-miss` / `confabulation` /
 * `no-answer-correct`, then aggregates the per-query
 * labels into a benchmark report.
 *
 * Why this exists:
 *   The existing `categorizeFailure` function in
 *   `src/benchmark/metrics.ts` collapses many distinct
 *   failure shapes into a single family-keyed label
 *   (e.g. all `paraphrase` misses become
 *   `"paraphrase:vocabulary-mismatch"`). For the
 *   candidate-set-sufficiency question a reviewer
 *   actually wants answered — "given the ranker's
 *   top-K, was the candidate set sufficient to answer
 *   the query?" — a richer label set is needed:
 *
 *     - `sufficient` — the top-K contains a
 *       `currentTruthId` at rank 1, OR (for
 *       multi-hop / orientation) the top-K covers
 *       every expected id slot.
 *     - `partial`   — the top-K contains at least
 *       one expected id but neither at rank 1 (for
 *       the binary "current-truth at top" question)
 *       nor full-coverage (for multi-hop /
 *       orientation).
 *     - `insufficient` — the top-K contains zero
 *       expected ids; a no-answer family cannot
 *       produce this label (its top-K is required
 *       to be empty for the canonical "correct"
 *       answer, and non-empty for confabulation).
 *     - `wrong-current-truth` — `temporal` family
 *       with `currentTruthAt1 === false` AND
 *       `passed === true`: the top-K contains the
 *       current fact (so the answer is in the
 *       candidate set) but the OLD fact is on top
 *       (so the ranker would have handed the wrong
 *       fact to the user). This is the
 *       "temporal gap" the `currentTruthAt1`
 *       metric was designed to surface, restated
 *       as a candidate-set label.
 *     - `near-miss` — the top-K is non-empty but
 *       contains no expected id, AND the top-1
 *       matches a known near-miss distractor (per
 *       the `nearMissCurrentCluster` adversarial
 *       label) OR the query is labeled
 *       `nearMissCurrentCluster` /
 *       `adversarialParaphrase` and the candidate
 *       set is otherwise `insufficient`. The label
 *       is a finer-grained reading of
 *       `insufficient` for queries that were
 *       deliberately calibrated to land on a
 *       near-miss distractor.
 *     - `confabulation` — `no-answer` family with
 *       non-empty top-K. The ranker made something
 *       up.
 *     - `no-answer-correct` — `no-answer` family
 *       with empty top-K. The ranker correctly
 *       abstained.
 *
 *   The labels are stable strings; the report can
 *   group failures by label and a future UI can
 *   pivot on them. The diagnostic is read-only: it
 *   never re-ranks, never calls the provider, and
 *   never opens the network.
 *
 * Why this is benchmark-only:
 *   The diagnostic is a research artifact, not a
 *   deployment policy. It consumes the same
 *   `QueryEval[]` the existing
 *   `aggregateMetrics` consumes and produces a
 *   parallel block on the diagnostic artifact. The
 *   production `recall(text)` controller never
 *   reads this file; the public MCP API is not
 *   touched. No storage schema change, no
 *   dependency change, no public API change.
 *
 * Family-aware behavior:
 *   The classifier uses the per-query `family`,
 *   `expectedIds`, `currentTruthIds`, and
 *   optional `labels` fields to drive the label.
 *   The family rules are:
 *
 *     - `no-answer`  — `no-answer-correct` if
 *       top-K empty, `confabulation` otherwise.
 *       A `no-answer` query is never
 *       `sufficient` / `partial` /
 *       `insufficient` / `near-miss` /
 *       `wrong-current-truth` by construction:
 *       its `expectedIds` is empty.
 *     - `exact`,
 *       `paraphrase` — `sufficient` if rank-1 is
 *       an expected id, `partial` if any expected
 *       id is in top-K but not at rank 1,
 *       `near-miss` if the query carries a
 *       `nearMissCurrentCluster` /
 *       `adversarialParaphrase` label and the
 *       top-K is non-empty with no expected id,
 *       `insufficient` otherwise.
 *     - `temporal`   — `sufficient` if
 *       `currentTruthAt1 === true` (the
 *       `currentTruthIds` is a subset of
 *       `expectedIds` by construction, so a
 *       currentTruth hit is also an expected
 *       hit), `wrong-current-truth` if
 *       `passed === true` and
 *       `currentTruthAt1 === false` (the old
 *       fact is on top, the new fact is in
 *       top-K), `insufficient` if top-K has no
 *       expected id (and therefore no current
 *       id), `near-miss` if the query carries
 *       a `nearMissCurrentCluster` /
 *       `divergentTemporal` label and the
 *       top-K is non-empty with no expected
 *       id, otherwise `partial` (the current
 *       fact is in the top-K but not at
 *       rank 1; for non-divergent temporal
 *       queries this is rare because the
 *       expected id IS the current id).
 *     - `multi-hop`  — `sufficient` if the top-K
 *       contains EVERY expected id (complete
 *       coverage), `partial` if the top-K
 *       contains AT LEAST ONE expected id but
 *       not all (partial coverage),
 *       `near-miss` if the query carries a
 *       `nearMissCurrentCluster` label and the
 *       top-K is non-empty with no expected
 *       id, `insufficient` otherwise.
 *     - `orientation` — `sufficient` if the
 *       top-K contains a `currentTruthId` at
 *       rank 1 AND every expected id is in
 *       top-K, `partial` if at least one
 *       expected id is in top-K but not full
 *       coverage, `near-miss` if the query
 *       carries a `nearMissCurrentCluster`
 *       label and the top-K is non-empty
 *       with no expected id, `insufficient`
 *       otherwise.
 *
 *   The classifier is exhaustive: every `QueryEval`
 *   produces exactly one label. A `no-answer` query
 *   is never `near-miss` because the no-answer
 *   confabulation signal is `confabulation`, not
 *   `near-miss`. A temporal `partial` is rare but
 *   well-formed: it is the case where the top-K
 *   contains the current fact but the OLD fact is
 *   at the top, AND the OLD fact is NOT in
 *   `expectedIds` (i.e. a non-divergent temporal
 *   query where the ranker surfaced a
 *   non-expected distractor at the top while
 *   leaving the current fact somewhere in the
 *   top-K). The current corpus does not contain
 *   such a query, but the rule is in place so a
 *   future corpus revision does not silently
 *   change the label table.
 *
 * Determinism:
 *   The classifier is pure. The same `QueryEval`
 *   always produces the same label, the same set
 *   of labels always produces the same report, and
 *   no PRNG / timer / wall clock is consulted.
 *   The deterministic guarantee matters because
 *   the diagnostic artifact is the regression
 *   evidence; a non-deterministic label table
 *   would make byte-equal comparisons noisy.
 *
 * Output shape:
 *   The per-query diagnostic is a
 *   `SufficiencyDiagnostic` object with the label,
 *   the family, the query id, and a small set of
 *   raw counts (`expectedTotal`,
 *   `expectedInTopK`, `currentTruthInTopK`,
 *   `rank1IsExpected`, `rank1IsCurrentTruth`) so a
 *   reviewer can re-derive the label by hand. The
 *   per-variant aggregate is a
 *   `SufficiencyDiagnosticReport` with the variant
 *   label, the per-query diagnostic list, the
 *   per-label counts, and the per-family label
 *   breakdown. The cross-variant comparison is a
 *   `SufficiencyDiagnosticComparisonReport` with
 *   per-variant reports plus a per-label
 *   cross-variant table.
 *
 *   The output is intentionally additive. The
 *   existing benchmark / audit / calibration /
 *   policy report shapes are NOT changed; a
 *   reviewer who wants the candidate-set
 *   diagnostic reads the `*sufficiency-*` artifact
 *   under `.curion/benchmark/`.
 */

import type { BenchmarkQuery, BenchmarkQueryFamily } from "./queries.js";
import type { QueryEval } from "./metrics.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stable candidate-set-sufficiency label. The label
 * is a single lowercase kebab-case string. The label
 * table is documented on the per-family behavior
 * section above; a future label addition must be
 * added to the `SUFFICIENCY_LABELS` set below and
 * the `SufficiencyLabel` union, both of which are
 * deliberately explicit so the contract is visible
 * at the call site.
 */
export type SufficiencyLabel =
  | "sufficient"
  | "partial"
  | "insufficient"
  | "wrong-current-truth"
  | "near-miss"
  | "confabulation"
  | "no-answer-correct";

/**
 * The full set of stable labels. Exported so tests
 * can pin the label table by hand and a reviewer can
 * grep the artifact for the documented set.
 */
export const SUFFICIENCY_LABELS: ReadonlySet<SufficiencyLabel> = new Set([
  "sufficient",
  "partial",
  "insufficient",
  "wrong-current-truth",
  "near-miss",
  "confabulation",
  "no-answer-correct",
]);

/**
 * Per-query diagnostic. The block is additive: it
 * is NOT embedded in the existing `QueryEval`
 * (which is the runner's wire contract) and is
 * produced from a `QueryEval` by the diagnostic
 * helper. The `rawCounts` block is kept on the
 * object so a reviewer can re-derive the label by
 * hand without re-implementing the classifier.
 */
export interface SufficiencyDiagnostic {
  queryId: string;
  family: BenchmarkQueryFamily;
  label: SufficiencyLabel;
  /**
   * Raw counts the classifier consumed. Kept on
   * the diagnostic so a reviewer can verify the
   * label by hand:
   *
   *   - `expectedTotal`        — `expectedIds.length`.
   *   - `expectedInTopK`       — how many of
   *     `expectedIds` are in `topIds`.
   *   - `currentTruthInTopK`   — how many of
   *     `currentTruthIds` are in `topIds`.
   *   - `rank1IsExpected`      — `topIds[0] ∈ expectedIds`.
   *   - `rank1IsCurrentTruth`  — `topIds[0] ∈ currentTruthIds`.
   *   - `topKSize`             — `topIds.length` the
   *     ranker actually returned (may be < the
   *     configured `topK` for a low-confidence run).
   *   - `hasNearMissLabel`     — `true` iff the query
   *     carries a `nearMissCurrentCluster` or
   *     `adversarialParaphrase` adversarial label.
   */
  rawCounts: {
    expectedTotal: number;
    expectedInTopK: number;
    currentTruthInTopK: number;
    rank1IsExpected: boolean;
    rank1IsCurrentTruth: boolean;
    topKSize: number;
    hasNearMissLabel: boolean;
  };
}

/**
 * Per-variant sufficiency diagnostic report. The
 * report is the unit a benchmark run writes to
 * disk; the per-label counts and per-family
 * breakdown are the headline numbers a reviewer
 * reads.
 */
export interface SufficiencyDiagnosticReport {
  /** Stable variant label (lexical / fts5 / vector /
   *  hybrid / vector-dense-stub). Mirrors the
   *  existing per-variant vocabulary so a reviewer
   *  can grep. */
  variant: string;
  /** Per-query diagnostics. Same order as the
   *  input `evals`. */
  diagnostics: ReadonlyArray<SufficiencyDiagnostic>;
  /** Per-label counts across the whole run. */
  perLabel: Record<SufficiencyLabel, number>;
  /** Per-family per-label counts. The key is
   *  `family` (the canonical family name) and the
   *  value is a per-label count for that family.
   *  A family with zero queries on a variant is
   *  omitted from the record. */
  perFamily: Record<
    BenchmarkQueryFamily,
    Record<SufficiencyLabel, number>
  >;
}

/**
 * Cross-variant comparison report. Produced by
 * `buildSufficiencyComparison`. The block is the
 * natural artifact a reviewer reads when comparing
 * the lexical / fts5 / vector / hybrid / dense
 * candidate sets on the same query slice. The
 * report carries the per-variant sub-reports plus
 * a per-label cross-variant table so a reviewer
 * can answer "is the candidate set sufficient
 * more often on the hybrid than on the lexical
 * baseline?" at a glance.
 */
export interface SufficiencyDiagnosticComparisonReport {
  generatedAt: string;
  /** Per-variant reports in the order they were
   *  passed to the builder. */
  variants: ReadonlyArray<SufficiencyDiagnosticReport>;
  /**
   * Per-label cross-variant table. For each
   * label, the count of queries on each variant.
   * A variant that does not include a given label
   * is reported as 0. The keys are stable
   * (`SufficiencyLabel` strings).
   */
  crossVariantPerLabel: Record<
    SufficiencyLabel,
    Record<string, number>
  >;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify the candidate set a ranker returned for
 * a single query. The function is pure: same
 * `QueryEval` + `BenchmarkQuery` -> same label. The
 * `query` argument is used for the optional
 * `labels` field (the per-query `QueryEval` does
 * NOT carry the labels; the labels live on the
 * fixture `BenchmarkQuery`).
 *
 * Edge cases:
 *   - `family === "no-answer"` and `topIds.length === 0` ->
 *     `"no-answer-correct"`.
 *   - `family === "no-answer"` and `topIds.length > 0` ->
 *     `"confabulation"`. The no-answer family is never
 *     `near-miss` because the confabulation signal is
 *     `confabulation`, not `near-miss`.
 *   - `expectedIds.length === 0` on a non-no-answer family
 *     is malformed (the fixture contract guarantees
 *     `expectedIds.length > 0` on positive families), but
 *     the classifier handles it defensively: it returns
 *     `"insufficient"`.
 *
 * The classifier does not perform any re-ranking or
 * score normalization. It consumes the `topIds` the
 * ranker already produced.
 */
export function classifyCandidateSetSufficiency(
  e: QueryEval,
  query: BenchmarkQuery,
): SufficiencyDiagnostic {
  const family = query.family;
  const expected = query.expectedIds;
  const currentTruth = query.currentTruthIds;
  const topIds = e.topIds;
  const top0 = topIds.length >= 1 ? topIds[0]! : undefined;
  const expectedSet = new Set(expected);
  const currentTruthSet = new Set(currentTruth);
  const expectedInTopK = countOverlap(expected, topIds);
  const currentTruthInTopK = countOverlap(currentTruth, topIds);
  const rank1IsExpected = top0 !== undefined && expectedSet.has(top0);
  const rank1IsCurrentTruth =
    top0 !== undefined && currentTruthSet.has(top0);
  const hasNearMissLabel = queryHasNearMissLabel(query);

  // Raw counts first — every branch uses them.
  const rawCounts = {
    expectedTotal: expected.length,
    expectedInTopK,
    currentTruthInTopK,
    rank1IsExpected,
    rank1IsCurrentTruth,
    topKSize: topIds.length,
    hasNearMissLabel,
  };

  // --- no-answer family ---------------------------------------------
  // The no-answer family is the simplest: empty top-K
  // is correct, non-empty top-K is confabulation.
  if (family === "no-answer") {
    const label: SufficiencyLabel =
      topIds.length === 0 ? "no-answer-correct" : "confabulation";
    return { queryId: e.queryId, family, label, rawCounts };
  }

  // --- positive families: defensive empty-expectedIds --------------
  if (expected.length === 0) {
    return {
      queryId: e.queryId,
      family,
      label: "insufficient",
      rawCounts,
    };
  }

  // --- temporal family ---------------------------------------------
  // The temporal family is the most nuanced: a
  // divergent-current-truth query (label
  // `divergentTemporal`) is in the `wrong-current-truth`
  // bucket when the old fact is at the top with the
  // current fact in the top-K. A non-divergent
  // temporal query is in the `wrong-current-truth`
  // bucket iff the OLD fact (which is NOT in
  // `expectedIds` for non-divergent queries) is at the
  // top AND the current fact (which IS the expected
  // id) is in the top-K. The latter is impossible on
  // the current corpus (the corpus's non-divergent
  // temporal queries have `expectedIds` containing
  // only the current fact, so a `wrong-current-truth`
  // case would imply the top-1 is a non-expected id
  // AND the expected id is in the top-K) but the
  // rule is in place so a future corpus revision
  // does not silently change the label table.
  if (family === "temporal") {
    if (rank1IsCurrentTruth) {
      return { queryId: e.queryId, family, label: "sufficient", rawCounts };
    }
    if (e.passed && !rank1IsCurrentTruth) {
      // The current fact is in the top-K (passed
      // for a positive query) but the rank-1 is
      // not the current fact. The strict
      // candidate-set question is: the
      // candidate set IS sufficient (the current
      // fact is in it), but the ranker ranked the
      // wrong fact first. This is the
      // `wrong-current-truth` label.
      return {
        queryId: e.queryId,
        family,
        label: "wrong-current-truth",
        rawCounts,
      };
    }
    if (expectedInTopK === 0) {
      // No expected id in the top-K. The candidate
      // set is insufficient; refine with the
      // near-miss label if the query carries a
      // near-miss adversarial label.
      if (hasNearMissLabel) {
        return {
          queryId: e.queryId,
          family,
          label: "near-miss",
          rawCounts,
        };
      }
      return {
        queryId: e.queryId,
        family,
        label: "insufficient",
        rawCounts,
      };
    }
    // The expected id is in the top-K but neither
    // at rank 1 nor flagged as the current fact at
    // rank 1. The current fact is NOT in the top-K
    // (otherwise `currentTruthAt1` would be true or
    // `passed` would be true via a current-truth
    // hit). The candidate set is partial: it
    // contains the expected id but not at the top.
    return { queryId: e.queryId, family, label: "partial", rawCounts };
  }

  // --- multi-hop family -------------------------------------------
  // Multi-hop coverage: any vs complete. The label
  // table is `sufficient` (complete),
  // `partial` (any but not complete),
  // `near-miss` (no expected but labeled
  // `nearMissCurrentCluster` / `adversarialParaphrase`),
  // `insufficient` otherwise.
  if (family === "multi-hop") {
    if (expectedInTopK === expected.length) {
      return { queryId: e.queryId, family, label: "sufficient", rawCounts };
    }
    if (expectedInTopK > 0) {
      return { queryId: e.queryId, family, label: "partial", rawCounts };
    }
    if (hasNearMissLabel) {
      return { queryId: e.queryId, family, label: "near-miss", rawCounts };
    }
    return { queryId: e.queryId, family, label: "insufficient", rawCounts };
  }

  // --- orientation family -----------------------------------------
  // Orientation is multi-slot. We use
  // `currentTruthId` at rank 1 AND full slot
  // coverage as the `sufficient` rule, and
  // `partial` if at least one expected id is in
  // the top-K. The orientation family on the
  // current corpus has `currentTruthIds ===
  // expectedIds` (no orientation temporal gap), so
  // the rule collapses to "rank-1 is an expected
  // id AND every expected id is in top-K" for
  // `sufficient`, but the general rule is in
  // place so a future orientation temporal gap
  // does not silently change the label table.
  if (family === "orientation") {
    if (
      rank1IsCurrentTruth &&
      expectedInTopK === expected.length
    ) {
      return { queryId: e.queryId, family, label: "sufficient", rawCounts };
    }
    if (expectedInTopK > 0) {
      return { queryId: e.queryId, family, label: "partial", rawCounts };
    }
    if (hasNearMissLabel) {
      return { queryId: e.queryId, family, label: "near-miss", rawCounts };
    }
    return { queryId: e.queryId, family, label: "insufficient", rawCounts };
  }

  // --- exact / paraphrase (and any future
  // non-temporal, non-multi-hop, non-orientation
  // positive family) -----------------------------------------------
  if (rank1IsExpected) {
    return { queryId: e.queryId, family, label: "sufficient", rawCounts };
  }
  if (expectedInTopK > 0) {
    return { queryId: e.queryId, family, label: "partial", rawCounts };
  }
  if (hasNearMissLabel) {
    return { queryId: e.queryId, family, label: "near-miss", rawCounts };
  }
  return { queryId: e.queryId, family, label: "insufficient", rawCounts };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Build a per-variant sufficiency diagnostic report
 * from a list of `QueryEval`s and the matching
 * `BenchmarkQuery` list. The function is pure: same
 * inputs -> same report. The order of the
 * diagnostics matches the order of the `evals` /
 * `queries` inputs.
 *
 * The function validates that `evals.length ===
 * queries.length` and that every `e.queryId ===
 * q.id`; a mismatch is a programming error and the
 * function throws so the bug is caught in tests
 * rather than silently producing a malformed
 * report.
 */
export function buildSufficiencyReport(
  variant: string,
  evals: ReadonlyArray<QueryEval>,
  queries: ReadonlyArray<BenchmarkQuery>,
): SufficiencyDiagnosticReport {
  if (evals.length !== queries.length) {
    throw new Error(
      `buildSufficiencyReport: evals.length (${evals.length}) must match ` +
        `queries.length (${queries.length}) for variant "${variant}"`,
    );
  }
  const diagnostics: SufficiencyDiagnostic[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (e.queryId !== q.id) {
      throw new Error(
        `buildSufficiencyReport: evals[${i}].queryId="${e.queryId}" does ` +
          `not match queries[${i}].id="${q.id}" for variant "${variant}"`,
      );
    }
    diagnostics.push(classifyCandidateSetSufficiency(e, q));
  }
  // Per-label counts.
  const perLabel = freshPerLabelCounts();
  for (const d of diagnostics) {
    perLabel[d.label] += 1;
  }
  // Per-family per-label counts. Only families
  // that actually appear in the input are kept;
  // an absent family is omitted from the record
  // so the report does not carry empty families.
  const perFamily: Record<
    BenchmarkQueryFamily,
    Record<SufficiencyLabel, number>
  > = {} as Record<
    BenchmarkQueryFamily,
    Record<SufficiencyLabel, number>
  >;
  for (const d of diagnostics) {
    const slot = perFamily[d.family] ?? freshPerLabelCounts();
    slot[d.label] += 1;
    perFamily[d.family] = slot;
  }
  return { variant, diagnostics, perLabel, perFamily };
}

/**
 * Build a cross-variant comparison report. The
 * function consumes a list of per-variant reports
 * and produces the cross-variant label table. The
 * per-variant reports are produced by
 * `buildSufficiencyReport`; the comparison builder
 * is pure and does not re-classify any eval.
 */
export function buildSufficiencyComparison(
  reports: ReadonlyArray<SufficiencyDiagnosticReport>,
): SufficiencyDiagnosticComparisonReport {
  const crossVariantPerLabel = freshCrossVariantTable();
  for (const r of reports) {
    for (const label of SUFFICIENCY_LABELS) {
      const slot = crossVariantPerLabel[label]!;
      slot[r.variant] = r.perLabel[label] ?? 0;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    variants: reports,
    crossVariantPerLabel,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Render a per-variant sufficiency report as a
 * human-readable text block. The output is
 * deterministic (no timestamps, no PRNG) so a
 * reviewer can `diff` two runs and the only
 * differences will be the actual numbers. The
 * function is pure: same report -> same string.
 */
export function formatSufficiencyReport(
  report: SufficiencyDiagnosticReport,
): string {
  const out: string[] = [];
  out.push(`# Sufficiency diagnostic (variant: ${report.variant})`);
  out.push("");
  out.push("## Per-label counts");
  out.push("");
  // Stable header order: the label table order
  // matches the `SUFFICIENCY_LABELS` declaration
  // order (sufficient / partial / insufficient /
  // wrong-current-truth / near-miss /
  // confabulation / no-answer-correct). The
  // function iterates the set in insertion order
  // because `SUFFICIENCY_LABELS` is a `Set`
  // constructed from a literal array.
  const total = report.diagnostics.length;
  for (const label of SUFFICIENCY_LABELS) {
    const n = report.perLabel[label] ?? 0;
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
    out.push(`  ${label.padEnd(22)} ${String(n).padStart(4)}  (${pct.padStart(5)}%)`);
  }
  out.push("");
  out.push("## Per-family breakdown");
  out.push("");
  const familyNames = (Object.keys(report.perFamily) as BenchmarkQueryFamily[]).sort();
  for (const family of familyNames) {
    const slot = report.perFamily[family];
    const familyTotal = (Object.values(slot) as number[]).reduce(
      (a, b) => a + b,
      0,
    );
    out.push(`  family=${family} (n=${familyTotal})`);
    for (const label of SUFFICIENCY_LABELS) {
      const n = slot[label] ?? 0;
      if (n === 0) continue; // skip zero-count rows for readability
      const pct =
        familyTotal > 0 ? ((n / familyTotal) * 100).toFixed(1) : "0.0";
      out.push(
        `    ${label.padEnd(22)} ${String(n).padStart(4)}  (${pct.padStart(5)}%)`,
      );
    }
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many ids in `a` are also in `b`. The
 * function is O(|a| + |b|) using sets; `a` and `b`
 * are the small `expectedIds` / `topIds` arrays so
 * the cost is negligible.
 */
function countOverlap(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  let n = 0;
  for (const id of a) if (bSet.has(id)) n += 1;
  return n;
}

/**
 * `true` iff the query carries a `nearMissCurrentCluster`
 * or `adversarialParaphrase` adversarial label. Both
 * labels are documented on the `BenchmarkQuery.labels`
 * field; the helper is a tiny one-liner that keeps the
 * classifier body readable.
 */
function queryHasNearMissLabel(q: BenchmarkQuery): boolean {
  if (!q.labels || q.labels.length === 0) return false;
  return (
    q.labels.includes("nearMissCurrentCluster") ||
    q.labels.includes("adversarialParaphrase")
  );
}

function freshPerLabelCounts(): Record<SufficiencyLabel, number> {
  return {
    sufficient: 0,
    partial: 0,
    insufficient: 0,
    "wrong-current-truth": 0,
    "near-miss": 0,
    confabulation: 0,
    "no-answer-correct": 0,
  };
}

function freshCrossVariantTable(): Record<
  SufficiencyLabel,
  Record<string, number>
> {
  return {
    sufficient: {},
    partial: {},
    insufficient: {},
    "wrong-current-truth": {},
    "near-miss": {},
    confabulation: {},
    "no-answer-correct": {},
  };
}
