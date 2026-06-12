/**
 * Provider registry: primary + fallback selection.
 *
 * Tries the primary provider first; if it is unconfigured or fails,
 * falls back to the secondary. In Phase 1 the registry simply
 * delegates; the actual fallback policy can be tuned later without
 * changing call sites.
 */

import { MiniMaxProvider } from "./minimax.js";
import { NvidiaNimProvider } from "./nvidia-nim.js";
import type { EmbeddingResult, Provider } from "./types.js";

export interface ProviderRegistry {
  primary: Provider;
  fallback: Provider;
}

/** Build a default registry with MiniMax primary and NVIDIA NIM fallback. */
export function buildDefaultRegistry(): ProviderRegistry {
  return {
    primary: new MiniMaxProvider(),
    fallback: new NvidiaNimProvider(),
  };
}

/**
 * Embed with fallback. Returns the first successful result. A result is
 * considered "usable" if `vector.length > 0`. Stub results (empty vector
 * with a note) do not count as success; we fall through to the fallback.
 */
export async function embedWithFallback(
  reg: ProviderRegistry,
  text: string,
): Promise<EmbeddingResult> {
  const primary = await reg.primary.embed(text);
  if (primary.vector.length > 0) return primary;

  const fallback = await reg.fallback.embed(text);
  if (fallback.vector.length > 0) return fallback;

  // Neither produced a vector. Return the primary's stub for visibility.
  return primary;
}
