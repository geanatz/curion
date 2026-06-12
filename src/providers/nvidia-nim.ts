/**
 * NVIDIA NIM provider (skeleton, fallback).
 *
 * Reads `CORTEX_PROVIDER_FALLBACK_KEY` (or `NVIDIA_NIM_API_KEY`) from
 * the environment. When unset, behaves like a stub. No network call
 * is made in Phase 1.
 *
 * No API keys are hardcoded in this file.
 */

import type { EmbeddingResult, Provider } from "./types.js";

const PROVIDER_NAME = "nvidia-nim" as const;

export class NvidiaNimProvider implements Provider {
  readonly name = PROVIDER_NAME;

  isConfigured(): boolean {
    return Boolean(process.env.CORTEX_PROVIDER_FALLBACK_KEY ?? process.env.NVIDIA_NIM_API_KEY);
  }

  async embed(text: string): Promise<EmbeddingResult> {
    if (!this.isConfigured()) {
      return {
        provider: PROVIDER_NAME,
        dim: 0,
        vector: [],
        note: "nvidia-nim: no api key configured (set CORTEX_PROVIDER_FALLBACK_KEY)",
      };
    }
    return {
      provider: PROVIDER_NAME,
      dim: 0,
      vector: [],
      note: "nvidia-nim: skeleton — real call not implemented in Phase 1",
    };
  }
}
