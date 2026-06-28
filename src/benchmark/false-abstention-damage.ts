import {
  BUILTIN_NO_ANSWER_POLICIES,
  type NoAnswerPolicy,
  type NoAnswerPolicyDecision,
  type NoAnswerPolicyPerQuery,
  evaluateNoAnswerPolicy,
} from "./no-answer-abstention.js";
import type { SufficiencyLabel } from "./sufficiency-diagnostic.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The stable damage-category set. The names are
 * stable strings; a future addition must be added
 * to `DAMAGE_CATEGORIES` and the
 * `DamageCategory` union, both of which are
 * deliberately explicit so the contract is visible
 * at the call site.
 *
 * The category is the action-class for a false
 * abstention. A reviewer who wants to decide
 * "should the abstention be tightened, loosened,
 * or kept?" reads the category.
 */
export type DamageCategory =
  | "ranker-empty-recoverable"
  | "score-threshold-on-recoverable"
  | "score-threshold-on-real-failure"
  | "sufficiency-label-honest"
  | "multi-gate-conjunction-honest"
  | "labeled-near-miss-or-divergent"
  | "labeled-oracle-misclassification"
  | "unclassified";

/**
 * The full set of stable categories, in the
 * priority order the classifier uses (first
 * match wins). Exported so tests can pin the
 * category table by hand and a reviewer can grep
 * the artifact for the documented set.
 */
export const DAMAGE_CATEGORIES: ReadonlyArray<DamageCategory> = [
  "ranker-empty-recoverable",
  "labeled-near-miss-or-divergent",
  "score-threshold-on-recoverable",
  "score-threshold-on-real-failure",
  "sufficiency-label-honest",
  "multi-gate-conjunction-honest",
  "labeled-oracle-misclassification",
  "unclassified",
];

/**
 * The per-FP damage block. The shape is what the
 * report's per-FP list and per-category rollup
 * consume. The fields are:
 *   - `queryId` — the fixture's stable id.
 *   - `family` — the benchmark's family field.
 *   - `reason` — the policy's per-query reason
 *     string (e.g. "score-below-0.3" or
 *     "score-below-0.3+sufficiency-in-insufficient|confabulation").
 *   - `category` — the assigned damage category.
 *   - `categoryExplanation` — a short human-
 *     readable explanation of why the category
 *     fits.
 *   - `topScore` — the ranker's top-1 score
 *     (pass-through from the per-query input).
 *   - `sufficiencyLabel` — the candidate-set
 *     sufficiency label (pass-through; `undefined`
 *     if the diagnostic did not produce one).
 *   - `rank1`, `hit@5` — pass-through retrieval
 *     outcomes so a reviewer can audit the
 *     `category` without re-deriving.
 *   - `queryLabels` — pass-through fixture-truth
 *     labels (`undefined` for unlabeled queries).
 *   - `semanticRecoverable` — `true` iff the
 *     supplied semantic-evidence map records the
 *     dense ranker as having surfaced the right
 *     answer at rank 1. `undefined` when no
 *     semantic evidence is supplied.
 *   - `semanticAlsoMisses` — `true` iff the
 *     supplied semantic-evidence map records the
 *     dense ranker as having rank-1-missed the
 *     query. `undefined` when no semantic
 *     evidence is supplied.
 */
export interface FalseAbstentionDamageEntry {
  queryId: string;
  family: string;
  reason: string;
  category: DamageCategory;
  categoryExplanation: string;
  topScore: number;
  sufficiencyLabel?: SufficiencyLabel;
  rank1: boolean;
  hitAt5: boolean;
  queryLabels?: string[];
  semanticRecoverable?: boolean;
  semanticAlsoMisses?: boolean;
}

/**
 * The per-category summary. Surfaced on the
 * report's headline table so a reviewer can read
 * the "what fraction of the damage is X?" answer
 * without re-deriving.
 */
export interface DamageCategorySummary {
  category: DamageCategory;
  count: number;
  rate: number;
  explanation: string;
}

/**
 * The semantic-evidence rollup. Surfaced on the
 * report so a reviewer can see "of the 24 FPs,
 * the dense ranker could have recovered N" at a
 * glance. The fields are `undefined` when no
 * semantic evidence is supplied.
 */
export interface SemanticEvidenceRollup {
  /** Total FPs annotated. */
  annotated: number;
  /** FPs the dense ranker could have recovered
   *  (rank-1 hit on the dense benchmark OR
   *  not covered by the supplied map). */
  recoverable: number;
  /** FPs the dense ranker also rank-1-missed. */
  alsoMisses: number;
  /**
   * FPs the supplied map did NOT cover. In
   * the conventional "sparse miss-only" map
   * the runner ships, this is zero on the
   * production corpus. The field is
   * preserved for future expansion.
   */
  uncovered: number;
  /** Source string the caller passed in. The
   *  report surfaces this verbatim so a
   *  reviewer can audit where the evidence
   *  came from. */
  evidenceSource: string;
}

/**
 * The per-score-band per-category cross-tab.
 * A reviewer who wants to know "if I raised the
 * score threshold to 0.40, which FPs would I save
 * and which would I still lose?" reads this.
 *
 * The bands are `topScore < 0.10`, `0.10 <=
 * topScore < 0.20`, `0.20 <= topScore < 0.30`,
 * `0.30 <= topScore < 0.50`, `0.50 <= topScore <
 * 0.75`, `topScore >= 0.75`. A query with
 * `topScore === 0` lands in the first band.
 */
export interface ScoreBandDamageEntry {
  band: string;
  bandMin: number;
  bandMax: number;
  count: number;
  byCategory: Record<DamageCategory, number>;
}

/**
 * The per-family per-category cross-tab. A
 * reviewer who wants to see "the paraphrase
 * damage is mostly `score-threshold-on-real-
 * failure` while the orientation damage is mostly
 * `sufficiency-label-honest`" reads this.
 */
export interface FamilyDamageEntry {
  family: string;
  count: number;
  byCategory: Record<DamageCategory, number>;
}

/**
 * The top-level damage report. The on-disk
 * artifact is one of these. The shape is
 * intentionally additive: the existing audit /
 * calibration / diagnostic / policy / no-answer
 * report shapes are NOT changed.
 */
export interface FalseAbstentionDamageReport {
  generatedAt: string;
  /** Configuration block. The fields are honest
   *  about what was supplied (e.g.
   *  `policyId` is the no-answer policy id the
   *  damage was analyzed for; `evidenceSource` is
   *  the semantic-evidence source string, or
   *  `undefined` when no semantic evidence was
   *  supplied). */
  config: {
    policyId: string;
    policyCategory: "production-like" | "fixture-shaped" | "oracle";
    recordCount: number;
    queryCount: number;
    total: number;
    noAnswerCount: number;
    positiveCount: number;
    falseAbstainedTotal: number;
    positiveAbstainedRate: number;
    evidenceSource?: string;
  };
  /** Per-FP damage entries in fixture order
   *  (the order of the input `perQuery` array,
   *  filtered to the FPs only). */
  entries: ReadonlyArray<FalseAbstentionDamageEntry>;
  /** Per-category summary, sorted by count
   *  descending. Categories with zero FPs are
   *  included with `count: 0` so the report is
   *  complete. */
  categorySummary: ReadonlyArray<DamageCategorySummary>;
  /** Per-family per-category cross-tab, sorted
   *  by family name. */
  familyBreakdown: ReadonlyArray<FamilyDamageEntry>;
  /** Per-score-band per-category cross-tab,
   *  sorted by `bandMin` ascending. */
  scoreBandBreakdown: ReadonlyArray<ScoreBandDamageEntry>;
  /** Semantic-evidence rollup, or `undefined`
   *  when no semantic evidence was supplied. */
  semanticRollup?: SemanticEvidenceRollup;
  /**
   * The per-FP input the classifier consumed.
   * The block is on the artifact so a reviewer
   * can re-derive the category assignments by
   * hand.
   */
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>;
  /**
   * The per-query decisions the policy
   * evaluator produced. The block is on the
   * artifact so a reviewer can audit which
   * gate fired on which query without re-
   * evaluating.
   */
  decisions: ReadonlyArray<NoAnswerPolicyDecision>;
}

// ---------------------------------------------------------------------------
// Category classifier
// ---------------------------------------------------------------------------

/**
 * Human-readable explanation per category. Kept
 * here (not in the report formatter) so the
 * per-FP entry's `categoryExplanation` field is
 * self-contained.
 */
const CATEGORY_EXPLANATION: Record<DamageCategory, string> = {
  "ranker-empty-recoverable":
    "ranker returned 0 candidates; the score gate caught the empty result. A denser ranker that can surface a candidate where the lexical ranker returned nothing would recover this. This is a candidate-generation problem, NOT a policy problem.",
  "score-threshold-on-recoverable":
    "score gate fired but the ranker DID return the right answer at rank 1 (rank1=true or hit@5=true). The policy's score threshold is below the rank-1's score. A different threshold OR a rank-1-check escape would recover this. This is a policy problem: the threshold is too tight for the rank-1's typical score band.",
  "score-threshold-on-real-failure":
    "score gate fired AND the ranker failed to surface the right answer (rank1=false, hit@5=false). The lexical ranker genuinely failed; the policy correctly caught the low-confidence case. The abstention is honest. This is a ranker problem, NOT a policy problem.",
  "sufficiency-label-honest":
    "the candidate-set sufficiency label is insufficient or confabulation; the ranker returned the wrong candidate set. The policy correctly caught the missing-candidate case. The abstention is honest. This is a ranker problem, NOT a policy problem.",
  "multi-gate-conjunction-honest":
    "both score and sufficiency gates fired; the policy is double-counting a single underlying ranker failure. The abstention is honest but conservative. A simpler policy (score-only OR sufficiency-only) would still have abstained. The damage is real but not from the disjunction.",
  "labeled-near-miss-or-divergent":
    "the query carries a `nearMissCurrentCluster` / `divergentTemporal` / `adversarialParaphrase` label. The fixture flagged the query as deliberately ambiguous; abstention may be the correct call. A reviewer who wants to recover this is recovering a fixture adversarial, not a regular query.",
  "labeled-oracle-misclassification":
    "the query carries a `hardNegative` / `falsePremise` label. The fixture tagged the query as a no-answer-shape query, but the query is answerable (isPositive=true). This is a fixture-design artifact: the label is in tension with the answerability flag. Currently expected to be empty on the production corpus; if it ever fires, the fixture needs to be reviewed.",
  unclassified:
    "the FP did not match any documented category. This is a deliberate signal that the category table needs an addition.",
};

/**
 * Classify a single false-positive (a positive
 * query the policy abstained on) into a
 * damage category. The function is pure. The
 * per-query `entry` argument is the per-FP
 * block the report's `entries` list contains;
 * the per-query `pq` argument is the full
 * per-query input the policy evaluator
 * consumed. The two are paired by `queryId`.
 *
 * The `signals` and `sufficiencyLabel` fields
 * are pulled from `pq` (the source of truth) and
 * the `rank1` / `hitAt5` / `queryLabels` fields
 * are pulled from the `entry` (the policy
 * evaluator's pass-through).
 */
export function classifyFalseAbstention(
  entry: {
    queryId: string;
    family: string;
    reason: string;
    rank1: boolean;
    hitAt5: boolean;
    queryLabels?: string[];
  },
  pq: NoAnswerPolicyPerQuery
): DamageCategory {
  const signals = pq.signals;
  const topScore = signals.topScore;
  const returnedCount = signals.returnedCount;
  const topKSize = pq.topKSize;
  const label = pq.sufficiencyLabel;
  const scoreFired = entry.reason.includes("score-below");
  const suffFired = entry.reason.includes("sufficiency-in");
  const queryLabels = entry.queryLabels ?? [];
  // -- Priority 1: ranker returned ZERO
  //    candidates. The score gate caught
  //    the empty result. A denser ranker
  //    that surfaces a candidate where the
  //    lexical ranker could not would
  //    recover this.
  if (scoreFired && topScore === 0 && returnedCount === 0 && topKSize === 0) {
    return "ranker-empty-recoverable";
  }
  // -- Priority 2: the query carries a near-miss
  //    or divergent label. The fixture flagged
  //    the query as deliberately ambiguous;
  //    the label is the dominant signal.
  //    The score/sufficiency analysis is
  //    secondary: a query that the fixture
  //    designed to be hard is a different
  //    problem class than a regular ranker
  //    failure.
  if (
    queryLabels.includes("nearMissCurrentCluster") ||
    queryLabels.includes("divergentTemporal") ||
    queryLabels.includes("adversarialParaphrase")
  ) {
    return "labeled-near-miss-or-divergent";
  }
  // -- Priority 3: score gate fired but ranker
  //    DID return the right answer. The
  //    threshold is too tight for the rank-1's
  //    score. This is the most actionable
  //    policy damage: raising the threshold or
  //    adding a rank-1-check would recover it.
  if (scoreFired && !suffFired && (entry.rank1 || entry.hitAt5)) {
    return "score-threshold-on-recoverable";
  }
  // -- Priority 4: score gate fired AND the
  //    ranker genuinely failed. The policy is
  //    being honest. The damage is real, but it
  //    is a ranker problem, not a policy
  //    problem.
  if (scoreFired && !suffFired && !entry.rank1 && !entry.hitAt5) {
    return "score-threshold-on-real-failure";
  }
  // -- Priority 5: sufficiency-label gate fired
  //    alone. The candidate set is wrong; the
  //    ranker is at fault.
  if (suffFired && !scoreFired) {
    return "sufficiency-label-honest";
  }
  // -- Priority 6: both gates fired. The policy
  //    is double-counting. The abstention is
  //    honest but conservative.
  if (scoreFired && suffFired) {
    return "multi-gate-conjunction-honest";
  }
  // -- Priority 7: the query carries a
  //    hardNegative / falsePremise label. The
  //    fixture tagged the query as a no-answer-
  //    shape query, but the query is
  //    answerable. Fixture-design artifact.
  if (queryLabels.includes("hardNegative") || queryLabels.includes("falsePremise")) {
    return "labeled-oracle-misclassification";
  }
  // -- Default: not classified. The report
  //    surfaces this as its own row so a
  //    reviewer can audit.
  return "unclassified";
}

// ---------------------------------------------------------------------------
// Score-band assignment
// ---------------------------------------------------------------------------

/**
 * The score-band table. The bands are
 * `topScore < 0.10`, `0.10 <= topScore < 0.20`,
 * `0.20 <= topScore < 0.30`, `0.30 <= topScore <
 * 0.50`, `0.50 <= topScore < 0.75`, `topScore >=
 * 0.75`. The bands are deliberately
 * threshold-aligned: the production-like
 * policy's score gate fires at 0.30, so the
 * `0.20 <= topScore < 0.30` and `0.30 <= topScore
 * < 0.50` bands are the natural "did the
 * threshold make a difference?" reading. A
 * reviewer who wants to know "if I raised the
 * score threshold to 0.40, which FPs would I
 * save?" reads the `0.30 <= topScore < 0.50`
 * band.
 *
 * The table is exported as a frozen array so
 * the test can pin the band order and a
 * reviewer can grep the artifact for the
 * documented set.
 */
export const SCORE_BANDS: ReadonlyArray<{
  label: string;
  min: number;
  max: number;
}> = [
  { label: "topScore<0.10", min: Number.NEGATIVE_INFINITY, max: 0.1 },
  { label: "0.10<=topScore<0.20", min: 0.1, max: 0.2 },
  { label: "0.20<=topScore<0.30", min: 0.2, max: 0.3 },
  { label: "0.30<=topScore<0.50", min: 0.3, max: 0.5 },
  { label: "0.50<=topScore<0.75", min: 0.5, max: 0.75 },
  { label: "topScore>=0.75", min: 0.75, max: Number.POSITIVE_INFINITY },
];

/**
 * Map a top-score to its band label. The
 * function is pure. The band is the `label`
 * field on the `SCORE_BANDS` table; the
 * `min` and `max` are inclusive lower /
 * exclusive upper bounds except the last
 * band (topScore>=0.75, which has
 * `max: Infinity`).
 */
export function scoreBandFor(topScore: number): {
  label: string;
  min: number;
  max: number;
} {
  for (const b of SCORE_BANDS) {
    if (topScore >= b.min && topScore < b.max) return b;
  }
  // Fallback (should not happen with finite
  // topScore, but be defensive).
  return SCORE_BANDS[SCORE_BANDS.length - 1]!;
}

// ---------------------------------------------------------------------------
// Semantic-evidence map
// ---------------------------------------------------------------------------

/**
 * The semantic-evidence map. The caller passes
 * in a `queryId -> "hit" | "miss"` map derived
 * from a separate dense benchmark. The map is
 * the source of truth for the
 * `semanticRecoverable` / `semanticAlsoMisses`
 * annotations on each FP.
 *
 * The map is conventionally a SPARSE
 * "miss"-only set: only the queries the dense
 * ranker rank-1-missed are recorded. A query
 * that is NOT in the map is interpreted as
 * "the dense ranker did NOT rank-1-miss the
 * query" — i.e. the dense ranker would have
 * surfaced the right answer at rank 1. The
 * per-FP entry's `semanticRecoverable` is
 * `true` for these queries; the rollup's
 * `recoverable` count tracks them.
 *
 * The "hit" / "miss" union is preserved for
 * future expansion: a future caller that
 * records a full "hit" set can pass it in,
 * and the per-FP annotation will continue
 * to be correct. A "hit" entry sets
 * `semanticRecoverable=true`; a "miss" entry
 * sets `semanticRecoverable=false`.
 */
export interface SemanticEvidenceMap {
  /** The pre-computed map. */
  byQueryId: ReadonlyMap<string, "hit" | "miss">;
  /**
   * Source string the report surfaces verbatim
   * (e.g. "embeddinggemma-hybrid-dense-176-queries-v1").
   * Required so a reviewer can audit where the
   * evidence came from.
   */
  source: string;
}

// ---------------------------------------------------------------------------
// Per-FP entry builder
// ---------------------------------------------------------------------------

/**
 * Build a single FP entry from the per-query
 * input + the policy's per-query decision. The
 * function is pure. The `semantic` argument is
 * optional; when supplied, the entry's
 * `semanticRecoverable` / `semanticAlsoMisses`
 * fields are populated.
 */
function buildEntry(
  decision: NoAnswerPolicyDecision,
  pq: NoAnswerPolicyPerQuery,
  semantic: SemanticEvidenceMap | undefined
): FalseAbstentionDamageEntry {
  const entry: FalseAbstentionDamageEntry = {
    queryId: decision.queryId,
    family: decision.family,
    reason: decision.reason,
    category: "unclassified",
    categoryExplanation: CATEGORY_EXPLANATION.unclassified,
    topScore: pq.signals.topScore,
    rank1: decision.rank1,
    hitAt5: decision.hitAt5,
  };
  if (decision.sufficiencyLabel !== undefined) {
    entry.sufficiencyLabel = decision.sufficiencyLabel;
  }
  if (decision.queryLabels !== undefined) {
    entry.queryLabels = [...decision.queryLabels];
  }
  // Categorize.
  const category = classifyFalseAbstention(
    {
      queryId: decision.queryId,
      family: decision.family,
      reason: decision.reason,
      rank1: decision.rank1,
      hitAt5: decision.hitAt5,
      ...(decision.queryLabels !== undefined ? { queryLabels: [...decision.queryLabels] } : {}),
    },
    pq
  );
  entry.category = category;
  entry.categoryExplanation = CATEGORY_EXPLANATION[category];
  // Semantic annotation.
  if (semantic) {
    const v = semantic.byQueryId.get(decision.queryId);
    if (v === "hit") {
      entry.semanticRecoverable = true;
      entry.semanticAlsoMisses = false;
    } else if (v === "miss") {
      entry.semanticRecoverable = false;
      entry.semanticAlsoMisses = true;
    } else {
      // The map does not cover the query.
      // The contract is: the map is a
      // sparse `{queryId -> "miss"}` set
      // documenting the queries the dense
      // ranker rank-1-missed. A query that
      // is NOT in the map on the
      // production corpus is one the dense
      // ranker did NOT rank-1-miss (i.e.
      // the dense ranker surfaced the right
      // answer at rank 1, OR the query is
      // not in the dense benchmark's
      // coverage). For the FPs the no-
      // answer experiment surfaces, the
      // dense benchmark ran on the same
      // 176-query corpus, so a missing
      // entry means "dense ranker got
      // rank-1 right" — the FP is
      // recoverable from the dense path.
      // This contract is documented on the
      // `SemanticEvidenceMap` interface;
      // the on-disk JSON file uses a
      // sparse "miss"-only map for size
      // efficiency. The semantic rollup
      // treats "not in map" as
      // `recoverable` for the FPs the
      // damage analysis surfaces, and the
      // per-FP entry's
      // `semanticRecoverable` field is
      // set to `true`.
      entry.semanticRecoverable = true;
      entry.semanticAlsoMisses = false;
    }
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Top-level report builder
// ---------------------------------------------------------------------------

/**
 * Build the per-category summary from the
 * per-FP entries. The function is pure. The
 * output is sorted by count descending so the
 * most-frequent category is on top; ties are
 * broken by the `DAMAGE_CATEGORIES` declaration
 * order (which is the priority order the
 * classifier uses).
 */
function buildCategorySummary(
  entries: ReadonlyArray<FalseAbstentionDamageEntry>
): DamageCategorySummary[] {
  const counts: Record<DamageCategory, number> = {
    "ranker-empty-recoverable": 0,
    "score-threshold-on-recoverable": 0,
    "score-threshold-on-real-failure": 0,
    "sufficiency-label-honest": 0,
    "multi-gate-conjunction-honest": 0,
    "labeled-near-miss-or-divergent": 0,
    "labeled-oracle-misclassification": 0,
    unclassified: 0,
  };
  for (const e of entries) counts[e.category] += 1;
  const total = entries.length;
  const order = (c: DamageCategory): number => DAMAGE_CATEGORIES.indexOf(c);
  const summaries: DamageCategorySummary[] = DAMAGE_CATEGORIES.map((c) => ({
    category: c,
    count: counts[c],
    rate: total > 0 ? counts[c] / total : 0,
    explanation: CATEGORY_EXPLANATION[c],
  }));
  summaries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return order(a.category) - order(b.category);
  });
  return summaries;
}

/**
 * Build the per-family per-category cross-tab.
 * The function is pure. The output is sorted by
 * family name ascending.
 */
function buildFamilyBreakdown(
  entries: ReadonlyArray<FalseAbstentionDamageEntry>
): FamilyDamageEntry[] {
  const byFamily = new Map<string, { count: number; byCategory: Record<DamageCategory, number> }>();
  for (const e of entries) {
    let slot = byFamily.get(e.family);
    if (!slot) {
      slot = {
        count: 0,
        byCategory: {
          "ranker-empty-recoverable": 0,
          "score-threshold-on-recoverable": 0,
          "score-threshold-on-real-failure": 0,
          "sufficiency-label-honest": 0,
          "multi-gate-conjunction-honest": 0,
          "labeled-near-miss-or-divergent": 0,
          "labeled-oracle-misclassification": 0,
          unclassified: 0,
        },
      };
      byFamily.set(e.family, slot);
    }
    slot.count += 1;
    slot.byCategory[e.category] += 1;
  }
  const out: FamilyDamageEntry[] = [];
  const familyNames = [...byFamily.keys()].sort();
  for (const family of familyNames) {
    out.push({ family, ...byFamily.get(family)! });
  }
  return out;
}

/**
 * Build the per-score-band per-category cross-
 * tab. The function is pure. The output is
 * sorted by `bandMin` ascending; bands with
 * zero FPs are included so the report is
 * complete.
 */
function buildScoreBandBreakdown(
  entries: ReadonlyArray<FalseAbstentionDamageEntry>
): ScoreBandDamageEntry[] {
  const byBand = new Map<
    string,
    { bandMin: number; bandMax: number; count: number; byCategory: Record<DamageCategory, number> }
  >();
  for (const b of SCORE_BANDS) {
    byBand.set(b.label, {
      bandMin: b.min,
      bandMax: b.max,
      count: 0,
      byCategory: {
        "ranker-empty-recoverable": 0,
        "score-threshold-on-recoverable": 0,
        "score-threshold-on-real-failure": 0,
        "sufficiency-label-honest": 0,
        "multi-gate-conjunction-honest": 0,
        "labeled-near-miss-or-divergent": 0,
        "labeled-oracle-misclassification": 0,
        unclassified: 0,
      },
    });
  }
  for (const e of entries) {
    const band = scoreBandFor(e.topScore);
    const slot = byBand.get(band.label)!;
    slot.count += 1;
    slot.byCategory[e.category] += 1;
  }
  const out: ScoreBandDamageEntry[] = [];
  for (const b of SCORE_BANDS) {
    out.push({ band: b.label, ...byBand.get(b.label)! });
  }
  return out;
}

/**
 * Build the semantic-evidence rollup. The
 * function is pure. Returns `undefined` when
 * no semantic evidence is supplied.
 */
function buildSemanticRollup(
  entries: ReadonlyArray<FalseAbstentionDamageEntry>,
  semantic: SemanticEvidenceMap | undefined
): SemanticEvidenceRollup | undefined {
  if (!semantic) return undefined;
  let annotated = 0;
  let recoverable = 0;
  let alsoMisses = 0;
  let uncovered = 0;
  for (const e of entries) {
    if (e.semanticRecoverable === undefined) {
      uncovered += 1;
    } else {
      annotated += 1;
      if (e.semanticRecoverable) recoverable += 1;
      else if (e.semanticAlsoMisses) alsoMisses += 1;
    }
  }
  return {
    annotated,
    recoverable,
    alsoMisses,
    uncovered,
    evidenceSource: semantic.source,
  };
}

/**
 * Build the full damage report. The function is
 * pure. The `perQuery` input is the same shape
 * the prior no-answer experiment consumes. The
 * `policy` argument is the no-answer policy the
 * damage is analyzed for. The default
 * `policyId` is `score-or-sufficiency-insufficient`
 * (the production-like candidate the prior
 * experiment surfaces); a custom policy can be
 * passed in for an ablation.
 *
 * The function:
 *   1. Evaluates `policy` on `perQuery` to
 *      produce the per-query decision block.
 *   2. Filters the decisions to the FPs (the
 *      positive queries the policy abstained
 *      on).
 *   3. Classifies each FP into a damage
 *      category.
 *   4. Builds the per-category / per-family /
 *      per-score-band / per-semantic rollups.
 *   5. Returns the `FalseAbstentionDamageReport`.
 */
export function buildFalseAbstentionDamageReport(args: {
  recordCount: number;
  perQuery: ReadonlyArray<NoAnswerPolicyPerQuery>;
  /** Optional policy override. The default is
   *  the recommended production-like candidate
   *  the prior experiment surfaces. */
  policy?: NoAnswerPolicy;
  /** Optional semantic evidence (a
   *  pre-computed dense-rank-1 map). When
   *  supplied, each FP is annotated with
   *  `semanticRecoverable` /
   *  `semanticAlsoMisses`. */
  semantic?: SemanticEvidenceMap;
}): FalseAbstentionDamageReport {
  const { recordCount, perQuery, semantic } = args;
  const policy =
    args.policy ??
    BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === "score-or-sufficiency-insufficient");
  if (!policy) {
    throw new Error(
      "buildFalseAbstentionDamageReport: default policy " +
        "'score-or-sufficiency-insufficient' is not in BUILTIN_NO_ANSWER_POLICIES; " +
        "this is a build-time invariant violation"
    );
  }
  const decisions = evaluateNoAnswerPolicy(policy, perQuery);
  // Build a per-query input lookup so we can
  // join decisions -> per-query.
  const pqByQueryId = new Map<string, NoAnswerPolicyPerQuery>();
  for (const p of perQuery) pqByQueryId.set(p.queryId, p);
  // Filter to FPs.
  const entries: FalseAbstentionDamageEntry[] = [];
  for (const d of decisions) {
    if (!d.abstain) continue;
    if (!d.isPositive) continue;
    const pq = pqByQueryId.get(d.queryId);
    if (!pq) {
      // Should not happen: the policy
      // evaluator iterates the per-query
      // input. If it does, surface the bug
      // rather than silently dropping the FP.
      throw new Error(
        `buildFalseAbstentionDamageReport: decision for ${d.queryId} has no matching per-query input`
      );
    }
    entries.push(buildEntry(d, pq, semantic));
  }
  // Totals.
  let total = 0;
  let noAnswerCount = 0;
  let positiveCount = 0;
  for (const p of perQuery) {
    total += 1;
    if (p.isPositive) positiveCount += 1;
    else noAnswerCount += 1;
  }
  const positiveAbstainedRate = positiveCount > 0 ? entries.length / positiveCount : 0;
  // Build the rollups.
  const categorySummary = buildCategorySummary(entries);
  const familyBreakdown = buildFamilyBreakdown(entries);
  const scoreBandBreakdown = buildScoreBandBreakdown(entries);
  const semanticRollup = buildSemanticRollup(entries, semantic);
  const report: FalseAbstentionDamageReport = {
    generatedAt: new Date().toISOString(),
    config: {
      policyId: policy.id,
      policyCategory: policy.category,
      recordCount,
      queryCount: perQuery.length,
      total,
      noAnswerCount,
      positiveCount,
      falseAbstainedTotal: entries.length,
      positiveAbstainedRate,
      ...(semantic ? { evidenceSource: semantic.source } : {}),
    },
    entries,
    categorySummary,
    familyBreakdown,
    scoreBandBreakdown,
    ...(semanticRollup ? { semanticRollup } : {}),
    perQuery,
    decisions,
  };
  return report;
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Format the damage report as a human-readable
 * string. The function is pure: same report ->
 * same string. The output is byte-stable for a
 * fixed input.
 *
 * The output is intentionally narrow:
 *   1. The config block.
 *   2. The honest reading preamble.
 *   3. The per-category summary table.
 *   4. The per-family per-category cross-tab.
 *   5. The per-score-band per-category cross-tab.
 *   6. The semantic-evidence rollup (when
 *      supplied).
 *   7. The per-FP damage list.
 *   8. The honest reading block.
 */
export function formatFalseAbstentionDamageReport(report: FalseAbstentionDamageReport): string {
  const lines: string[] = [];
  lines.push("=== curion false-abstention damage analysis (benchmark-only) ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- config ---");
  lines.push(`  policy id:              ${report.config.policyId}`);
  lines.push(`  policy category:        ${report.config.policyCategory}`);
  lines.push(`  records:                ${report.config.recordCount}`);
  lines.push(`  queries:                ${report.config.queryCount}`);
  lines.push(`  total:                  ${report.config.total}`);
  lines.push(`  no-answer:              ${report.config.noAnswerCount}`);
  lines.push(`  positive:               ${report.config.positiveCount}`);
  lines.push(`  false abstained:        ${report.config.falseAbstainedTotal}`);
  lines.push(
    `  positive abstention:    ${(report.config.positiveAbstainedRate * 100).toFixed(1)}%`
  );
  if (report.config.evidenceSource) {
    lines.push(`  semantic evidence:      ${report.config.evidenceSource}`);
  }
  lines.push("");
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY study.");
  lines.push("  The diagnostic consumes the same per-query input");
  lines.push("  the prior no-answer abstention experiment builds,");
  lines.push("  evaluates the recommended production-like policy");
  lines.push(`  ('${report.config.policyId}'), filters to the false`);
  lines.push("  positives (the damage budget), and classifies each");
  lines.push("  FP into an actionable category. The categories are");
  lines.push("  documented on the CATEGORY_EXPLANATION table inside");
  lines.push("  the module; a reviewer who wants to decide what to");
  lines.push("  do reads the per-category summary first.");
  lines.push("");
  // ---- Per-category summary ----
  lines.push("--- per-category summary ---");
  lines.push("  category                          count  rate   explanation");
  for (const row of report.categorySummary) {
    const cat = row.category.padEnd(34);
    const count = String(row.count).padStart(3);
    const rate = `${(row.rate * 100).toFixed(1)}%`.padStart(6);
    lines.push(`  ${cat} ${count}  ${rate}   ${row.explanation}`);
  }
  lines.push("");
  // ---- Per-family per-category cross-tab ----
  lines.push("--- per-family per-category cross-tab ---");
  lines.push(
    "  family          total  " +
      "rec-emp  sc-recover  sc-fail  suff-hon  multi-gate  labeled-nm  labeled-mc  unclass"
  );
  for (const row of report.familyBreakdown) {
    const fam = row.family.padEnd(16);
    const total = String(row.count).padStart(3);
    const r = (k: DamageCategory): string => String(row.byCategory[k]).padStart(3);
    lines.push(
      `  ${fam} ${total}    ` +
        `${r("ranker-empty-recoverable")}      ` +
        `${r("score-threshold-on-recoverable")}         ` +
        `${r("score-threshold-on-real-failure")}    ` +
        `${r("sufficiency-label-honest")}       ` +
        `${r("multi-gate-conjunction-honest")}        ` +
        `${r("labeled-near-miss-or-divergent")}       ` +
        `${r("labeled-oracle-misclassification")}     ` +
        `${r("unclassified")}`
    );
  }
  lines.push("");
  lines.push("  rec-emp       = ranker-empty-recoverable");
  lines.push("  sc-recover    = score-threshold-on-recoverable");
  lines.push("  sc-fail       = score-threshold-on-real-failure");
  lines.push("  suff-hon      = sufficiency-label-honest");
  lines.push("  multi-gate    = multi-gate-conjunction-honest");
  lines.push("  labeled-nm    = labeled-near-miss-or-divergent");
  lines.push("  labeled-mc    = labeled-oracle-misclassification");
  lines.push("  unclass       = unclassified");
  lines.push("");
  // ---- Per-score-band per-category cross-tab ----
  lines.push("--- per-score-band per-category cross-tab ---");
  lines.push(
    "  band                  total  " +
      "rec-emp  sc-recover  sc-fail  suff-hon  multi-gate  labeled-nm  labeled-mc  unclass"
  );
  for (const row of report.scoreBandBreakdown) {
    const band = row.band.padEnd(20);
    const total = String(row.count).padStart(3);
    const r = (k: DamageCategory): string => String(row.byCategory[k]).padStart(3);
    lines.push(
      `  ${band} ${total}    ` +
        `${r("ranker-empty-recoverable")}      ` +
        `${r("score-threshold-on-recoverable")}         ` +
        `${r("score-threshold-on-real-failure")}    ` +
        `${r("sufficiency-label-honest")}       ` +
        `${r("multi-gate-conjunction-honest")}        ` +
        `${r("labeled-near-miss-or-divergent")}       ` +
        `${r("labeled-oracle-misclassification")}     ` +
        `${r("unclassified")}`
    );
  }
  lines.push("");
  // ---- Semantic-evidence rollup ----
  if (report.semanticRollup) {
    const r = report.semanticRollup;
    lines.push("--- semantic-evidence rollup ---");
    lines.push(`  evidence source:    ${r.evidenceSource}`);
    lines.push(`  annotated:          ${r.annotated}`);
    lines.push(`  recoverable:        ${r.recoverable}`);
    lines.push(`  also misses:        ${r.alsoMisses}`);
    lines.push(`  uncovered:          ${r.uncovered}`);
    const annotated = r.annotated;
    if (annotated > 0) {
      const recPct = (r.recoverable / annotated) * 100;
      const missPct = (r.alsoMisses / annotated) * 100;
      lines.push(
        `  recoverable rate:   ${recPct.toFixed(1)}% ` + `(${r.recoverable} / ${annotated})`
      );
      lines.push(
        `  also-miss rate:     ${missPct.toFixed(1)}% ` + `(${r.alsoMisses} / ${annotated})`
      );
    }
    lines.push("");
  }
  // ---- Per-FP list ----
  lines.push("--- per-FP damage list (in fixture order) ---");
  for (const e of report.entries) {
    const sem = e.semanticRecoverable
      ? "  semantic=recoverable"
      : e.semanticAlsoMisses
        ? "  semantic=also-miss"
        : "";
    const labels =
      e.queryLabels && e.queryLabels.length > 0 ? `  labels=${e.queryLabels.join("|")}` : "";
    lines.push(
      `  [${e.family.padEnd(11)}] ${e.queryId.padEnd(42)}  ` +
        `topScore=${e.topScore.toFixed(3)}  ` +
        `suff=${e.sufficiencyLabel ?? "-"}  ` +
        `rank1=${e.rank1 ? "T" : "F"}  ` +
        `hit5=${e.hitAt5 ? "T" : "F"}  ` +
        `cat=${e.category}` +
        `${sem}${labels}`
    );
  }
  lines.push("");
  // ---- Honest reading block ----
  lines.push("--- honest reading ---");
  lines.push(
    `  The diagnostic was run on policy ` +
      `'${report.config.policyId}' (${report.config.policyCategory}).`
  );
  lines.push(
    `  Total FPs: ${report.config.falseAbstainedTotal} ` +
      `(${report.config.positiveAbstainedRate === 0 ? "0.0" : (report.config.positiveAbstainedRate * 100).toFixed(1)}% of positives).`
  );
  lines.push("  The category table is the action surface:");
  lines.push("    - `score-threshold-on-recoverable` is the");
  lines.push("      actionable policy damage. The ranker DID");
  lines.push("      return the right answer; the score gate");
  lines.push("      is too tight. A different threshold OR a");
  lines.push("      rank-1-check escape would recover these.");
  lines.push("    - `score-threshold-on-real-failure` and");
  lines.push("      `sufficiency-label-honest` are HONEST");
  lines.push("      abstentions. The ranker genuinely failed;");
  lines.push("      the policy is correctly catching the");
  lines.push("      low-confidence case. A different ranker");
  lines.push("      is needed, NOT a policy change.");
  lines.push("    - `multi-gate-conjunction-honest` is a");
  lines.push("      double-count: the policy is conservative");
  lines.push("      on a single underlying failure. A simpler");
  lines.push("      policy (score-only OR sufficiency-only)");
  lines.push("      would still have abstained on the same");
  lines.push("      query.");
  lines.push("    - `ranker-empty-recoverable` is a");
  lines.push("      candidate-generation problem: the ranker");
  lines.push("      returned ZERO candidates. A denser ranker");
  lines.push("      (semantic) can surface a candidate where");
  lines.push("      lexical cannot. The semantic-evidence");
  lines.push("      rollup (when supplied) is the natural way");
  lines.push("      to see how many of these a dense reranker");
  lines.push("      would recover.");
  lines.push("    - `labeled-near-miss-or-divergent` is a");
  lines.push("      fixture adversarial: the query is");
  lines.push("      deliberately calibrated to be ambiguous.");
  lines.push("      Abstention may be the correct call.");
  lines.push("  The semantic-evidence rollup is the only");
  lines.push('  way to see "can a dense reranker recover');
  lines.push('  this?". When supplied, the rollup says so');
  lines.push("  honestly: `recoverable` = the dense ranker");
  lines.push("  got rank-1 right; `also-miss` = the dense");
  lines.push("  ranker also rank-1-missed. A reviewer who");
  lines.push("  wants to decide whether to wire a dense");
  lines.push("  reranker reads the rollup's `recoverable`");
  lines.push("  count.");
  return lines.join("\n");
}
