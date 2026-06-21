/**
 * Production semantic embedder module.
 *
 * Provides a stable `SemanticEmbedder` interface and two implementations:
 *
 * 1. `StubSemanticEmbedder` — a dependency-free deterministic embedder
 *    for CI and tests. Produces a 64-dim L2-normalized vector from a
 *    per-token hash + sign trick (feature hashing). The stub is NOT a
 *    serious semantic ranker; it enables paraphrase-in-vocabulary
 *    recovery in tests without downloading a model.
 *
 * 2. `BgeSmallEmbedder` — the production embedder backed by
 *    `@xenova/transformers` with the `Xenova/bge-small-en-v1.5`
 *    ONNX model. First-run downloads from Hugging Face and caches
 *    locally in `.curion/transformers-cache/`. Lazy-loads the
 *    pipeline on first embed; subsequent embeds reuse the cached
 *    session.
 *
 * Design notes:
 *   - All implementations produce L2-normalized vectors.
 *   - Query texts receive the BGE instruction prefix
 *     `"Represent this sentence for searching relevant passages: "`.
 *   - Document/summary texts are embedded verbatim.
 *   - Cosine similarity is used for scoring (dot product of
 *     normalized vectors).
 *   - Embedder failures are non-fatal: callers handle errors and
 *     fall back gracefully so recall lexically still works.
 *   - The interface is synchronous for the stub and async for the
 *     real ONNX backend. Callers use `async` uniformly.
 *
 * No external API is called. No raw user input is persisted.
 * Embeddings are generated only from sanitized stored summaries.
 */

import { fileURLToPath } from "node:url";
import { logger } from "../../logging/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Backend status for reporting.
 */
export type EmbedderStatus = "ready" | "skipped" | "error";

/**
 * Metadata about the embedder backend.
 */
export interface EmbedderMetadata {
  backend: "stub" | "bge-small";
  modelId: string;
  dim: number;
  status: EmbedderStatus;
  errorMessage?: string;
  loadMs?: number;
  embedMs?: number;
  embedCount?: number;
  cacheDir?: string;
}

/**
 * A pluggable semantic embedder. All methods are async so the
 * real ONNX backend can be used transparently.
 */
export interface SemanticEmbedder {
  metadata: EmbedderMetadata;
  /**
   * Embed a single text. Never throws on free-form text;
   * errors are caught and logged, and a stub vector is
   * returned.
   */
  embed(text: string, kind: "query" | "document"): Promise<number[]>;
  /**
   * Batch-embed texts. Default implementation loops over `embed`.
   */
  embedBatch(
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ): Promise<number[][]>;
}

/**
 * Options for constructing a embedder.
 */
export interface SemanticEmbedderOptions {
  /** Hugging Face model id. Default: `Xenova/bge-small-en-v1.5`. */
  modelId?: string;
  /** Local cache directory. Default: `<cwd>/.curion/transformers-cache/`. */
  cacheDir?: string;
  /** Allow remote model download. Default: true. */
  allowRemote?: boolean;
  /**
   * Embedding dimensionality override for the stub.
   * Ignored by the real embedder.
   */
  stubDim?: number;
}

// ---------------------------------------------------------------------------
// Stub deterministic embedder
// ---------------------------------------------------------------------------

const STUB_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any",
  "can", "had", "her", "was", "one", "our", "out", "day", "get",
  "has", "him", "his", "how", "man", "new", "now", "old", "see",
  "two", "way", "who", "boy", "did", "its", "let", "put", "say",
  "she", "too", "use", "this", "that", "with", "from", "have",
  "they", "their", "there", "what", "when", "your", "were", "been",
  "will", "would", "could", "should", "about", "into", "than",
  "then", "them", "these", "those", "because", "where", "which",
  "while", "whom", "ever", "very", "just", "also", "into", "over",
  "such", "some", "only", "more", "most", "other", "than", "each",
]);

const FNV1A_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV1A_PRIME_32 = 0x01000193;

function fnv1a32(s: string): number {
  let h = FNV1A_OFFSET_BASIS_32;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV1A_PRIME_32) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic dependency-free embedder for CI / tests.
 * Not a serious semantic ranker — enables paraphrase-in-vocabulary
 * recovery without model download.
 */
export class StubSemanticEmbedder implements SemanticEmbedder {
  metadata: EmbedderMetadata = {
    backend: "stub",
    modelId: "stub-v1",
    dim: 64,
    status: "ready",
  };

  private readonly dim: number;

  constructor(options: { stubDim?: number } = {}) {
    this.dim = options.stubDim ?? 64;
    this.metadata = { ...this.metadata, dim: this.dim };
  }

  private tokenize(text: string): string[] {
    if (typeof text !== "string") return [];
    const out: string[] = [];
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3) continue;
      if (/^\d+$/.test(raw)) continue;
      if (STUB_STOP_WORDS.has(raw)) continue;
      out.push(raw);
    }
    return out;
  }

  async embed(
    text: string,
    _kind: "query" | "document",
  ): Promise<number[]> {
    const values = new Float64Array(this.dim);
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return Array.from(values);
    }
    for (const tok of tokens) {
      const bucket = fnv1a32(tok) % this.dim;
      const sign = (fnv1a32("\u0001" + tok) & 0x80000000) !== 0 ? -1 : 1;
      values[bucket] += sign;
    }
    // L2 normalize.
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += values[i]! * values[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) values[i] = values[i]! / norm;
    }
    return Array.from(values);
  }

  async embedBatch(
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      out[i] = await this.embed(texts[i] ?? "", kind);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// BGE-small real embedder via @xenova/transformers
// ---------------------------------------------------------------------------

type FeatureExtractionPipeline = (
  input: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

let cachedTransformers: typeof import("@xenova/transformers") | null = null;

async function loadTransformers(): Promise<typeof import("@xenova/transformers")> {
  if (cachedTransformers) return cachedTransformers;
  const mod = (await import(
    /* @vite-ignore */ "@xenova/transformers"
  )) as typeof import("@xenova/transformers");
  cachedTransformers = mod;
  return mod;
}

/**
 * BGE-small embedder. Lazy-loads the ONNX pipeline on first
 * embed. First-run downloads from Hugging Face and caches
 * locally.
 */
export class BgeSmallEmbedder implements SemanticEmbedder {
  metadata: EmbedderMetadata = {
    backend: "bge-small",
    modelId: "Xenova/bge-small-en-v1.5",
    dim: 384,
    status: "skipped",
  };

  private pipeline: FeatureExtractionPipeline | null = null;
  private embedCount = 0;
  private embedMs = 0;
  private loadMs = 0;
  private failed = false;
  private errorMessage: string | undefined;
  private _warnedOfFailure = false;

  private readonly modelId: string;
  private readonly cacheDir: string;
  private readonly allowRemote: boolean;

  constructor(options: SemanticEmbedderOptions = {}) {
    this.modelId = options.modelId ?? "Xenova/bge-small-en-v1.5";
    this.cacheDir =
      options.cacheDir ??
      `${process.cwd()}/.curion/transformers-cache`;
    this.allowRemote = options.allowRemote ?? true;
    this.metadata = {
      ...this.metadata,
      modelId: this.modelId,
      cacheDir: this.cacheDir,
    };
  }

  /**
   * Initialize the ONNX pipeline. Idempotent. On failure,
   * marks the embedder as errored and returns a stub.
   */
  async init(): Promise<void> {
    if (this.pipeline) return;
    const t0 = Date.now();
    try {
      const tr = await loadTransformers();
      const env = (tr as unknown as {
        env: {
          cacheDir?: string;
          allowLocalModels?: boolean;
          allowRemoteModels?: boolean;
        };
      }).env;
      if (env) {
        env.cacheDir = this.cacheDir;
        env.allowLocalModels = true;
        env.allowRemoteModels = this.allowRemote;
      }
      const built = await tr.pipeline(
        "feature-extraction",
        this.modelId,
        { quantized: true },
      );
      this.pipeline = built as unknown as FeatureExtractionPipeline;
      // Probe the output dimension.
      const probe = await this.pipeline("test", {
        pooling: "mean",
        normalize: true,
      });
      const dim = probe.data.length;
      this.loadMs = Date.now() - t0;
      this.metadata = {
        ...this.metadata,
        dim,
        status: "ready",
        loadMs: this.loadMs,
        embedCount: 0,
        embedMs: 0,
      };
    } catch (err: unknown) {
      this.failed = true;
      this.errorMessage =
        err instanceof Error ? err.message : String(err);
      this.loadMs = Date.now() - t0;
      this.metadata = {
        ...this.metadata,
        status: "error",
        errorMessage: this.errorMessage,
        loadMs: this.loadMs,
      };
    }
  }

  async embed(text: string, kind: "query" | "document"): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      // Warn once per session when falling back to stub due to init failure.
      // The stub is dependency-free and works in tests/CI but is not
      // a real semantic ranker. Production should see this warning once
      // and fall back to lexical-only recall.
      if (this.failed && this.errorMessage && !this._warnedOfFailure) {
        this._warnedOfFailure = true;
        logger.warn(
          `BgeSmallEmbedder: ONNX init failed (${this.errorMessage}); falling back to stub hash embedder for this session. Semantic recall will use lexical only.`,
        );
      }
      return new StubSemanticEmbedder({ stubDim: this.metadata.dim }).embed(
        text,
        kind,
      );
    }
    const t0 = Date.now();
    try {
      const prefix =
        kind === "query"
          ? "Represent this sentence for searching relevant passages: "
          : "";
      const out = await this.pipeline(prefix + text, {
        pooling: "mean",
        normalize: true,
      });
      return Array.from(out.data);
    } finally {
      this.embedMs += Date.now() - t0;
      this.embedCount += 1;
      this.metadata = {
        ...this.metadata,
        embedCount: this.embedCount,
        embedMs: this.embedMs,
      };
    }
  }

  async embedBatch(
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ): Promise<number[][]> {
    if (!this.pipeline || this.failed) {
      // Warn once per session when falling back to stub due to init failure.
      if (this.failed && this.errorMessage && !this._warnedOfFailure) {
        this._warnedOfFailure = true;
        logger.warn(
          `BgeSmallEmbedder: ONNX init failed (${this.errorMessage}); falling back to stub hash embedder for this session. Semantic recall will use lexical only.`,
        );
      }
      const stub = new StubSemanticEmbedder({ stubDim: this.metadata.dim });
      return stub.embedBatch(texts, kind);
    }
    const t0 = Date.now();
    try {
      const prefix =
        kind === "query"
          ? "Represent this sentence for searching relevant passages: "
          : "";
      const textsWithPrefix = texts.map((t) => prefix + t);
      const out = await this.pipeline(textsWithPrefix as string[], {
        pooling: "mean",
        normalize: true,
      });
      const flat = out.data;
      const dim = this.metadata.dim;
      const result: number[][] = new Array(texts.length);
      for (let i = 0; i < texts.length; i++) {
        const slice: number[] = new Array(dim);
        for (let j = 0; j < dim; j++) {
          slice[j] = flat[i * dim + j]!;
        }
        result[i] = slice;
      }
      return result;
    } finally {
      this.embedMs += Date.now() - t0;
      this.embedCount += texts.length;
      this.metadata = {
        ...this.metadata,
        embedCount: this.embedCount,
        embedMs: this.embedMs,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type EmbedderBackend = "stub" | "bge-small";

/**
 * Build the appropriate embedder from configuration.
 *
 * When `semanticEnabled` is false, returns a stub with status "skipped".
 * When `semanticEnabled` is true, returns the BGE-small embedder
 * (or stub with status "error" if the ONNX backend fails to init).
 *
 * The returned embedder has already had `init()` called on it
 * (when applicable) so it is ready to use.
 */
export async function createSemanticEmbedder(
  options: SemanticEmbedderOptions & {
    enabled?: boolean;
  } = {},
): Promise<SemanticEmbedder> {
  if (!options.enabled) {
    const stub = new StubSemanticEmbedder({ stubDim: options.stubDim ?? 64 });
    stub.metadata = { ...stub.metadata, status: "skipped" };
    return stub;
  }
  const embedder = new BgeSmallEmbedder({
    modelId: options.modelId,
    cacheDir: options.cacheDir,
    allowRemote: options.allowRemote,
  });
  await embedder.init();
  return embedder;
}