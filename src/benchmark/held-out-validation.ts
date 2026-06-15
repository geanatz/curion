/**
 * Benchmark-only held-out validation runner.
 *
 * This module is the v1 implementation of the
 * architect-recommended "frozen-policy prospective
 * query-level holdout" experiment. The brief is
 * explicit: the held-out set is a NEWLY authored
 * query slice, the policies are FROZEN (the same
 * `BUILTIN_POLICIES` the dev-set policy evaluator
 * uses), and the held-out evaluation is run
 * prospectively on the same 132-record corpus the
 * dev set targets. We do NOT retroactively split
 * the 176 dev queries, and we do NOT tune the
 * policies on the held-out results.
 *
 * What the runner does:
 *   1. Consume the held-out query slice
 *      (`HELD_OUT_QUERIES` in `./held-out-queries.ts`).
 *   2. Run the chosen retrieval variant
 *      (`lexical` / `hybrid` / `hybrid-dense`) against
 *      the held-out queries and the same fixed
 *      `BENCHMARK_RECORDS` corpus. The hybrid-dense
 *      path uses the same `Xenova/all-MiniLM-L6-v2`
 *      embedder the dev-set policy evaluator uses
 *      (or the deterministic stub if `--embedder
 *      stub-dense` is passed).
 *   3. Run the abstention-policy evaluator (the same
 *      `runAbstentionPolicy` + `BUILTIN_POLICIES`) on
 *      the held-out evals. The policies are NOT
 *      tuned; the held-out set is held out.
 *   4. Compute transfer deltas: the change in the
 *      per-policy headline numbers (TNR%, posAbst%,
 *      hit@5 retained, rank1 retained, currentTruth@1
 *      retained, P / R / F1) between the held-out
 *      run and the frozen dev-set baseline
 *      (the dev-set baseline is the
 *      `moderate-score-0.40` / `aggressive-score-0.50-no-fp`
 *      / `flag-only-zero-hit-cost` / `low-damage-score-0.30`
 *      numbers from the accepted 132-record / 176-query
 *      expanded fixture).
 *   5. Render the human report and write the JSON
 *      artifact.
 *
 * The runner is reachable through a SEPARATE CLI
 * script (`benchmark:retrieval:held-out` /
 * `:hybrid-dense` / `:hybrid-dense:real`) so a
 * reviewer can re-derive the held-out numbers
 * without touching the dev-set benchmark runner.
 *
 * Scope (benchmark-only):
 *   This module is read-only and never modifies the
 *   production `recall(text)` behavior, the public
 *   MCP API, or the existing dev-set / audit /
 *   calibration / policy report shapes. The held-out
 *   evaluation is a separate artifact with a separate
 *   `retrieval-held-out-validation-*.json` prefix.
 *
 * Honest caveats (the README's "held-out validation"
 * section repeats these):
 *   - SAME-CORPUS validation: the held-out queries
 *     share the 132-record corpus with the dev set.
 *     A reviewer who interprets a positive transfer
 *     delta as "the policy generalises to a new
 *     corpus" is over-reading the result. The right
 *     reading is "the policy does not over-fit to the
 *     dev set's specific query phrasing".
 *   - FROZEN policy: the policies are NOT re-tuned
 *     on the held-out results. A future experiment
 *     that re-tunes them would invalidate the v1
 *     contract.
 *   - SMALL sample: the held-out set is 28 queries.
 *     Headline numbers carry 1-query granularity; a
 *     1-query swing on a small family is a 3-4 pp
 *     swing on the rate. The honest reading block
 *     surfaces this.
 *   - TRANSFER deltas are computed against a
 *     frozen baseline (the 132-record / 176-query
 *     expanded-fixture numbers from the accepted
 *     adversarial-expansion checkpoint). The
 *     baseline is hard-coded as named constants;
 *     a future re-run that re-derives the baseline
 *     from the current fixture is a deliberate,
 *     visible change.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type AbstentionSignals,
  type QueryEval,
  evaluateQuery,
} from "./metrics.js";
import {
  type PolicyDecision,
  type PolicyMetrics,
} from "./abstention-policy.js";
import { runAbstentionPolicy } from "./abstention-policy-runner.js";
import { buildAbstentionAuditPerQuery } from "./abstention-audit-runner.js";
import { BENCHMARK_RECORDS } from "./corpus.js";
import { type BenchmarkQuery } from "./queries.js";
import { buildCandidates } from "./retrieval-runner.js";
import { rankLexical, DEFAULT_TOP_K, type LexicalScoredCandidate } from "../retrieval/lexical.js";
import {
  rankHybrid,
  rankHybridAsync,
  DEFAULT_RRF_K,
  DEFAULT_HYBRID_THRESHOLD,
  type HybridAsyncRankResult,
  type RrfContributor,
  type HybridScoredCandidate,
} from "./variants/hybrid.js";
import {
  type DenseEmbedder,
  type EmbedderMetadata,
} from "./variants/dense-embedder.js";
import {
  HELD_OUT_QUERIES,
  HELD_OUT_QUERY_IDS,
  HELD_OUT_TOTAL_COUNT,
  HELD_OUT_MIN_FAMILY_COUNTS,
  HELD_OUT_MIN_NO_ANSWER_COUNT,
} from "./held-out-queries.js";

// ---------------------------------------------------------------------------
// Frozen transfer baselines
// ---------------------------------------------------------------------------

/**
 * The frozen baseline numbers from the accepted
 * 132-record / 176-query expanded fixture. These are
 * the dev-set numbers a held-out run is compared
 * against. The values are hard-coded (NOT re-computed
 * from the dev set on every run) so the baseline is
 * stable across held-out runs and is auditable
 * against the accepted checkpoint's policy report.
 *
 * The four primary policies are the four the
 * architect advisory calls out as the "core" policy
 * set. The remaining `BUILTIN_POLICIES` ablations are
 * also reported on the artifact for completeness;
 * the held-out transfer delta block is restricted to
 * the four primary policies so the table stays
 * readable.
 *
 * The numbers are the real-MiniLM hybrid-dense
 * policy-evaluator numbers from the accepted
 * 132-record / 176-query adversarial-expansion
 * checkpoint (the prior `experiment/
 * adversarial-benchmark-expansion` branch HEAD;
 * see `docs/architecture.md` and the policy
 * evaluator's documented headline reading).
 */
export const FROZEN_TRANSFER_BASELINES: Readonly<
  Record<
    string,
    {
      tnrPct: number;
      posAbstPct: number;
      hit5RetainedPct: number;
      rank1RetainedPct: number;
      currentTruthAt1RetainedPct: number;
      precision: number;
      recall: number;
      f1: number;
      sourceVariant: string;
    }
  >
> = {
  "flag-only-zero-hit-cost": {
    tnrPct: 69.6,
    posAbstPct: 0.0,
    hit5RetainedPct: 100.0,
    rank1RetainedPct: 100.0,
    currentTruthAt1RetainedPct: 100.0,
    precision: 1.0,
    recall: 0.7,
    f1: 0.82,
    sourceVariant: "hybrid-dense / real-MiniLM",
  },
  "low-damage-score-0.30": {
    tnrPct: 71.7,
    posAbstPct: 1.5,
    hit5RetainedPct: 99.1,
    rank1RetainedPct: 98.9,
    currentTruthAt1RetainedPct: 98.9,
    precision: 0.94,
    recall: 0.72,
    f1: 0.81,
    sourceVariant: "hybrid-dense / real-MiniLM",
  },
  "moderate-score-0.40": {
    tnrPct: 95.7,
    posAbstPct: 12.3,
    hit5RetainedPct: 92.2,
    rank1RetainedPct: 94.4,
    currentTruthAt1RetainedPct: 94.3,
    precision: 0.73,
    recall: 0.96,
    f1: 0.83,
    sourceVariant: "hybrid-dense / real-MiniLM",
  },
  "aggressive-score-0.50-no-fp": {
    tnrPct: 100.0,
    posAbstPct: 23.1,
    hit5RetainedPct: 82.8,
    rank1RetainedPct: 84.4,
    currentTruthAt1RetainedPct: 83.9,
    precision: 0.61,
    recall: 1.0,
    f1: 0.75,
    sourceVariant: "hybrid-dense / real-MiniLM",
  },
};

/**
 * The four primary policies the held-out transfer
 * delta block reports. The full `BUILTIN_POLICIES`
 * ablation grid is reported on the artifact for
 * completeness, but the headline transfer table is
 * restricted to these four so the table stays
 * readable.
 */
export const PRIMARY_POLICY_IDS: ReadonlyArray<string> = [
  "flag-only-zero-hit-cost",
  "low-damage-score-0.30",
  "moderate-score-0.40",
  "aggressive-score-0.50-no-fp",
];

/**
 * The primary policy marker the architect brief
 * pins. The held-out artifact's metadata always
 * surfaces this id so a reviewer can read off
 * which policy is the "primary" policy the
 * transfer table is centered on.
 */
export const PRIMARY_POLICY_ID = "moderate-score-0.40";

// ---------------------------------------------------------------------------
// Held-out variant
// ---------------------------------------------------------------------------

/**
 * The retrieval variant the held-out runner
 * dispatches to. The runner mirrors the dev-set
 * runner's variant set: lexical is the
 * production-baseline path, hybrid is the
 * sync-RRF path, and hybrid-dense is the
 * async-real-MiniLM path (or the deterministic
 * stub if `--embedder stub-dense` is passed).
 */
export type HeldOutVariant =
  | "lexical"
  | "hybrid"
  | "hybrid-dense";

// ---------------------------------------------------------------------------
// Held-out evaluation shapes
// ---------------------------------------------------------------------------

/**
 * The per-query FP / FN list shape on the
 * held-out artifact. Mirrors the
 * `AbstentionPolicyReport` shape so a reviewer
 * can compare per-query damage on the held-out
 * set to the per-query damage on the dev set
 * without re-formatting.
 */
export interface HeldOutFailingQuery {
  queryId: string;
  family: string;
  reason: string;
}

/**
 * The per-policy metric block on the held-out
 * artifact. Mirrors `PolicyMetrics` plus a
 * `transfer` block that holds the per-policy
 * deltas against the frozen baseline.
 */
export interface HeldOutPolicyMetrics extends PolicyMetrics {
  description: string;
  category: "primary" | "ablation";
  /**
   * Transfer delta block. The keys are the
   * four primary policy ids (the ablation
   * policies' transfer block is empty).
   * Each entry is the held-out metric minus
   * the frozen baseline metric. Positive
   * numbers on TNR / hit5Retained /
   * rank1Retained / currentTruthAt1Retained /
   * precision / recall / f1 are improvements;
   * negative numbers on posAbst are
   * improvements. A reviewer reads the block
   * as "the held-out set sees the policy
   * better / worse than the dev set by X
   * pp / X points".
   */
  transfer?: {
    tnrDelta: number;
    posAbstDelta: number;
    hit5RetainedDelta: number;
    rank1RetainedDelta: number;
    currentTruthAt1RetainedDelta: number;
    precisionDelta: number;
    recallDelta: number;
    f1Delta: number;
  };
}

/**
 * The per-policy per-query decisions on the
 * held-out artifact. Mirrors the dev-set policy
 * report's `decisions` block; the field is
 * included on the artifact so a reviewer can
 * audit which gate fired on which held-out
 * query without re-evaluating.
 */
export interface HeldOutPolicyDecisions {
  policyId: string;
  decisions: ReadonlyArray<PolicyDecision>;
}

/**
 * The per-family per-policy metric block on
 * the held-out artifact. Mirrors the dev-set
 * policy report's `positiveAbstainedByFamily`
 * block; the field is included on the artifact
 * so a reviewer can audit per-family positive
 * abstention damage on the held-out set
 * without re-running.
 */
export interface HeldOutPerFamilyRow {
  family: string;
  total: number;
  abstained: number;
  rate: number;
}

/**
 * The top-level held-out validation report.
 * The on-disk artifact is one of these. The
 * shape is intentionally distinct from the
 * existing audit / calibration / policy /
 * benchmark report shapes: the held-out
 * validation is a SEPARATE study of how the
 * FROZEN policy behaves on a NEWLY authored
 * query slice.
 *
 * The metadata block is the reviewer-facing
 * header: it pins the variant, embedder, topK,
 * hybridK, timestamp, corpus count, dev
 * count, held-out count, and the primary
 * policy marker.
 */
export interface HeldOutValidationReport {
  /** ISO timestamp the report was generated at. */
  generatedAt: string;
  /**
   * Metadata block. Surfaced as a top-level
   * `meta` object on the artifact so a
   * reviewer can audit the run config
   * without reading the full `policies` /
   * `perQuery` blocks.
   */
  meta: {
    /** Retrieval variant the held-out evals
     *  were produced on. One of
     *  `lexical` / `hybrid` / `hybrid-dense`. */
    variant: HeldOutVariant;
    /** Top-K the ranker returned. */
    topK: number;
    /** RRF k for hybrid / hybrid-dense runs.
     *  Undefined on `lexical`. */
    hybridK?: number;
    /** Embedder metadata for `hybrid-dense`
     *  runs. The block mirrors the dev-set
     *  dense report's `config.embeddingBackend`
     *  shape; `undefined` on `lexical` / `hybrid`. */
    embedder?: EmbedderMetadata;
    /** Number of records the held-out evals
     *  were produced against. */
    corpusCount: number;
    /** Number of queries in the dev set the
     *  frozen baseline was produced against. */
    devCount: number;
    /** Number of queries in the held-out set. */
    heldOutCount: number;
    /** The primary policy marker. Always
     *  `moderate-score-0.40` in v1. */
    primaryPolicyId: typeof PRIMARY_POLICY_ID;
  };
  /** Per-policy metrics on the held-out set.
   *  The order matches `BUILTIN_POLICIES`
   *  declaration order. */
  policies: ReadonlyArray<HeldOutPolicyMetrics>;
  /** Per-policy per-query decisions. */
  decisions: ReadonlyArray<HeldOutPolicyDecisions>;
  /** Per-family positive abstention
   *  breakdown for the primary policy
   *  (`moderate-score-0.40`). The field is
   *  surfaced on the artifact so a reviewer
   *  can read per-family damage on the
   *  held-out set without re-running. */
  perFamilyByPolicy: Readonly<Record<
    string,
    ReadonlyArray<HeldOutPerFamilyRow>
  >>;
  /** Per-query FP / FN lists, keyed by
   *  policy id. The block is on the artifact
   *  for the four primary policies so a
   *  reviewer can read per-query damage on
   *  the held-out set without re-running. */
  perQueryFpFnByPolicy: Readonly<Record<
    string,
    {
      falsePositives: ReadonlyArray<HeldOutFailingQuery>;
      falseNegatives: ReadonlyArray<HeldOutFailingQuery>;
    }
  >>;
  /** Per-query input the policy evaluator
   *  consumed. The block is on the artifact
   *  so a reviewer can re-derive any policy
   *  by hand. The signals block is included
   *  verbatim. */
  perQuery: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    signals: AbstentionSignals;
    rank1: boolean;
    currentTruthAt1: boolean;
    hitAt5: boolean;
    queryLabels?: string[];
  }>;
  /** Held-out evals. Included on the artifact
   *  so a reviewer can read the held-out
   *  retrieval outcome without re-running. */
  evals: ReadonlyArray<QueryEval>;
  /**
   * Honest / research-only block. The block
   * is surfaced as `limitations` on the
   * artifact so a reviewer reads the same-
   * corpus, frozen-policy, small-sample
   * caveats at the artifact level (not just
   * the human report).
   */
  limitations: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Per-variant held-out eval builder
// ---------------------------------------------------------------------------

/**
 * Run the held-out evals on the given variant.
 * The function is pure: same held-out queries,
 * same corpus, same embedder -> same evals.
 *
 * The implementation mirrors the dev-set
 * `runSingleDenseVariant` path on the dense
 * side and the sync `runSingleVariant` path on
 * the lexical / hybrid side. The function is
 * intentionally structured as a small,
 * self-contained orchestrator so a reviewer
 * can read the held-out retrieval math next
 * to the dev-set retrieval math.
 */
export async function runHeldOutEvals(args: {
  variant: HeldOutVariant;
  queries: ReadonlyArray<BenchmarkQuery>;
  embedder?: DenseEmbedder;
  topK?: number;
  hybridK?: number;
  threshold?: number;
}): Promise<{
  evals: QueryEval[];
  embedderMetadata?: EmbedderMetadata;
  topK: number;
  hybridK?: number;
}> {
  const {
    variant,
    queries,
    embedder,
    topK = DEFAULT_TOP_K,
    hybridK = DEFAULT_RRF_K,
    threshold = DEFAULT_HYBRID_THRESHOLD,
  } = args;
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  for (const q of queries) {
    let ranked: LexicalScoredCandidate[];
    let contributors: RrfContributor[] | undefined;
    let topHybridScore: number | null | undefined;
    if (variant === "lexical") {
      ranked = rankLexical(q.query, candidates, {
        threshold,
        topK,
      });
    } else if (variant === "hybrid") {
      const r: HybridScoredCandidate[] = rankHybrid(q.query, candidates, {
        k: hybridK,
        threshold,
        topK,
      });
      ranked = r.map((c) => ({ id: c.id, score: c.score }));
      topHybridScore = ranked.length > 0 ? ranked[0]!.score : null;
      if (r.length > 0) {
        const top0 = r[0]!;
        contributors = top0.contributors.map((c) => ({
          source: c.source,
          rank: c.rank,
          score: c.score,
          contribution: c.contribution,
          weight: c.weight,
        }));
      } else {
        const labels: Array<"lexical" | "fts5" | "vector"> = [
          "lexical",
          "fts5",
          "vector",
        ];
        contributors = labels.map((src) => ({
          source: src,
          rank: null,
          score: null,
          contribution: 0,
          weight: 1,
        }));
      }
    } else {
      // hybrid-dense (async). The function
      // throws if `embedder` is undefined.
      if (!embedder) {
        throw new Error(
          "runHeldOutEvals: hybrid-dense requires a `embedder` argument",
        );
      }
      // The held-out path uses the same
      // `rankHybridAsync` the dev-set runner
      // uses, so the held-out numbers are
      // directly comparable. The dense
      // forward pass is performed inside
      // `rankHybridAsync` (the `useDenseVector:
      // true` / `denseVectorEmbedder` options
      // populate the dense contributor), so we
      // do not need a separate dense
      // forward-pass call.
      const hybridRes: HybridAsyncRankResult = await rankHybridAsync(
        q.query,
        candidates,
        {
          k: hybridK,
          threshold,
          topK,
          useDenseVector: true,
          denseVectorEmbedder: embedder,
          // The held-out runner embeds the user
          // query string. The `kind: "query"`
          // flag tells the Qwen3 embedder to
          // apply the
          // `Instruct: <task>\nQuery:<query>`
          // instruction prefix on the query side
          // (and unprefixed text on the document
          // side). The fallback embedders
          // (stub, MiniLM) ignore the flag.
          denseKind: "query",
        },
      );
      ranked = hybridRes.hits.map((c) => ({ id: c.id, score: c.score }));
      topHybridScore = ranked.length > 0 ? ranked[0]!.score : null;
      if (hybridRes.hits.length > 0) {
        const top0 = hybridRes.hits[0]!;
        contributors = top0.contributors.map((c) => ({
          source: c.source,
          rank: c.rank,
          score: c.score,
          contribution: c.contribution,
          weight: c.weight,
        }));
      } else {
        const labels: Array<"lexical" | "fts5" | "vector-dense"> = [
          "lexical",
          "fts5",
          "vector-dense",
        ];
        contributors = labels.map((src) => ({
          source: src,
          rank: null,
          score: null,
          contribution: 0,
          weight: 1,
        }));
      }
    }
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const eval_ = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    if (variant === "hybrid" || variant === "hybrid-dense") {
      if (contributors) eval_.hybridContributors = contributors;
      eval_.hybridTopScore = topHybridScore ?? null;
    }
    evals.push(eval_);
  }
  return {
    evals,
    embedderMetadata: embedder?.metadata,
    topK,
    ...(variant === "hybrid" || variant === "hybrid-dense" ? { hybridK } : {}),
  };
}

// ---------------------------------------------------------------------------
// Held-out report builder
// ---------------------------------------------------------------------------

/**
 * Build the held-out validation report. The
 * function is pure: same inputs -> same
 * report. The CLI / test entry points call
 * `runHeldOutEvals` first (async) and then
 * pass the result into this function.
 */
export function buildHeldOutReport(args: {
  variant: HeldOutVariant;
  topK: number;
  hybridK?: number;
  embedderMetadata?: EmbedderMetadata;
  evals: ReadonlyArray<QueryEval>;
  /** The held-out query slice the evals were
   *  produced against. Defaults to
   *  `HELD_OUT_QUERIES`. */
  queries?: ReadonlyArray<BenchmarkQuery>;
  /** Number of dev-set queries the frozen
   *  baseline was produced against. Defaults
   *  to 176 (the accepted adversarial-
   *  expansion dev-set count). */
  devCount?: number;
}): HeldOutValidationReport {
  const {
    variant,
    topK,
    hybridK,
    embedderMetadata,
    evals,
    queries = HELD_OUT_QUERIES,
    devCount = 176,
  } = args;
  // Build the per-query abstention signals
  // block. The function is the same helper
  // the dev-set policy evaluator uses, so the
  // held-out signals block is directly
  // comparable to the dev-set signals block.
  const perQuerySignals = buildAbstentionAuditPerQuery({
    evals,
    queries,
    records: BENCHMARK_RECORDS,
  });
  const signalsByQueryId = new Map<string, AbstentionSignals>();
  for (const p of perQuerySignals) {
    signalsByQueryId.set(p.queryId, p.signals);
  }
  // Build the labels-by-queryId map from the
  // held-out fixture truth. The held-out set
  // uses the same `labels` field convention
  // the dev set uses, so the labels flow
  // through to the per-decision
  // `queryLabels` block.
  const labelsByQueryId = new Map<string, string[]>();
  for (const q of queries) {
    if (q.labels && q.labels.length > 0) {
      labelsByQueryId.set(q.id, [...q.labels]);
    }
  }
  // Build the per-policy decision + metric
  // blocks. The function re-uses the dev-set
  // `runAbstentionPolicy` so the held-out
  // policy math is exactly the same as the
  // dev-set policy math.
  const policyReport = runAbstentionPolicy({
    variant,
    evals,
    signalsByQueryId,
    labelsByQueryId,
  });
  // Build the per-policy transfer deltas for
  // the four primary policies. The block is
  // restricted to the primary policies so the
  // table stays readable; the ablation grid
  // is reported on the artifact for
  // completeness without a transfer block.
  const heldOutPolicies: HeldOutPolicyMetrics[] = policyReport.policies.map(
    (row) => {
      const transfer = computeTransferDelta(row);
      const out: HeldOutPolicyMetrics = {
        ...row,
        description: row.description,
        category: row.category,
        ...(transfer ? { transfer } : {}),
      };
      return out;
    },
  );
  // Build the per-family positive abstention
  // breakdown for each policy. The block is
  // surfaced on the artifact for the four
  // primary policies so a reviewer can read
  // per-family damage on the held-out set
  // without re-running.
  const perFamilyByPolicy: Record<
    string,
    HeldOutPerFamilyRow[]
  > = {};
  for (const row of policyReport.policies) {
    const familyRows: HeldOutPerFamilyRow[] = Object.entries(
      row.positiveAbstainedByFamily,
    )
      .map(([family, slot]) => ({
        family,
        total: slot.total,
        abstained: slot.abstained,
        rate: slot.rate,
      }))
      .sort((a, b) => a.family.localeCompare(b.family));
    perFamilyByPolicy[row.policyId] = familyRows;
  }
  // Build the per-policy per-query FP / FN
  // lists. The block is surfaced on the
  // artifact for the four primary policies.
  const perQueryFpFnByPolicy: Record<
    string,
    { falsePositives: HeldOutFailingQuery[]; falseNegatives: HeldOutFailingQuery[] }
  > = {};
  for (const row of policyReport.policies) {
    perQueryFpFnByPolicy[row.policyId] = {
      falsePositives: row.falsePositives.map((fp) => ({ ...fp })),
      falseNegatives: row.falseNegatives.map((fn) => ({ ...fn })),
    };
  }
  // Per-decision block. The held-out
  // artifact's `decisions` array mirrors the
  // dev-set policy report's `decisions`
  // block.
  const decisions: HeldOutPolicyDecisions[] = policyReport.decisions.map(
    (d) => ({
      policyId: d.policyId,
      decisions: d.decisions,
    }),
  );
  // Per-query input block. The held-out
  // artifact's `perQuery` array mirrors the
  // dev-set policy report's `perQuery` block.
  const perQuery = policyReport.perQuery;
  // Limitations / research-only block. The
  // same block is surfaced on the human
  // report; the artifact carries it as a
  // machine-readable array for tooling.
  const limitations = HELD_OUT_LIMITATIONS;
  return {
    generatedAt: new Date().toISOString(),
    meta: {
      variant,
      topK,
      ...(hybridK !== undefined ? { hybridK } : {}),
      ...(embedderMetadata ? { embedder: embedderMetadata } : {}),
      corpusCount: BENCHMARK_RECORDS.length,
      devCount,
      heldOutCount: queries.length,
      primaryPolicyId: PRIMARY_POLICY_ID,
    },
    policies: heldOutPolicies,
    decisions,
    perFamilyByPolicy,
    perQueryFpFnByPolicy,
    perQuery,
    evals,
    limitations,
  };
}

/**
 * Compute the per-policy transfer delta against
 * the frozen baseline. The function returns
 * `null` for ablation policies (the held-out
 * transfer block is restricted to the four
 * primary policies).
 */
function computeTransferDelta(
  row: PolicyMetrics,
): HeldOutPolicyMetrics["transfer"] | null {
  const baseline = FROZEN_TRANSFER_BASELINES[row.policyId];
  if (!baseline) return null;
  // The deltas are held-out metric minus
  // frozen baseline metric. The deltas are
  // in the same units as the source metrics
  // (percentage points for the rate metrics,
  // raw difference for P / R / F1).
  return {
    tnrDelta: round2(row.noAnswerAbstainedRate * 100 - baseline.tnrPct),
    posAbstDelta: round2(
      row.positiveAbstainedRate * 100 - baseline.posAbstPct,
    ),
    hit5RetainedDelta: round2(
      row.hitAt5RetainedRate * 100 - baseline.hit5RetainedPct,
    ),
    rank1RetainedDelta: round2(
      row.rank1RetainedRate * 100 - baseline.rank1RetainedPct,
    ),
    currentTruthAt1RetainedDelta: round2(
      row.currentTruthAt1RetainedRate * 100 -
        baseline.currentTruthAt1RetainedPct,
    ),
    precisionDelta: round2(row.precision - baseline.precision),
    recallDelta: round2(row.recall - baseline.recall),
    f1Delta: round2(row.f1 - baseline.f1),
  };
}

/**
 * Round a number to 2 decimal places. The
 * transfer-delta block is the only place this
 * helper is used; the human report and
 * artifact use the same rounding so a
 * reviewer reading either is reading the
 * same number.
 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Limitations / research-only block
// ---------------------------------------------------------------------------

/**
 * The held-out validation's limitations /
 * research-only block. The block is surfaced
 * on the artifact (`report.limitations`) and
 * on the human report. The block is
 * intentionally narrow: the brief is explicit
 * that the held-out validation is a v1
 * prospective probe, not a deployment-grade
 * policy evaluation.
 */
export const HELD_OUT_LIMITATIONS: ReadonlyArray<string> = [
  "Same-corpus validation. The held-out queries target the same 132-record corpus the dev set targets. A positive transfer delta does NOT mean 'the policy generalises to a new corpus'. The right reading is 'the policy does not over-fit to the dev set's specific query phrasing'.",
  "Frozen policy. The four primary policies (and the ablation grid) are NOT re-tuned on the held-out results. A future experiment that re-tunes them would invalidate the v1 contract.",
  "Small sample. The held-out set is 28 queries across 6 families. Headline numbers carry 1-query granularity; a 1-query swing on a small family is a 3-4 pp swing on the rate. The honest reading block on the human report surfaces this.",
  "FROZEN_TRANSFER_BASELINES are the dev-set numbers from the accepted 132-record / 176-query adversarial-expansion checkpoint (hybrid-dense / real-MiniLM). The baselines are hard-coded as named constants; a future re-derivation is a deliberate, visible change.",
  "Benchmark-only / research-only. The held-out validation does NOT modify the production `recall(text)` behavior, the public MCP API, or the existing dev-set / audit / calibration / policy report shapes. The held-out artifact is `retrieval-held-out-validation-*.json` and is separate from the dev-set reports.",
  "Hybrid / hybrid-dense runs use the same embedder metadata the dev-set runner uses. The `stub-dense` path is the deterministic stub; the `transformersjs` path is the real `Xenova/all-MiniLM-L6-v2` local model. The held-out artifact surfaces the embedder metadata so a reviewer can audit which embedder produced the numbers.",
  "v1 of the held-out validation is a prospective probe. A future v2 that adds a new corpus, a new query family, or a new policy family is a deliberate, visible change.",
];

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-held-out-validation";

/**
 * Write a held-out validation report to disk.
 * The file prefix is
 * `retrieval-held-out-validation-*.json`
 * (distinct from the existing audit /
 * calibration / policy prefixes) so a
 * reviewer can find the held-out artifacts
 * next to the regular reports without
 * confusing them. The timestamp is the
 * current ISO timestamp with `:` / `.`
 * replaced by `-` so the filename is safe
 * across shells.
 */
export function writeHeldOutReport(
  report: HeldOutValidationReport,
  dir: string,
): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ARTIFACT_FILE_PREFIX}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Format the held-out validation report as a
 * human-readable string. The report is
 * intentionally narrow: the metadata header,
 * the headline transfer table (four primary
 * policies), the per-family positive
 * abstention breakdown for the primary
 * policy, the per-query FP / FN lists for
 * the primary policy, the honest reading
 * block, and the limitations block.
 *
 * The function is pure: same report -> same
 * string. The CLI entry point writes the
 * string to stdout.
 */
export function formatHeldOutReport(
  report: HeldOutValidationReport,
): string {
  const lines: string[] = [];
  lines.push("=== cortex-mcp-v2 retrieval held-out validation ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  // ---- Metadata header ----
  lines.push("--- meta ---");
  lines.push(`  variant:           ${report.meta.variant}`);
  lines.push(`  topK:              ${report.meta.topK}`);
  if (report.meta.hybridK !== undefined) {
    lines.push(`  hybridK:           ${report.meta.hybridK}`);
  }
  if (report.meta.embedder) {
    const m = report.meta.embedder;
    lines.push(
      `  embedder:          ${m.backend} / ${m.modelId ?? "(no model)"} / dim=${m.dim} / status=${m.status}`,
    );
  }
  lines.push(`  corpus count:      ${report.meta.corpusCount}`);
  lines.push(`  dev count:         ${report.meta.devCount}`);
  lines.push(`  held-out count:    ${report.meta.heldOutCount}`);
  lines.push(`  primary policy:    ${report.meta.primaryPolicyId}`);
  lines.push("");
  // ---- READ THIS FIRST block ----
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY prospective probe.");
  lines.push(
    "  The held-out validation evaluates the FROZEN multi-signal",
  );
  lines.push(
    "  abstention policies on a NEWLY authored query slice that",
  );
  lines.push(
    "  targets the SAME 132-record corpus the dev set targets.",
  );
  lines.push(
    "  The policies are NOT re-tuned on the held-out results.",
  );
  lines.push(
    "  The held-out set is a 28-query prospective probe; a 1-query",
  );
  lines.push(
    "  swing on a small family is a 3-4 pp swing on the rate.",
  );
  lines.push(
    "  A positive transfer delta does NOT mean 'the policy",
  );
  lines.push(
    "  generalises to a new corpus'; it means 'the policy does",
  );
  lines.push(
    "  not over-fit to the dev set's specific query phrasing'.",
  );
  lines.push("");
  // ---- Headline transfer table (four primary policies) ----
  lines.push("--- headline transfer (primary policies) ---");
  lines.push(
    "  policy                       held-out TNR%  posAbst%  hit5Ret%  rank1Ret%  curT1Ret%  P     R     F1   |  TNRΔ  posAbstΔ  hit5Δ  rank1Δ  curT1Δ  PΔ   RΔ   F1Δ",
  );
  for (const policyId of PRIMARY_POLICY_IDS) {
    const row = report.policies.find((p) => p.policyId === policyId);
    if (!row) continue;
    const transfer = row.transfer;
    const policyLabel = row.policyId.length > 28
      ? row.policyId.slice(0, 25) + "..."
      : row.policyId;
    lines.push(
      `  ${policyLabel.padEnd(28)}` +
        ` ${(row.noAnswerAbstainedRate * 100).toFixed(1).padStart(6)}` +
        `     ${(row.positiveAbstainedRate * 100).toFixed(1).padStart(5)}` +
        `    ${(row.hitAt5RetainedRate * 100).toFixed(1).padStart(5)}` +
        `     ${(row.rank1RetainedRate * 100).toFixed(1).padStart(5)}` +
        `      ${(row.currentTruthAt1RetainedRate * 100).toFixed(1).padStart(5)}` +
        `   ${row.precision.toFixed(2)}  ${row.recall.toFixed(2)}  ${row.f1.toFixed(2)}` +
        `   |  ` +
        (transfer
          ? `${signedPp(transfer.tnrDelta).padStart(5)}  ${signedPp(transfer.posAbstDelta).padStart(5)}     ${signedPp(transfer.hit5RetainedDelta).padStart(4)}  ${signedPp(transfer.rank1RetainedDelta).padStart(4)}  ${signedPp(transfer.currentTruthAt1RetainedDelta).padStart(4)}   ${signedPp(transfer.precisionDelta).padStart(4)} ${signedPp(transfer.recallDelta).padStart(4)} ${signedPp(transfer.f1Delta).padStart(4)}`
          : "    -       -        -      -       -       -    -    -"),
    );
  }
  lines.push("");
  lines.push(
    "  Transfer deltas (held-out minus frozen baseline) are in",
  );
  lines.push(
    "    percentage points (rates) or raw difference (P / R / F1).",
  );
  lines.push(
    "    Positive TNR / hit5 / rank1 / currentTruth / P / R / F1",
  );
  lines.push(
    "    deltas are improvements. Negative posAbst delta is an",
  );
  lines.push(
    "    improvement (less damage on answerable queries).",
  );
  lines.push("");
  // ---- Per-family positive abstention for the primary policy ----
  const primary = report.policies.find(
    (p) => p.policyId === PRIMARY_POLICY_ID,
  );
  if (primary) {
    lines.push(
      `--- per-family positive abstention (primary: ${PRIMARY_POLICY_ID}) ---`,
    );
    lines.push("  family           total  abstained  rate");
    const rows = report.perFamilyByPolicy[PRIMARY_POLICY_ID] ?? [];
    for (const r of rows) {
      lines.push(
        `  ${r.family.padEnd(16)} ${String(r.total).padStart(4)}    ${String(r.abstained).padStart(4)}     ${(r.rate * 100).toFixed(1).padStart(4)}%`,
      );
    }
    lines.push("");
  }
  // ---- Per-query FP / FN for the primary policy ----
  if (primary) {
    const fpFn = report.perQueryFpFnByPolicy[PRIMARY_POLICY_ID];
    if (fpFn) {
      lines.push(
        `--- recommended policy: false positives (positive queries wrongly abstained) ---`,
      );
      if (fpFn.falsePositives.length === 0) {
        lines.push("  (none)");
      } else {
        for (const fp of fpFn.falsePositives) {
          lines.push(`  [${fp.family}] ${fp.queryId}  reason=${fp.reason}`);
        }
      }
      lines.push("");
      lines.push(
        `--- recommended policy: false negatives (no-answer queries wrongly retained) ---`,
      );
      if (fpFn.falseNegatives.length === 0) {
        lines.push("  (none)");
      } else {
        for (const fn of fpFn.falseNegatives) {
          lines.push(`  [${fn.family}] ${fn.queryId}  reason=${fn.reason}`);
        }
      }
      lines.push("");
    }
  }
  // ---- Honest reading block ----
  lines.push("--- honest reading ---");
  lines.push(
    "  The held-out set is a 28-query prospective probe. The",
  );
  lines.push(
    "  headline numbers carry 1-query granularity; a 1-query",
  );
  lines.push(
    "  swing on a small family is a 3-4 pp swing on the rate.",
  );
  lines.push(
    "  A reviewer who wants to read the headline transfer",
  );
  lines.push(
    "  table should keep the sample size in mind: the",
  );
  lines.push(
    "  held-out set is small enough that a 1-query swing",
  );
  lines.push(
    "  in either direction can move the per-policy TNR /",
  );
  lines.push(
    "  hit@5 retained number by several percentage points.",
  );
  lines.push(
    "  The right reading of a +X pp transfer delta is",
  );
  lines.push(
    "  'the policy does not catastrophically over-fit to the",
  );
  lines.push(
    "  dev set's specific query phrasing', not 'the policy",
  );
  lines.push(
    "  generalises to a new corpus' (see limitations).",
  );
  lines.push("");
  // ---- Limitations block ----
  lines.push("--- limitations (research-only) ---");
  for (const lim of report.limitations) {
    lines.push(`  - ${lim}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Format a signed percentage-point number for
 * the human report. The function is a
 * one-liner helper used only by the human
 * report.
 */
function signedPp(x: number): string {
  const sign = x >= 0 ? "+" : "";
  return `${sign}${x.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Re-export the held-out query set so the
 * CLI / test entry points can read it
 * without an extra import line. The
 * `HELD_OUT_QUERIES` symbol is the source of
 * truth; the re-export is purely
 * convenience.
 */
export {
  HELD_OUT_QUERIES,
  HELD_OUT_QUERY_IDS,
  HELD_OUT_TOTAL_COUNT,
  HELD_OUT_MIN_FAMILY_COUNTS,
  HELD_OUT_MIN_NO_ANSWER_COUNT,
} from "./held-out-queries.js";
