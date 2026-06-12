/**
 * MiniMax provider (skeleton).
 *
 * Reads `CORTEX_PROVIDER_PRIMARY_KEY` (or `MINIMAX_API_KEY`) from the
 * environment. When unset, `isConfigured()` returns false and `embed()`
 * returns a stub result with `provider: "minimax"` and a `note` field
 * explaining the missing key. No network call is made.
 *
 * No API keys are hardcoded in this file.
 */

import type { EmbeddingResult, Provider } from "./types.js";

const PROVIDER_NAME = "minimax" as const;

export class MiniMaxProvider implements Provider {
  readonly name = PROVIDER_NAME;

  isConfigured(): boolean {
    return Boolean(process.env.CORTEX_PROVIDER_PRIMARY_KEY ?? process.env.MINIMAX_API_KEY);
  }

  async embed(text: string): Promise<EmbeddingResult> {
    if (!this.isConfigured()) {
      return {
        provider: PROVIDER_NAME,
        dim: 0,
        vector: [],
        note: "minimax: no api key configured (set CORTEX_PROVIDER_PRIMARY_KEY)",
      };
    }
    // Real HTTP call deferred to a later phase. Skeleton returns a
    // descriptive stub so callers and tests can observe the path.
    return {
      provider: PROVIDER_NAME,
      dim: 0,
      vector: [],
      note: "minimax: skeleton — real call not implemented in Phase 1",
    };
  }
}
