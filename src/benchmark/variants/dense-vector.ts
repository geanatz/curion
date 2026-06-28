/**
 * Benchmark-only dense-vector retrieval variant.
 *
 * Why this exists:
 *   The Architect's brief asks the next benchmark phase to
 *   test a real local semantic embedding backend behind the
 *   existing `VectorEmbedder` seam, preserve the hashed
 *   bag-of-words as a control, and add artifact metadata
 *   documenting what was actually executed. This module
 *   builds on the existing `vector.ts` shape: same
 *   `{id, score}[]` top-K contract, same
 *   `LexicalRankingOptions` extension point, same cosine
 *   similarity, but the embedder is the pluggable
 *   `DenseEmbedder` from `./dense-embedder.ts` and the
 *   ranker is async (the real ONNX forward pass is async).
 *
 * Scope (benchmark-only):
 *   - Mirrors `rankVector` exactly except for the async
 *     `embedBatch` path. The shape contract is unchanged:
 *     score desc, id asc tie-break, threshold respected,
 *     top-K cap respected.
 *   - Async entry point: `rankDenseVectorAsync` is the
 *     canonical function.
 *   - Surfaces the embedder's `metadata` on the return
 *     value so the benchmark runner can copy it into the
 *     report's `config.embeddingBackend` block.
 *
 * What this is NOT:
 *   - It is NOT wired into `recall(text)`. The production
 *     controller still uses `rankLexical` and the public
 *     MCP surface is unchanged.
 *   - It is NOT a vector DB. The whole index is a small
 *     in-memory `{ id -> vector }` map tied to the lifetime
 *     of a single benchmark run.
 *   - It is NOT a replacement for the hashed-BoW control.
 *     The control stays in `vector.ts`; this module is the
 *     dense path. The benchmark runner runs both
 *     side-by-side and the comparison report shows the
 *     delta.
 *
 * Determinism:
 *   - The stub embedder is deterministic across machines.
 *   - The transformers.js embedder is deterministic for a
 *     given model + input + runtime. ONNX Runtime is
 *     bit-deterministic for a fixed thread count.
 *   - Ties on cosine score are broken by descending id (newer
 *     memory wins), matching the lexical / FTS5 / hashed-vector
 *     stability contract.
 *
 * Score scale:
 *   Cosine similarity in [-1, 1]. The transformers.js
 *   model and the stub both L2-normalize, so for
 *   non-negative inputs the score is in [0, 1]. "Higher is
 *   better" matches the existing variant conventions.
 *
 * No-answer TNR:
 *   The default threshold is 0 (no filter), the same default
 *   the FTS5 and hashed-vector variants use. Cosine
 *   similarity of a unit vector to a random unrelated unit
 *   vector is near 0; the default threshold of 0 keeps the
 *   no-answer TNR meaningful. Callers can pass a positive
 *   threshold for stricter abstention.
 */

import { tokenize } from "../../retrieval/lexical.js";
import type {
  LexicalCandidate,
  LexicalRankingOptions,
  LexicalScoredCandidate,
} from "../../retrieval/lexical.js";
import {
  type DenseEmbedder,
  type EmbedderMetadata,
  StubDeterministicDenseEmbedder,
} from "./dense-embedder.js";
import { cosineSimilarity } from "./vector.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the dense-vector ranker. Mirrors
 * `VectorRankingOptions` and adds an explicit `embedder`
 * field. The default is the stub embedder so the benchmark
 * runs out of the box without a model download.
 */
export interface DenseVectorRankingOptions extends LexicalRankingOptions {
  /**
   * Minimum cosine score to keep a candidate. The default
   * is `0` (no filter) for the same reason
   * `DEFAULT_VECTOR_THRESHOLD` is 0: cosine similarity on
   * a real dense embedder is naturally low for a no-match
   * query, and the ranker respects the natural separation
   * between match and no-match.
   */
  threshold?: number;
  /**
   * The dense embedder to use. The default is the
   * `StubDeterministicDenseEmbedder`; a real local
   * transformers.js embedder is opt-in via the runner's
   * `--embedder transformersjs` flag; a real local Qwen3
   * embedder is opt-in via the runner's `--embedder qwen3`
   * flag.
   */
  embedder?: DenseEmbedder;
  /**
   * Embedding kind. The Qwen3 embedder distinguishes
   * queries (which receive the
   * `Instruct: <task>\nQuery:<query>` prefix) from
   * documents (which are forwarded verbatim). The dense
   * vector ranker is invoked from two call sites:
   *
   *   - The `vector-dense` benchmark variant. The query
   *     kind is `"query"` (the user query string is
   *     instruction-prefixed) and the candidate texts are
   *     `"document"` (verbatim).
   *   - The `hybrid-dense` benchmark variant. Same
   *     contract: the user query is `"query"`, the
   *     candidate texts are `"document"`.
   *
   * The default is `"document"` so a caller that does not
   * care about the distinction (e.g. a stub / MiniLM
   * embedder that ignores the kind) still works without
   * any option plumbing. Backends that do not implement
   * `embedQuery` (the stub, the legacy
   * `TransformersJsEmbedder`) fall through to the
   * standard `embed` / `embedBatch` path which is
   * kind-agnostic.
   */
  kind?: "query" | "document";
}

/**
 * Default threshold for the dense-vector variant. Mirrors
 * the existing `DEFAULT_VECTOR_THRESHOLD` (`0`): cosine
 * similarity of a non-negative L2-normalized vector is in
 * `[0, 1]`, so the default threshold passes every candidate
 * with a non-zero overlap. This is documented as an honest
 * default; callers that want stricter no-answer TNR can
 * pass a positive threshold.
 */
export const DEFAULT_DENSE_VECTOR_THRESHOLD = 0;

/**
 * Default top-K for the dense-vector variant. Mirrors the
 * lexical, FTS5, and hashed-vector defaults (5).
 */
export const DEFAULT_DENSE_VECTOR_TOP_K = 5;

/**
 * The result of a dense-vector benchmark rank. Same shape
 * as `LexicalScoredCandidate[]` plus an `embeddingBackend`
 * block so the runner can surface the embedder metadata on
 * the report.
 */
export interface DenseVectorRankResult {
  hits: LexicalScoredCandidate[];
  /** Embedder metadata captured at rank time. */
  embeddingBackend: EmbedderMetadata;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank candidates by cosine similarity against the query
 * using a real (or stub) dense embedder.
 *
 * The function is the dense counterpart of
 * `rankVector`. The shape contract is the same:
 * `{id, score}[]`, score desc, id desc tie-break, top-K
 * cap. The only difference is the embedder is async, so
 * the function is async.
 *
 * Determinism: the function is deterministic for a given
 * (query, corpus, embedder, threshold, top-K). The stub
 * embedder is fully deterministic; the transformers.js
 * embedder is deterministic for a fixed model + ONNX
 * runtime.
 */
export async function rankDenseVectorAsync(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: DenseVectorRankingOptions = {}
): Promise<LexicalScoredCandidate[]> {
  const { hits } = await rankDenseVectorWithMetadataAsync(query, candidates, options);
  return hits;
}

/**
 * Same as `rankDenseVectorAsync` but also returns the
 * embedder metadata so the benchmark runner can surface
 * it on the report. The runner always uses this entry
 * point.
 */
export async function rankDenseVectorWithMetadataAsync(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: DenseVectorRankingOptions = {}
): Promise<DenseVectorRankResult> {
  const threshold = options.threshold ?? DEFAULT_DENSE_VECTOR_THRESHOLD;
  const topK = options.topK ?? DEFAULT_DENSE_VECTOR_TOP_K;
  const safeQuery = typeof query === "string" ? query : "";

  // Short-circuit on a zero-token query. Mirrors the
  // existing `rankVector` guard: a query that tokenizes to
  // nothing must return an empty top-K so the no-answer
  // path stays meaningful.
  if (tokenize(safeQuery).length === 0) {
    return {
      hits: [],
      embeddingBackend: options.embedder?.metadata ?? defaultStubMetadata(),
    };
  }

  // Build candidate texts (summary + tags) once. The
  // lexical baseline uses the same construction; staying
  // consistent keeps the four variants comparable in what
  // they consider the "match text".
  const candidateTexts = candidates.map((c) => {
    const text = typeof c.text === "string" ? c.text : "";
    const tagPart = Array.isArray(c.tags) && c.tags.length > 0 ? ` ${c.tags.join(" ")}` : "";
    return `${text}${tagPart}`;
  });

  const embedder = options.embedder ?? defaultStubEmbedder();
  // The DenseEmbedder interface is async for both the
  // stub and the transformers.js backend. The hot path
  // dispatches a single batched call so the stub pays
  // one microtask and the transformers.js backend pays
  // one ONNX forward pass.
  //
  // The Qwen3 embedder has an explicit
  // `embedQuery` / `embedDocument` pair (the
  // `Instruct: <task>\nQuery:<query>` prefix is
  // query-only). When the embedder exposes
  // `embedQuery`, we dispatch the query through it
  // and the candidates through `embedBatch` (which
  // the Qwen3 embedder maps to
  // `embedDocumentsBatch`). When the embedder does
  // NOT expose `embedQuery` (the stub, the legacy
  // `TransformersJsEmbedder`), the call falls through
  // to the standard `embedBatch` path, which is
  // kind-agnostic. The `kind` field is therefore
  // additive: a kind-aware embedder honors it; a
  // kind-agnostic embedder ignores it without
  // breaking.
  const isQuery = options.kind === "query";
  const hasEmbedQuery = isQwen3LikeEmbedder(embedder);
  const queryPromise =
    isQuery && hasEmbedQuery
      ? (
          embedder as unknown as {
            embedQuery: (t: string) => Promise<number[]>;
          }
        )
          .embedQuery(safeQuery)
          .then((v) => [v])
      : embedder.embedBatch([safeQuery]);
  const [candidateVectors, queryVectorList] = await Promise.all([
    embedder.embedBatch(candidateTexts),
    queryPromise,
  ]);
  const queryVector = queryVectorList[0] ?? [];

  const scored: LexicalScoredCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const v = candidateVectors[i];
    if (!v) continue;
    const score = cosineSimilarity(queryVector, v);
    if (score >= threshold) {
      scored.push({ id: c.id, score });
    }
  }
  // Stable order: score desc, then id desc. Mirrors the
  // lexical and FTS5 ranker tie-break (newer memory wins).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });
  return {
    hits: scored.slice(0, topK),
    embeddingBackend: embedder.metadata,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default stub embedder. Lazily constructed so the
 * `dense-embedder.ts` module is loaded only when the
 * runner actually embeds something. The cache is keyed
 * by the dim to keep tests that override the dim
 * isolated.
 */
let defaultStubCache: DenseEmbedder | null = null;
function defaultStubEmbedder(): DenseEmbedder {
  if (!defaultStubCache) {
    defaultStubCache = new StubDeterministicDenseEmbedder();
  }
  return defaultStubCache;
}

function defaultStubMetadata(): EmbedderMetadata {
  return defaultStubEmbedder().metadata;
}

/**
 * Type guard for an embedder that supports the
 * query-vs-document distinction (the
 * `Instruct: <task>\nQuery:<query>` prefix on the
 * query side). The Qwen3 embedder implements this
 * method; the stub and the legacy
 * `TransformersJsEmbedder` do not. The function
 * returns `true` when the embedder exposes an
 * `embedQuery(text)` method that returns a single
 * vector; the caller can then route the query
 * through that method.
 *
 * The function is intentionally a narrow runtime
 * check (a duck-typed method existence) so the
 * `DenseEmbedder` interface stays minimal and the
 * Qwen3-specific behavior is a strict superset
 * detected at the ranker call site. A future
 * embedder that wants the same kind-aware
 * behavior can simply implement `embedQuery` and
 * the ranker will pick it up.
 */
function isQwen3LikeEmbedder(embedder: DenseEmbedder): boolean {
  const candidate = embedder as unknown as {
    embedQuery?: unknown;
  };
  return typeof candidate.embedQuery === "function";
}
