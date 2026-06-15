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
 * Implementation shape for `findRelatedMemories`. Production code
 * uses the default placeholder; tests can override the impl via
 * `setRelatedMemoriesImpl` to drive the controller with a
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
 * MVP behavior: returns `{ memories: [], reason: "no related memories
 * in MVP slice" }`. No FTS, no vector retrieval. The shape is stable
 * so the controller can be wired against the real implementation in
 * a later phase without any controller changes.
 */
export function findRelatedMemories(
  storage: StorageHandle,
  query: RelatedMemoryQuery,
): { memories: RelatedMemory[]; reason: string } {
  return relatedMemoriesImpl(storage, query);
}

function defaultRelatedMemoriesImpl(
  _storage: StorageHandle,
  _query: RelatedMemoryQuery,
): { memories: RelatedMemory[]; reason: string } {
  return { memories: [], reason: "no related memories in MVP slice" };
}

/**
 * Test-only override for the `findRelatedMemories` seam. The
 * default placeholder returns an empty list. Tests can install
 * a scripted implementation that returns a synthetic candidate
 * set so the controller's write-side relationship wiring is
 * exercised end-to-end without changing the seam's public
 * signature.
 *
 * Production code MUST NOT call this. It is intentionally
 * untyped as a `Symbol.for`-style import surface and the
 * controller does not depend on it.
 */
export function setRelatedMemoriesImpl(impl: RelatedMemoriesImpl | null): void {
  relatedMemoriesImpl = impl ?? defaultRelatedMemoriesImpl;
}

/** Test-only reset to the default placeholder implementation. */
export function resetRelatedMemoriesImpl(): void {
  relatedMemoriesImpl = defaultRelatedMemoriesImpl;
}
