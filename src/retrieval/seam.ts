/**
 * Related-memory lookup seam.
 *
 * This is the MVP placeholder for the retrieval step the controller
 * uses to enrich the provider prompt with a small "related memories"
 * block. The MVP contract is:
 *
 *   - The seam has a stable interface (`findRelatedMemories`) that
 *     the controller can call without knowing which retrieval
 *     variant will eventually be plugged in.
 *   - The MVP implementation returns an empty list, with a short
 *     reason. No FTS, no vector, no hybrid retrieval yet.
 *   - Real variants (FTS5, vector, hybrid-rrf) will be added in a
 *     later phase. When they are added, the seam will be the only
 *     place the controller has to change.
 *
 * The seam is intentionally narrow: it accepts a `StorageHandle` and
 * a `RelatedMemoryQuery`, and returns a list of `RelatedMemory`
 * objects whose `summary` is the controller-normalized summary
 * (never raw input).
 */

import type { StorageHandle } from "../storage/storage.js";
import type { RelatedMemory } from "../providers/memory-analysis.js";

export interface RelatedMemoryQuery {
  /** The user text the controller is about to analyze. */
  text: string;
  /** Optional cap. Default 5. */
  topK?: number;
}

/**
 * Find related memories for the given query text.
 *
 * MVP behavior: returns `{ memories: [], reason: "no related memories
 * in MVP slice" }`. No FTS, no vector retrieval. The shape is stable
 * so the controller can be wired against the real implementation in
 * a later phase without any controller changes.
 */
export function findRelatedMemories(
  _storage: StorageHandle,
  _query: RelatedMemoryQuery,
): { memories: RelatedMemory[]; reason: string } {
  return { memories: [], reason: "no related memories in MVP slice" };
}
