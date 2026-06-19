/**
 * Related-memory lookup seam.
 *
 * This module is the small, stable boundary the controller uses to
 * enrich the `remember` provider prompt with a "related memories"
 * block. The contract is:
 *
 *   - The seam exposes `findRelatedMemories(storage, query) -> {
 *     memories: RelatedMemory[]; reason: string }`. The controller
 *     depends only on this surface and never on the retrieval
 *     implementation.
 *   - The default implementation is a lexical top-K lookup over the
 *     active memory summaries stored in the project database. It
 *     uses `listActiveMemorySummaries` for the read and
 *     `rankLexical` for the score / cap. It returns at most
 *     `topK` rows (default `5`) projected to the controller-visible
 *     `RelatedMemory` shape `{ id, memoryContent, kind? }`.
 *   - The default `topK` is `5` (matches `DEFAULT_TOP_K` from
 *     `src/retrieval/lexical.ts`). The seam clamps any caller-
 *     provided `topK` to a sane positive range so a malformed value
 *     can never bypass the bound.
 *   - Active memories only — the read side already filters on
 *     `state = 'active'`. No FTS, no vector, no hybrid retrieval
 *     is performed here. The V1 slice is context-only /
 *     prompt-only: related memories influence the provider prompt
 *     but no auto-merge / skip / supersede / state transition is
 *     introduced.
 *   - The seam never persists anything. It is read-only.
 *
 * Tests can override the impl via `setRelatedMemoriesImpl` to
 * drive the controller with a scripted candidate set without
 * changing the seam's public surface.
 */

import {
  listActiveMemorySummaries,
  type SafeMemorySummary,
  type StorageHandle,
} from "../storage/storage.js";
import { rankLexical, DEFAULT_TOP_K } from "./lexical.js";
import type { RelatedMemory } from "../providers/memory-analysis.js";

/** Hard cap on `topK` for the default implementation. */
export const RELATED_MEMORIES_MAX_TOP_K = 16;

export interface RelatedMemoryQuery {
  /** The user text the controller is about to analyze. */
  text: string;
  /**
   * Optional cap. Default `5`. The seam clamps any value to the
   * range `[1, RELATED_MEMORIES_MAX_TOP_K]` so a malformed
   * caller cannot bypass the bound.
   */
  topK?: number;
}

/**
 * Implementation shape for `findRelatedMemories`. Production code
 * uses the default lexical implementation; tests can override the
 * impl via `setRelatedMemoriesImpl` to drive the controller with a
 * scripted candidate set without changing the public seam
 * surface.
 */
export type RelatedMemoriesImpl = (
  storage: StorageHandle,
  query: RelatedMemoryQuery,
) => { memories: RelatedMemory[]; reason: string };

let relatedMemoriesImpl: RelatedMemoriesImpl = defaultRelatedMemoriesImpl;

/**
 * Find related memories for the given query text.
 *
 * Returns:
 *   - `memories`: up to `topK` (default 5) `RelatedMemory` rows
 *     sorted by lexical relevance (score desc, id asc on ties),
 *     each carrying `{ id, memoryContent, kind? }`. The id is
 *     the `memories.id` from the storage row and is preserved on
 *     the returned object for controller-side relationship
 *     derivation; the provider prompt rendering strips the id.
 *   - `reason`: short, stable string describing why the result
 *     looks the way it does. Used for logging and tests; the
 *     controller does not branch on it.
 *
 * No state transition, no schema migration, no raw text column
 * is touched.
 */
export function findRelatedMemories(
  storage: StorageHandle,
  query: RelatedMemoryQuery,
): { memories: RelatedMemory[]; reason: string } {
  return relatedMemoriesImpl(storage, query);
}

/**
 * Default implementation: lexical top-K over the active memory
 * summaries.
 *
 * Steps:
 *   1. Read the active memory summaries from storage (the same
 *      projection the recall controller uses; safe fields only,
 *      `state = 'active'` filter is already applied).
 *   2. If the store is empty, return `{ memories: [], reason:
 *      "no stored active memories" }` without invoking the
 *      ranker (a ranker on an empty set would still be a no-op,
 *      but skipping it keeps the reason crisp).
 *   3. Otherwise, run `rankLexical` over the candidate summaries
 *      with the bounded `topK`. The ranker already enforces its
 *      own `DEFAULT_RELEVANCE_THRESHOLD` and
 *      `MIN_OVERLAP_TOKENS` floor, so a clearly unrelated store
 *      (e.g. "we use Postgres" vs "deploy via Kubernetes") will
 *      return an empty list rather than a false positive.
 *   4. Project the ranked ids back to the original
 *      `SafeMemorySummary` rows and shape them as
 *      `RelatedMemory` (id + memoryContent + kind). The id is
 *      preserved on the object so the controller's
 *      `toSafeMemorySummary` and the relationship detector can
 *      use it; the provider prompt rendering drops the id.
 */
function defaultRelatedMemoriesImpl(
  storage: StorageHandle,
  query: RelatedMemoryQuery,
): { memories: RelatedMemory[]; reason: string } {
  const topK = clampTopK(query.topK);
  const summaries = listActiveMemorySummaries(storage);
  if (summaries.length === 0) {
    return { memories: [], reason: "no stored active memories" };
  }
  const ranked = rankLexical(
    query.text,
    summaries.map((s: SafeMemorySummary) => ({
      id: s.id,
      text: s.memoryContent,
      tags: s.tags,
    })),
    { topK },
  );
  if (ranked.length === 0) {
    return { memories: [], reason: "no related memories" };
  }
  // Project ranked ids back to the original summaries, preserving
  // the ranker's score-sorted order. The id-keyed lookup is O(1)
  // per row and keeps the function linear in the candidate set.
  const byId = new Map<number, SafeMemorySummary>();
  for (const s of summaries) byId.set(s.id, s);
  const memories: RelatedMemory[] = [];
  for (const r of ranked) {
    const s = byId.get(r.id);
    if (!s) continue;
    memories.push({
      id: s.id,
      memoryContent: s.memoryContent,
      kind: s.kind,
    });
  }
  return { memories, reason: "lexical top-K" };
}

/**
 * Clamp a caller-provided `topK` to the safe range
 * `[1, RELATED_MEMORIES_MAX_TOP_K]`. Falls back to
 * `DEFAULT_TOP_K` (5) when the value is missing or not a
 * positive finite integer. The cap is intentionally small: this
 * is V1 context-only / prompt-only, and the provider prompt
 * has a token budget that does not tolerate an unbounded list.
 */
function clampTopK(topK: unknown): number {
  if (typeof topK !== "number" || !Number.isFinite(topK)) {
    return DEFAULT_TOP_K;
  }
  if (!Number.isInteger(topK) || topK < 1) {
    return DEFAULT_TOP_K;
  }
  if (topK > RELATED_MEMORIES_MAX_TOP_K) {
    return RELATED_MEMORIES_MAX_TOP_K;
  }
  return topK;
}

/**
 * Test-only override for the `findRelatedMemories` seam. The
 * default lexical implementation reads the active memory store
 * and ranks it. Tests can install a scripted implementation that
 * returns a synthetic candidate set so the controller's write-
 * side relationship wiring is exercised end-to-end without
 * changing the seam's public signature.
 *
 * Production code MUST NOT call this. It is intentionally not
 * imported by the controller and is not part of the public
 * seam surface.
 */
export function setRelatedMemoriesImpl(impl: RelatedMemoriesImpl | null): void {
  relatedMemoriesImpl = impl ?? defaultRelatedMemoriesImpl;
}

/** Test-only reset to the default lexical implementation. */
export function resetRelatedMemoriesImpl(): void {
  relatedMemoriesImpl = defaultRelatedMemoriesImpl;
}
