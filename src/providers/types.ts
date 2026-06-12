/**
 * Provider prototype harness.
 *
 * Two providers are wired in skeleton form:
 *   1. MiniMax      — primary
 *   2. NVIDIA NIM   — fallback
 *
 * No real API keys are read from or stored in the repo. Keys come from
 * environment variables; the skeleton can be run end-to-end without
 * keys (it returns a "no key configured" result).
 *
 * The interface is intentionally narrow for Phase 1: embed(text) only.
 * Generation can be added later behind the same interface.
 */

export interface EmbeddingResult {
  /** Provider that produced the result. */
  provider: "minimax" | "nvidia-nim" | "stub";
  /** Dimensionality of the vector. */
  dim: number;
  /** Embedding vector. For Phase 1 skeleton, this may be empty. */
  vector: number[];
  /** Latency in milliseconds, if measured. */
  latencyMs?: number;
  /** Free-form note (e.g. "no api key configured"). */
  note?: string;
}

export interface Provider {
  readonly name: "minimax" | "nvidia-nim" | "stub";
  /** True if the provider has the configuration needed to make a real call. */
  isConfigured(): boolean;
  /** Embed a single text. Implementations must never throw on missing config. */
  embed(text: string): Promise<EmbeddingResult>;
}
