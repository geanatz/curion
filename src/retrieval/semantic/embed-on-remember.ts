/**
 * Embed-on-remember utility.
 *
 * After a memory is successfully remembered and its sanitized summary
 * is stored, this utility attempts to generate and persist a semantic
 * embedding for the summary. Failures are non-fatal — the function
 * returns without throwing so lexical recall remains available.
 *
 * Usage:
 *   const embedder = await createSemanticEmbedder({ enabled: semanticEnabled, ... });
 *   const result = await embedOnRemember(storage, embedder, memoryId, summary);
 *   // result.embedding stores the record; result.error is set on failure
 */

import { type StorageHandle, storeEmbedding } from "../../storage/storage.js";
import type { SemanticEmbedder } from "./embedder.js";

export interface EmbedOnRememberResult {
  /** True if an embedding was successfully stored. */
  stored: boolean;
  /** The stored embedding record, or null on failure. */
  embedding: import("../../storage/storage.js").EmbeddingRecord | null;
  /** Error message if embedding generation or storage failed. */
  error?: string;
}

/**
 * Generate and store an embedding for a remembered memory.
 *
 * This function is designed to be non-fatal: if embedding generation
 * or storage fails (model not available, I/O error, etc.), the function
 * returns `stored: false` and the caller continues normally.
 *
 * @param handle - The storage handle.
 * @param embedder - The semantic embedder (stub or real).
 * @param memoryId - The id of the memory just stored.
 * @param summary - The sanitized memory summary to embed.
 * @param modelId - Optional model id string for the embedding metadata.
 */
export async function embedOnRemember(
  handle: StorageHandle,
  embedder: SemanticEmbedder,
  memoryId: number,
  summary: string,
  modelId?: string
): Promise<EmbedOnRememberResult> {
  try {
    const vec = await embedder.embed(summary, "document");
    const record = storeEmbedding(handle, {
      memoryId,
      dim: vec.length,
      vec,
      modelId: modelId ?? embedder.metadata.modelId,
      summaryHash: hashSummary(summary),
    });
    if (record === null) {
      return { stored: false, embedding: null, error: "storage failed" };
    }
    return { stored: true, embedding: record };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stored: false, embedding: null, error: msg };
  }
}

/**
 * Bounded backfill helper: generate embeddings for memories that
 * are active but lack embeddings.
 *
 * Processes in batches of `batchSize` to avoid unbounded memory
 * usage. Returns after each batch so it can be resumed safely.
 * The `embedder` should already be initialized (call `init()` first
 * for the real embedder).
 *
 * @param handle - The storage handle.
 * @param embedder - The semantic embedder (stub or real).
 * @param options.batchSize - Memories per batch (default 20).
 * @param options.progress - Optional callback called after each batch
 *   with the count of embeddings generated in that batch.
 *
 * Returns the total count of embeddings generated, or -1 on error.
 */
export async function backfillMissingEmbeddings(
  handle: StorageHandle,
  embedder: SemanticEmbedder,
  options: {
    batchSize?: number;
    progress?: (batchCount: number, totalSoFar: number) => void;
  } = {}
): Promise<number> {
  const batchSize = options.batchSize ?? 20;

  // Fetch at most batchSize missing memories — no OFFSET pagination.
  // Each call processes one batch; repeated calls handle subsequent batches.
  const rows = handle.db
    .prepare(
      `SELECT m.id, m.summary
         FROM memories m
        WHERE m.state = 'active'
          AND m.summary IS NOT NULL AND m.summary != ''
          AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.memory_id = m.id)
        ORDER BY m.id ASC
        LIMIT ?`
    )
    .all(batchSize) as Array<{ id: number; summary: string }>;

  if (rows.length === 0) return 0;

  let totalGenerated = 0;

  for (const row of rows) {
    try {
      const vec = await embedder.embed(row.summary, "document");
      const record = storeEmbedding(handle, {
        memoryId: row.id,
        dim: vec.length,
        vec,
        modelId: embedder.metadata.modelId,
        summaryHash: hashSummary(row.summary),
      });
      if (record !== null) {
        totalGenerated++;
      }
    } catch {
      // Non-fatal: skip this row and continue.
    }
  }

  options.progress?.(rows.length, totalGenerated);

  return totalGenerated;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Simple non-cryptographic hash of a summary string for change detection.
 * Used to detect when a memory summary has been edited and the
 * embedding may need to be regenerated.
 */
function hashSummary(summary: string): string {
  let h = 0;
  const s = summary.slice(0, 1024); // Cap at 1024 chars for hashing.
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
