/**
 * Adaptive recall depth helper (experimental).
 *
 * The production recall pipeline currently caps the synthesis input
 * at a fixed `topK` (default 5) — see `DEFAULT_TOP_K` in
 * `src/retrieval/lexical.ts`. That cap is conservative for narrow
 * precise queries (a single dominant memory) but under-serves
 * queries that genuinely have many closely relevant memories (e.g.
 * "tell me about the project theme" → a project with 20 memories
 * that all describe the theme).
 *
 * This module replaces the fixed cap with a deterministic,
 * threshold-driven selection that:
 *
 *   - Keeps narrow queries effectively tight (a small number of
 *     memories with a clean score gap above the rest).
 *   - Grows for broad queries (or queries with many closely
 *     relevant memories) by retaining all candidates above a
 *     quality floor, capped by a configurable maximum.
 *   - Excludes noisy candidates that fall below the relevance
 *     cluster (by absolute and relative threshold).
 *   - Optionally applies a near-duplicate filter so that two
 *     memories that say almost the same thing do not both flood
 *     the synthesis prompt.
 *   - Never re-ranks; it only truncates a score-sorted input.
 *   - Never invents new candidates; it works over an existing
 *     score-sorted list.
 *
 * The module is pure: no I/O, no logging, no state. It is
 * deliberately separate from the recall controller so the
 * controller stays small and the helper is easy to unit-test in
 * isolation.
 *
 * Public API (all stable, used by the recall controller):
 *   - `AdaptiveDepthStrategy`      ("elbow" | "plateau")
 *   - `AdaptiveDepthConfig`         (configurable knobs)
 *   - `selectAdaptiveCandidates`    (the main selector)
 *   - `applyDiversityFilter`        (post-selection dedup)
 *   - `applyPromptBudget`           (per-memory truncation)
 *
 * The default configuration is conservative and quality-oriented:
 * narrow queries still feel like top-K; broad queries grow up to
 * a capped maximum; the prompt budget guarantees a bounded
 * synthesis prompt.
 */

/**
 * Strategy for adaptive candidate selection.
 *
 * - `"elbow"`:    keep top candidates up to the largest absolute
 *                 score gap within the relative-fraction cluster.
 *                 Best for "many closely relevant memories with a
 *                 clear elbow to noise" queries.
 * - `"plateau"`:  keep walking the ranked list while successive
 *                 scores stay within a fixed tolerance of the
 *                 previous one. Best for "scores stay flat for a
 *                 while then drop" corpora.
 *
 * Both strategies honour `minK`, `maxK`, and the absolute
 * relevance-floor below `relativeFraction * topScore`.
 */
export type AdaptiveDepthStrategy = "elbow" | "plateau";

/**
 * Configuration for adaptive candidate selection.
 *
 * All numeric knobs are bounded by sanity checks inside
 * `selectAdaptiveCandidates`. The defaults are calibrated to
 * "quality over speed": narrow queries stay tight, broad queries
 * grow up to `maxK`, noisy tail candidates are excluded.
 */
export interface AdaptiveDepthConfig {
  /**
   * Which selection strategy to use. Defaults to `"elbow"`.
   * `"plateau"` is provided as an alternative for comparison /
   * ablation.
   */
  strategy?: AdaptiveDepthStrategy;
  /**
   * Minimum number of candidates to keep regardless of scores.
   * The top `minK` ranked candidates are always kept.
   * Default: `3` (small, defensive — never less than the
   * production `weak_match` cap so a refusal reroute still has
   * three summaries to show).
   */
  minK?: number;
  /**
   * Maximum number of candidates to keep. The selector never
   * returns more than this many candidates. Default: `15` (a
   * safe upper bound that the prompt budget will still keep
   * tight; production topK is 5, so this is 3x growth).
   */
  maxK?: number;
  /**
   * Minimum fraction of the top score a candidate must have to
   * be considered for selection past `minK`. Default: `0.5`.
   *   - top score = 0.9 → candidates below 0.45 are noise
   *   - top score = 0.4 → candidates below 0.20 are noise
   * This guards against the "broad query with one strong and
   * twenty weak" case where the top-1 dominates and the rest
   * are below the cluster.
   */
  relativeFraction?: number;
  /**
   * Strategy `"plateau"` only: the absolute score tolerance for
   * "is this still part of the plateau?". A candidate with
   * `score >= previousScore - plateauTolerance` extends the
   * plateau. Default: `0.05` (5% of a unit-score drop).
   */
  plateauTolerance?: number;
  /**
   * Strategy `"elbow"` only: a candidate is included even if
   * its score is below `topScore * relativeFraction`, provided
   * the absolute gap from the previous kept candidate is below
   * `elbowGapTolerance`. This lets a tight cluster survive a
   * relative threshold that would otherwise cut it.
   * Default: `0.05`.
   */
  elbowGapTolerance?: number;
}

/**
 * Resolved configuration with defaults applied. Returned by
 * `resolveAdaptiveDepthConfig` so tests can assert the exact
 * values the controller sees.
 */
export interface ResolvedAdaptiveDepthConfig {
  strategy: AdaptiveDepthStrategy;
  minK: number;
  maxK: number;
  relativeFraction: number;
  plateauTolerance: number;
  elbowGapTolerance: number;
}

/**
 * Resolve a config with defaults applied. Pure; never mutates
 * the input. Returns a `ResolvedAdaptiveDepthConfig` whose
 * fields are all finite and within sane bounds.
 */
export function resolveAdaptiveDepthConfig(
  config: AdaptiveDepthConfig = {}
): ResolvedAdaptiveDepthConfig {
  const strategy: AdaptiveDepthStrategy = config.strategy ?? "elbow";
  const minK = clampInt(config.minK ?? 3, 1, 50);
  const maxK = clampInt(config.maxK ?? 15, minK, 50);
  const relativeFraction = clampNum(config.relativeFraction ?? 0.5, 0, 1);
  const plateauTolerance = clampNum(config.plateauTolerance ?? 0.05, 0, 1);
  const elbowGapTolerance = clampNum(config.elbowGapTolerance ?? 0.05, 0, 1);
  return {
    strategy,
    minK,
    maxK,
    relativeFraction,
    plateauTolerance,
    elbowGapTolerance,
  };
}

/**
 * A scored candidate. Mirrors `LexicalScoredCandidate` in shape
 * but is decoupled so this helper stays free of lexical-rank
 * import cycles.
 */
export interface AdaptiveCandidate {
  id: number;
  score: number;
}

/**
 * Internal record returned by `selectAdaptiveCandidates` for
 * observability. The controller does not currently surface the
 * reason on the wire; the trace system can read it.
 */
export interface AdaptiveSelectionTrace {
  /** Resolved config actually used. */
  config: ResolvedAdaptiveDepthConfig;
  /** Top score among the input candidates. `null` if input was empty. */
  topScore: number | null;
  /** Number of candidates the selector kept. */
  selectedCount: number;
  /** Strategy-specific reason for the cut. */
  reason: string;
}

/**
 * Result of the selector. The selected list is a new array
 * (never a slice that aliases the input). The trace record is
 * for tests / observability.
 */
export interface AdaptiveSelection {
  /** Selected candidates in score-desc, id-desc order. */
  selected: AdaptiveCandidate[];
  /** Trace summary describing how the selection was made. */
  trace: AdaptiveSelectionTrace;
}

/**
 * Select an adaptive subset of an already-ranked candidate list.
 *
 * Inputs:
 *   - `ranked`:     score-sorted candidates (desc), id-desc tiebreak.
 *                   Pure input contract; the function never mutates
 *                   this array.
 *   - `config`:     optional configuration overrides.
 *
 * Output:
 *   - `{ selected, trace }`: `selected` is the score-sorted subset
 *                   to forward to synthesis. `trace` is a small
 *                   observability record used by tests and the
 *                   diagnostic helpers; the controller may
 *                   optionally forward `trace` to a future trace
 *                   event.
 *
 * Determinism:
 *   - Same input + same config → same output.
 *   - The function never throws on empty input (returns empty
 *     selected).
 *   - Ties on score resolve by id-desc (matching `rankLexical`'s
 *     tiebreak).
 *
 * Notes for callers:
 *   - The selector does NOT consult memory content, tags, or any
 *     text. It only uses the score already produced by the
 *     lexical / semantic ranker. This keeps the helper trivially
 *     unit-testable and avoids circular dependencies.
 *   - Superseded-memory demotion must be applied BEFORE this
 *     selector: the demoted candidates carry scores multiplied
 *     by `DEMOTION_FACTOR` and naturally fall below the
 *     relative / absolute cluster.
 */
export function selectAdaptiveCandidates(
  ranked: ReadonlyArray<AdaptiveCandidate>,
  config: AdaptiveDepthConfig = {}
): AdaptiveSelection {
  const cfg = resolveAdaptiveDepthConfig(config);
  const inputLength = ranked.length;
  if (inputLength === 0) {
    return {
      selected: [],
      trace: {
        config: cfg,
        topScore: null,
        selectedCount: 0,
        reason: "empty input",
      },
    };
  }

  // Input contract: ranked is score-desc, id-desc. We trust
  // the caller but re-sort defensively so a caller that
  // accidentally passes an unsorted list still gets a
  // deterministic result. Defensive re-sort is O(n log n) and
  // is a no-op when the input is already sorted.
  const sorted = [...ranked].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });

  const topScore = sorted[0]!.score;
  const relativeFloor = topScore * cfg.relativeFraction;

  // Phase 1: take the top `minK` of the FULL ranked list as
  // the always-included baseline. We deliberately do NOT
  // pre-filter the baseline by the relative floor: a
  // candidate that the lexical ranker surfaced above
  // `threshold` is in the pipeline, and the demotion step
  // may have dropped its score below the relative floor
  // (e.g. via DEMOTION_FACTOR=0.01). Excluding it here
  // would break the superseded-demotion contract, which
  // requires the demoted memory to remain in `sourceIds`
  // (just ranked lower). The `minK` floor therefore
  // operates on the unfiltered ranked list and preserves
  // the strongest, the demoted-stale, and the top-of-noise
  // candidates in a single consistent pass.
  const baselineEnd = Math.min(cfg.minK, sorted.length);
  const baseline = sorted.slice(0, baselineEnd);

  // Phase 2: from the rest, the strategy decides how many
  // more to include. `baselineFloor` is the lowest score in
  // the always-included set; it anchors the "where the
  // cluster bottoms out" for the elbow strategy. The
  // `relativeFloor` (topScore * relativeFraction) is the
  // relevance boundary for additions: a candidate with a
  // score below the boundary is noise and is excluded
  // before the strategy walks the rest.
  const baselineFloor = baselineEnd > 0 ? baseline[baseline.length - 1]!.score : topScore;
  const remainder = sorted.slice(baselineEnd);
  let keptExtras: AdaptiveCandidate[] = [];

  if (cfg.strategy === "plateau") {
    keptExtras = selectPlateau(remainder, baselineFloor, relativeFloor, cfg.plateauTolerance);
  } else {
    keptExtras = selectElbow(remainder, baselineFloor, relativeFloor, cfg.elbowGapTolerance);
  }

  // Phase 3: combine baseline + extras, then apply maxK cap.
  const combined = [...baseline, ...keptExtras];
  const selected = combined.slice(0, cfg.maxK);

  // Build a reason string for the trace. Kept short and
  // bounded — never includes any candidate id or content.
  let reason: string;
  if (selected.length === 0) {
    reason = "no candidates kept";
  } else if (selected.length === baselineEnd && remainder.length === 0) {
    reason = "baseline only (input shorter than minK)";
  } else if (selected.length === cfg.maxK && combined.length > cfg.maxK) {
    reason = `capped at maxK=${cfg.maxK}`;
  } else {
    reason = `${cfg.strategy} kept ${selected.length}/${inputLength}`;
  }

  return {
    selected,
    trace: {
      config: cfg,
      topScore,
      selectedCount: selected.length,
      reason,
    },
  };
}

/**
 * Plateau strategy: walk the remainder while consecutive scores
 * stay close. A candidate is kept if:
 *   - its score is >= the relative floor (relativeFraction *
 *     topScore), AND
 *   - the drop from the previous kept candidate (or the
 *     baseline floor for the first one) is at most
 *     `plateauTolerance`.
 *
 * The plateau extends as far as the consecutive drops stay
 * within tolerance, bounded only by the relative floor. There
 * is NO baseline-floor-based hard cutoff; the plateau is
 * allowed to extend below the baseline as long as each step is
 * within tolerance. This is intentional: the plateau strategy
 * is the "scores stay flat for a while then drop" detector, so
 * a long, flat tail should be kept.
 */
function selectPlateau(
  remainder: ReadonlyArray<AdaptiveCandidate>,
  baselineFloor: number,
  relativeFloor: number,
  plateauTolerance: number
): AdaptiveCandidate[] {
  const out: AdaptiveCandidate[] = [];
  let prevScore = baselineFloor;
  for (const c of remainder) {
    if (c.score < relativeFloor) break; // Below the relative cluster: stop.
    if (prevScore - c.score > plateauTolerance) break; // Sharp drop: end the plateau.
    out.push(c);
    prevScore = c.score;
  }
  return out;
}

/**
 * Elbow strategy: walk the remainder, drop candidates that
 * fall below the relative floor (noise), then cut at the
 * largest absolute gap in the chain
 * `baselineFloor → passes[0] → passes[1] → …`. If the largest
 * gap is at or below `elbowGapTolerance`, the cluster is
 * uniform and we keep all the survivors.
 *
 * The elbow detection is bounded: we look only at gaps between
 * consecutive candidates in the chain, and we cut at the
 * SINGLE largest gap. If the cluster has no large gap (scores
 * stay close), we keep all the cluster. If the cluster has one
 * clear gap, we cut there.
 */
function selectElbow(
  remainder: ReadonlyArray<AdaptiveCandidate>,
  baselineFloor: number,
  relativeFloor: number,
  elbowGapTolerance: number
): AdaptiveCandidate[] {
  // Step 1: keep every remainder candidate above the relative
  // floor. The relative floor is the absolute-lower-bound on
  // "this candidate is in the relevance cluster at all". A
  // candidate below it is noise; we drop it before gap
  // analysis. Demoted (stale) candidates that ended up below
  // the relative floor in Phase 1's baseline are NOT here —
  // they were already taken care of in Phase 1.
  const passes: AdaptiveCandidate[] = [];
  for (const c of remainder) {
    if (c.score < relativeFloor) break;
    passes.push(c);
  }

  if (passes.length === 0) {
    return passes;
  }

  // Step 2: build the full gap chain baselineFloor → passes[0]
  // → passes[1] → … and find the largest absolute gap.
  const gaps: number[] = [];
  gaps.push(baselineFloor - passes[0]!.score); // gap baseline -> first kept
  for (let i = 1; i < passes.length; i++) {
    gaps.push(passes[i - 1]!.score - passes[i]!.score);
  }

  let maxGap = Number.NEGATIVE_INFINITY;
  let maxGapIndex = -1;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]! > maxGap) {
      maxGap = gaps[i]!;
      maxGapIndex = i;
    }
  }

  // Step 3: cut at the largest gap ONLY if it exceeds the
  // tolerance. If the cluster is uniform (every gap is below
  // tolerance), keep the whole cluster. A uniform cluster
  // with 8+ memories and a 0.01 max gap is exactly the
  // "many closely relevant memories" case we want to grow
  // for.
  if (maxGap <= elbowGapTolerance) {
    return passes;
  }

  // maxGapIndex points to the gap. We keep everything
  // BEFORE that gap. For example, maxGapIndex == 2 means the
  // gap is between passes[1] and passes[2]; we keep
  // passes[0..1].
  return passes.slice(0, maxGapIndex);
}

// ---------------------------------------------------------------------------
// Diversity / redundancy filter
// ---------------------------------------------------------------------------

/**
 * A candidate enriched with the text we will use for the
 * redundancy comparison. The selector above is score-only;
 * the diversity filter needs the actual memory text. The
 * controller assembles these `AdaptiveCandidateWithText`
 * records from the safe storage summaries and passes them in.
 */
export interface AdaptiveCandidateWithText {
  id: number;
  score: number;
  /** The memory body. Used for the token-overlap dedup test. */
  text: string;
  /** Optional tags to include in the token set. */
  tags?: string[];
}

/**
 * Configuration for the diversity / redundancy filter.
 *
 * The filter is applied AFTER `selectAdaptiveCandidates` and
 * BEFORE prompt budgeting. It walks the selected list in score-
 * desc order and drops any candidate whose token-overlap with
 * any already-kept candidate is >= `redundancyThreshold`.
 *
 * Disabled by default: the controller opts in when the
 * configuration says to. The default of `0.9` (90% Jaccard
 * overlap) is very conservative — only near-duplicates are
 * deduped.
 */
export interface AdaptiveDiversityConfig {
  /**
   * Jaccard token overlap at which two candidates are
   * considered redundant. `0.9` means "90% of the tokens in
   * the smaller set appear in the larger set". Default: 0.9
   * (very conservative — only near-duplicates are deduped).
   * Pass `1.0` to disable dedup while keeping the pipeline
   * shape intact.
   */
  redundancyThreshold?: number;
  /**
   * When `true`, the filter is applied. When `false` or
   * `undefined`, the filter is a no-op. Default: false
   * (opt-in).
   */
  enabled?: boolean;
}

/**
 * Resolved diversity configuration.
 */
export interface ResolvedAdaptiveDiversityConfig {
  enabled: boolean;
  redundancyThreshold: number;
}

/**
 * Resolve a diversity config with defaults applied.
 */
export function resolveAdaptiveDiversityConfig(
  config: AdaptiveDiversityConfig = {}
): ResolvedAdaptiveDiversityConfig {
  return {
    enabled: config.enabled === true,
    redundancyThreshold: clampNum(config.redundancyThreshold ?? 0.9, 0, 1),
  };
}

/**
 * Tokenize text into a set of normalized word tokens, suitable
 * for Jaccard overlap computation. Mirrors the lexical ranker's
 * stop-word / length rules so the filter sees roughly the same
 * tokens the ranker saw.
 */
function tokenSetForDiversity(text: string, tags?: string[]): Set<string> {
  const out = new Set<string>();
  const combine = `${typeof text === "string" ? text : ""} ${
    Array.isArray(tags) ? tags.join(" ") : ""
  }`;
  for (const raw of combine.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (/^\d+$/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Jaccard overlap between two token sets, in [0, 1].
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // empty == empty
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  for (const t of small) {
    if (big.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Apply a near-duplicate filter over a score-sorted candidate
 * list. Returns the deduplicated list, preserving score order.
 *
 * The filter walks the input in score-desc order; for each
 * candidate it checks the Jaccard token overlap against every
 * already-kept candidate. If the overlap is >= the threshold,
 * the candidate is dropped.
 *
 * The first candidate is always kept (no prior candidate to
 * compare against).
 *
 * Determinism: input order is preserved in the output.
 */
export function applyDiversityFilter(
  candidates: ReadonlyArray<AdaptiveCandidateWithText>,
  config: AdaptiveDiversityConfig = {}
): AdaptiveCandidateWithText[] {
  const cfg = resolveAdaptiveDiversityConfig(config);
  if (!cfg.enabled) {
    return [...candidates];
  }
  if (cfg.redundancyThreshold >= 1) {
    return [...candidates];
  }
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const kept: AdaptiveCandidateWithText[] = [];
  const keptTokens: Set<string>[] = [];

  for (const c of candidates) {
    const tokens = tokenSetForDiversity(c.text, c.tags);
    let redundant = false;
    for (const k of keptTokens) {
      if (jaccard(k, tokens) >= cfg.redundancyThreshold) {
        redundant = true;
        break;
      }
    }
    if (!redundant) {
      kept.push(c);
      keptTokens.push(tokens);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Prompt budget protection
// ---------------------------------------------------------------------------

/**
 * Per-memory and total prompt-budget configuration.
 *
 * The prompt budget is the maximum number of characters we are
 * willing to put into the synthesis user prompt for the MEMORIES
 * section. When the selected candidates would exceed this budget
 * (e.g. many long memories), we truncate each candidate's
 * `memoryContent` to a per-memory cap and then drop the
 * tail-most candidates that no longer fit.
 *
 * The defaults are conservative: 6000 total chars, 500 chars per
 * memory. With `maxK = 15` from the selector, the worst case is
 * 15 * 500 = 7500 chars, which is bounded by the total cap.
 */
export interface AdaptivePromptBudgetConfig {
  /**
   * Maximum total characters across all candidate
   * `memoryContent` strings after per-memory truncation.
   * Default: 6000. Set to `Infinity` to disable the total
   * cap (the per-memory cap still applies).
   */
  totalCharBudget?: number;
  /**
   * Maximum characters per candidate `memoryContent`. Any
   * candidate whose content is longer than this is truncated
   * (with a `[truncated]` marker) before counting toward the
   * total budget. Default: 500.
   */
  perMemoryCharCap?: number;
  /**
   * When `true`, drop candidates that no longer fit after
   * per-memory truncation, walking from the bottom of the
   * list (lowest-scoring candidates). When `false`, drop the
   * topmost candidates instead (never desirable for recall).
   * Default: true.
   */
  dropLowestWhenOverBudget?: boolean;
}

export interface ResolvedAdaptivePromptBudgetConfig {
  totalCharBudget: number;
  perMemoryCharCap: number;
  dropLowestWhenOverBudget: boolean;
}

/**
 * Resolve a prompt-budget config with defaults applied.
 */
export function resolveAdaptivePromptBudgetConfig(
  config: AdaptivePromptBudgetConfig = {}
): ResolvedAdaptivePromptBudgetConfig {
  const total = config.totalCharBudget ?? 6000;
  const per = config.perMemoryCharCap ?? 500;
  return {
    totalCharBudget:
      Number.isFinite(total) && total > 0 ? Math.floor(total) : Number.POSITIVE_INFINITY,
    perMemoryCharCap: Number.isFinite(per) && per > 0 ? Math.floor(per) : Number.POSITIVE_INFINITY,
    dropLowestWhenOverBudget: config.dropLowestWhenOverBudget !== false,
  };
}

/**
 * Result of `applyPromptBudget`: the (possibly truncated,
 * possibly trimmed) list plus a trace summary.
 */
export interface PromptBudgetResult {
  /** Truncated + trimmed candidates, in score-desc order. */
  kept: AdaptiveCandidateWithText[];
  /** Total characters after truncation (sum of kept `text` lengths). */
  totalChars: number;
  /** Per-memory char caps actually applied. */
  perMemoryCap: number;
  /** Number of candidates dropped because they did not fit. */
  droppedCount: number;
  /** Number of candidates whose text was truncated. */
  truncatedCount: number;
}

/**
 * Apply prompt-budget protection to a score-sorted candidate list.
 *
 * Steps:
 *   1. Truncate each candidate's `text` to at most
 *      `perMemoryCharCap` characters, appending a `[truncated]`
 *      marker so the model can see it was cut. Skip truncation
 *      when the candidate is already short enough.
 *   2. Walk the truncated list in score order, accumulating
 *      total chars. When the next candidate would exceed
 *      `totalCharBudget`, drop it (and any further candidates,
 *      because the list is score-sorted). Stop once we hit the
 *      budget.
 *
 * The function is pure and deterministic. Inputs are not
 * mutated; output objects are fresh.
 */
export function applyPromptBudget(
  candidates: ReadonlyArray<AdaptiveCandidateWithText>,
  config: AdaptivePromptBudgetConfig = {}
): PromptBudgetResult {
  const cfg = resolveAdaptivePromptBudgetConfig(config);
  if (candidates.length === 0) {
    return {
      kept: [],
      totalChars: 0,
      perMemoryCap: cfg.perMemoryCharCap,
      droppedCount: 0,
      truncatedCount: 0,
    };
  }

  // Step 1: truncate each candidate's text in place (a copy).
  const truncated: AdaptiveCandidateWithText[] = [];
  let truncatedCount = 0;
  for (const c of candidates) {
    const text = typeof c.text === "string" ? c.text : "";
    if (text.length > cfg.perMemoryCharCap) {
      const head = text.slice(0, cfg.perMemoryCharCap);
      truncated.push({ ...c, text: `${head}... [truncated]` });
      truncatedCount += 1;
    } else {
      truncated.push({ ...c });
    }
  }

  // Step 2: accumulate until we hit the total budget.
  // The list is score-sorted (desc). When `dropLowestWhenOverBudget`
  // is true (the default), we walk the list in score order and
  // drop candidates that no longer fit once the budget is
  // exceeded. This preserves the highest-scoring memories and
  // drops the lowest-scoring ones — the desired recall behavior.
  //
  // When `dropLowestWhenOverBudget` is false (rare, only used by
  // tests that want the inverse), we walk the list BACKWARDS and
  // keep the LAST candidates that fit, then reverse back to
  // score-desc order. This is the "drop highest" path; it exists
  // for completeness and is not used by the controller.
  const kept: AdaptiveCandidateWithText[] = [];
  let totalChars = 0;
  let droppedCount = 0;

  if (cfg.dropLowestWhenOverBudget) {
    for (const c of truncated) {
      const len = c.text.length;
      if (totalChars + len > cfg.totalCharBudget) {
        droppedCount += 1;
        continue;
      }
      kept.push(c);
      totalChars += len;
    }
  } else {
    // Backward: keep the LAST (lowest-scoring) candidates that
    // fit, then reverse back to score-desc order.
    const reversed = [...truncated].reverse();
    const keptRev: AdaptiveCandidateWithText[] = [];
    let acc = 0;
    let dropped = 0;
    for (const c of reversed) {
      const len = c.text.length;
      if (acc + len > cfg.totalCharBudget) {
        dropped += 1;
        continue;
      }
      keptRev.push(c);
      acc += len;
    }
    kept.push(...keptRev.reverse());
    totalChars = acc;
    droppedCount = dropped;
  }

  return {
    kept,
    totalChars,
    perMemoryCap: cfg.perMemoryCharCap,
    droppedCount,
    truncatedCount,
  };
}

// ---------------------------------------------------------------------------
// End-to-end adapter: combine selector + diversity + budget
// ---------------------------------------------------------------------------

/**
 * End-to-end configuration for the adaptive-depth stage.
 * Combines selector + diversity + budget into a single config
 * block that the controller passes once.
 */
export interface AdaptiveDepthPipelineConfig {
  selector?: AdaptiveDepthConfig;
  diversity?: AdaptiveDiversityConfig;
  budget?: AdaptivePromptBudgetConfig;
}

/**
 * End-to-end trace summary returned by `runAdaptiveDepth`.
 */
export interface AdaptiveDepthPipelineTrace {
  selector: AdaptiveSelectionTrace;
  diversity: {
    enabled: boolean;
    redundancyThreshold: number;
    keptAfterFilter: number;
    droppedByFilter: number;
  };
  budget: {
    totalChars: number;
    perMemoryCap: number;
    droppedCount: number;
    truncatedCount: number;
  };
}

/**
 * End-to-end result.
 */
export interface AdaptiveDepthPipelineResult {
  /** Final candidates in score-desc order. */
  selected: AdaptiveCandidateWithText[];
  /** Pipeline trace for tests / observability. */
  trace: AdaptiveDepthPipelineTrace;
}

/**
 * Run the full adaptive-depth stage: selector → diversity → budget.
 *
 * The function is pure: same inputs → same output. It does not
 * mutate the input arrays.
 *
 * The selector returns a list of `AdaptiveCandidate` (no text);
 * the diversity filter requires text, so we project the text-
 * enriched input down to ids at the selector stage, then reattach
 * the text for the diversity + budget stages. This keeps the
 * selector decoupled from text content (which the selector never
 * needs to score).
 */
export function runAdaptiveDepth(
  ranked: ReadonlyArray<AdaptiveCandidateWithText>,
  config: AdaptiveDepthPipelineConfig = {}
): AdaptiveDepthPipelineResult {
  const scoreOnly: AdaptiveCandidate[] = ranked.map((c) => ({
    id: c.id,
    score: c.score,
  }));
  const selection = selectAdaptiveCandidates(scoreOnly, config.selector);

  // Map the selected ids back to the text-enriched input,
  // preserving score order.
  const selectedSet = new Set(selection.selected.map((s) => s.id));
  const selectedTextEnriched: AdaptiveCandidateWithText[] = [];
  for (const c of ranked) {
    if (selectedSet.has(c.id)) {
      selectedTextEnriched.push(c);
    }
  }

  const diversityResult = applyDiversityFilter(selectedTextEnriched, config.diversity);

  const budget = applyPromptBudget(diversityResult, config.budget);

  return {
    selected: budget.kept,
    trace: {
      selector: selection.trace,
      diversity: {
        enabled: resolveAdaptiveDiversityConfig(config.diversity).enabled,
        redundancyThreshold: resolveAdaptiveDiversityConfig(config.diversity).redundancyThreshold,
        keptAfterFilter: diversityResult.length,
        droppedByFilter: selectedTextEnriched.length - diversityResult.length,
      },
      budget: {
        totalChars: budget.totalChars,
        perMemoryCap: budget.perMemoryCap,
        droppedCount: budget.droppedCount,
        truncatedCount: budget.truncatedCount,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Internal evaluation helper: side-by-side strategy comparison
// ---------------------------------------------------------------------------

/**
 * Side-by-side comparison of the two adaptive-depth strategies
 * on the same input. This is an internal evaluation helper used
 * by tests and (optionally) the prototype / benchmark harnesses.
 * It is NOT a production code path; the recall controller picks
 * ONE strategy and uses it.
 *
 * The two strategies are evaluated with the same `selector`
 * config (apart from `strategy`). The returned `narrow` and
 * `broad` selections are independent — they are not merged.
 *
 * Output shape:
 *   - `narrow`:  AdaptiveSelection from `strategy: "elbow"`.
 *   - `broad`:   AdaptiveSelection from `strategy: "plateau"`.
 *
 * Use case: when developing a new selector, run this helper on
 * a synthetic corpus and confirm that the chosen strategy
 * produces the expected selection for both narrow and broad
 * inputs. The helper has no side effects and never persists
 * anything.
 */
export interface AdaptiveStrategyComparison {
  narrow: AdaptiveSelection;
  broad: AdaptiveSelection;
}

/**
 * Run the two strategies against the same input and return
 * their selections side by side. Deterministic; pure.
 */
export function compareAdaptiveStrategies(
  ranked: ReadonlyArray<AdaptiveCandidate>,
  config: AdaptiveDepthConfig = {}
): AdaptiveStrategyComparison {
  const elbow = selectAdaptiveCandidates(ranked, { ...config, strategy: "elbow" });
  const plateau = selectAdaptiveCandidates(ranked, { ...config, strategy: "plateau" });
  // Field names in the comparison record are stable: `narrow`
  // corresponds to the elbow strategy (the controller's
  // default), `broad` corresponds to the plateau strategy.
  // The names are historical; the helper does not analyse the
  // input shape to label them.
  return { narrow: elbow, broad: plateau };
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return Math.floor(lo);
  const v = Math.floor(value);
  if (v < lo) return Math.floor(lo);
  if (v > hi) return Math.floor(hi);
  return v;
}

function clampNum(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
