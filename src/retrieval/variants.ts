/**
 * Retrieval benchmark variant registry (skeleton).
 *
 * Each variant is a placeholder that will be filled in during later
 * experiments. The shape is stable so the harness can be wired up
 * before implementations exist.
 *
 * Variants:
 *   - fts5                     — SQLite FTS5 lexical baseline
 *   - vector                   — embedding-only retrieval
 *   - hybrid-rrf               — hybrid with Reciprocal Rank Fusion
 *   - hybrid-rerank            — hybrid + cross-encoder rerank
 *   - hybrid-entity-temporal   — hybrid + entity/temporal reweighting
 */

import type { StorageHandle } from "../storage/storage.js";

export type VariantId =
  | "fts5"
  | "vector"
  | "hybrid-rrf"
  | "hybrid-rerank"
  | "hybrid-entity-temporal";

export interface VariantQuery {
  /** The user's text query. */
  text: string;
  /** Optional cap on the number of results. */
  topK?: number;
}

export interface VariantHit {
  /** Memory id (matches `memories.id`). 0 means "no real hit". */
  memoryId: number;
  /** Optional score, variant-defined. */
  score?: number;
  /** Human-readable explanation of why this hit was returned. */
  reason: string;
}

export interface VariantResult {
  variant: VariantId;
  hits: VariantHit[];
  /** Total milliseconds the variant took. */
  elapsedMs: number;
}

export interface RetrievalVariant {
  readonly id: VariantId;
  /** Short human description. */
  readonly description: string;
  /** Run the variant. Skeletons return an empty result with a reason. */
  run(storage: StorageHandle, query: VariantQuery): Promise<VariantResult>;
}

/** All registered variants in stable order. */
export function allVariants(): RetrievalVariant[] {
  return [
    placeholder("fts5", "SQLite FTS5 lexical baseline"),
    placeholder("vector", "embedding-only retrieval"),
    placeholder("hybrid-rrf", "hybrid with Reciprocal Rank Fusion"),
    placeholder("hybrid-rerank", "hybrid + cross-encoder rerank"),
    placeholder(
      "hybrid-entity-temporal",
      "hybrid + entity/temporal reweighting",
    ),
  ];
}

function placeholder(id: VariantId, description: string): RetrievalVariant {
  return {
    id,
    description,
    async run(_storage, _query): Promise<VariantResult> {
      const start = Date.now();
      return {
        variant: id,
        hits: [],
        elapsedMs: Date.now() - start,
      };
    },
  };
}

/**
 * Run every registered variant against the same query. Useful for the
 * benchmark harness: it produces a side-by-side table of timings and
 * hit counts without committing to an implementation.
 */
export async function runAllVariants(
  storage: StorageHandle,
  query: VariantQuery,
): Promise<VariantResult[]> {
  const results: VariantResult[] = [];
  for (const v of allVariants()) {
    results.push(await v.run(storage, query));
  }
  return results;
}
