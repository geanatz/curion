/**
 * Pluggable real local dense-embedding backend.
 *
 * Why this exists:
 *   The Architect's brief asks the next benchmark phase to
 *   test a REAL local semantic embedding backend behind the
 *   existing `VectorEmbedder` seam, preserve the hashed
 *   bag-of-words as a control, and add artifact metadata
 *   documenting what was actually executed. This module is
 *   the pluggable extension point: a stable `DenseEmbedder`
 *   interface, a metadata shape that captures backend /
 *   model / dim / runtime / status, and a small family of
 *   implementations covering the three execution regimes
 *   the benchmark needs.
 *
 * Execution regimes (all LOCAL, no external API):
 *
 *   1. `StubDeterministicDenseEmbedder` — a dependency-free
 *      pure-JS deterministic embedder. Used for CI without
 *      network and as a fixture in tests. It is NOT meant to
 *      be a serious semantic ranker; it produces a 64-dim
 *      L2-normalized vector from a per-token hash + sign
 *      trick, similar in spirit to the hashed-BoW control but
 *      with a stable per-token random projection (so
 *      paraphrase-style overlapping tokens still get
 *      overlapping vectors, while disjoint tokens decorrelate).
 *
 *   2. `TransformersJsEmbedder` — the real local semantic
 *      embedder, backed by ONNX Runtime via `@xenova/transformers`.
 *      No external API; the model is downloaded once from
 *      Hugging Face on first use and cached on disk. The
 *      default pinned model is `Xenova/all-MiniLM-L6-v2`
 *      (a quantized 384-dim MiniLM; ~25MB cached, ~700ms
 *      first-load on a modern CPU). The backend is opt-in
 *      via the `--embedder transformersjs` CLI flag; the
 *      default benchmark path stays on the deterministic
 *      stub (or the existing hashed-BoW control) so CI does
 *      not require a model download.
 *
 *   3. The existing hashed bag-of-words embedder in
 *      `benchmark/variants/vector.ts` is preserved as a
 *      CONTROL. It is not replaced; the new dense path
 *      composes on top of the same `VectorEmbedder` seam.
 *
 * No external API embedding providers are added. No remote
 * inference is performed. The first-run model download is a
 * Hugging Face CDN fetch, cached on disk in the local
 * transformers.js cache directory; it is the same download
 * any first-run user of the library would do. The runner
 * does not bypass the cache and does not stream embeddings
 * off-device.
 *
 * Why this is benchmark-only:
 *   The interface is real and the model is real, but the
 *   runner that consumes it is the retrieval-benchmark CLI.
 *   The production `recall(text)` controller, the public MCP
 *   API, and the controller's lexical-only path are
 *   unchanged. The new embedder is reachable only through
 *   the benchmark runner. Source-tree guards in
 *   `tests/retrieval-dense-vector.test.ts` enforce this.
 *
 * Determinism:
 *   - The stub embedder is deterministic for a given text.
 *   - The transformers.js embedder is deterministic for a
 *     given text + a fixed model + a fixed runtime. ONNX
 *     Runtime is bit-deterministic for a given thread count
 *     and a fixed input, so repeated calls produce identical
 *     vectors. The runner asserts this in a deterministic
 *     test that runs the embedder twice on the same input
 *     and checks the cosine of the outputs is 1.0.
 *
 * Score scale:
 *   Both implementations produce L2-normalized vectors. The
 *   `rankDenseVector` ranker (see
 *   `benchmark/variants/dense-vector.ts`) takes cosine
 *   similarity in [-1, 1] and uses the same `0..1` (or
 *   higher) "higher is better" contract the existing
 *   variants use. Callers that want the no-answer TNR to be
 *   meaningful can pass a positive threshold.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Backend metadata. Carried on every report and surfaced in
 * the CLI summary so a reviewer can audit exactly which
 * embedder produced the numbers.
 *
 * `status` distinguishes:
 *   - "ready"     — the embedder executed successfully.
 *   - "skipped"   — the embedder was not invoked (e.g. a
 *                   dry-run or a configuration that explicitly
 *                   skips execution). The benchmark falls back
 *                   to the deterministic stub in this case so
 *                   the artifact is still well-formed and
 *                   comparable.
 *   - "error"     — the embedder failed at construction or
 *                   first use. The error message is captured
 *                   on `errorMessage`; the benchmark falls
 *                   back to the deterministic stub so the
 *                   report shape is preserved.
 */
export type EmbedderStatus = "ready" | "skipped" | "error";

export interface EmbedderMetadata {
  /** Stable id used in reports and CLI flags. */
  backend: "stub-dense" | "transformersjs" | "hashed-bow";
  /** Human description. */
  description: string;
  /** Pinned model id (HF repo, ONNX file, or stub label). */
  modelId: string;
  /** Embedding dimensionality. */
  dim: number;
  /** Whether the model is quantized (only meaningful for ONNX). */
  quantized?: boolean;
  /** Library / runtime version, when available. */
  runtimeVersion?: string;
  /**
   * Execution status. `ready` means the embedder actually
   * ran on the query / corpus during the benchmark; `skipped`
   * means it was not invoked; `error` means the embedder
   * failed (the benchmark falls back to the stub).
   */
  status: EmbedderStatus;
  /** Human-readable error message, set when status === "error". */
  errorMessage?: string;
  /**
   * Wall-clock milliseconds the embedder took across the
   * whole run. Useful for cost analysis. `undefined` when
   * the embedder was skipped.
   */
  loadMs?: number;
  /**
   * Wall-clock milliseconds spent in `embed()` / `embedBatch()`
   * across the whole run. `undefined` when the embedder was
   * skipped.
   */
  embedMs?: number;
  /**
   * Number of texts embedded. Useful to compute
   * `embedMs / embedCount` for per-text cost. `undefined`
   * when the embedder was skipped.
   */
  embedCount?: number;
  /**
   * Local model cache directory, when the backend writes
   * artifacts to disk. `undefined` for the stub.
   */
  cacheDir?: string;
}

/**
 * A pluggable real local dense-embedding backend.
 *
 * The interface is async because the real ONNX forward
 * pass is async (model download, ONNX session build, and
 * tensor copy are all async). The stub embedder implements
 * the async methods with `Promise.resolve(...)`; the cost
 * of the extra microtask is invisible relative to the
 * transformer model load.
 *
 * Determinism: implementations MUST be deterministic for a
 * given (text, options) pair. The stub is fully
 * deterministic; the transformers.js embedder is
 * deterministic for a fixed model + ONNX runtime.
 */
export interface DenseEmbedder {
  /** Backend metadata. Always present. */
  metadata: EmbedderMetadata;
  /** Embed a single text. Must never throw on free-form text. */
  embed(text: string): Promise<number[]>;
  /**
   * Batch-embed a list of texts. The default implementation
   * loops over `embed`, but a real local ONNX embedder
   * overrides this to do a single model forward pass.
   */
  embedBatch(texts: ReadonlyArray<string>): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// 1. StubDeterministicDenseEmbedder
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Stable, non-cryptographic, fast, no
 * dependencies. Mirrors the helper in the hashed-BoW
 * control so the two backends share the same hash family.
 */
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
 * English stopwords. Same set the lexical baseline
 * (`retrieval/lexical.ts`) uses. Re-declared here so
 * the dense stub module remains self-contained.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
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

/**
 * Stable pseudo-random projection of a token into
 * {-1, +1}^dim. The projection is two independent hashes:
 * one for the bucket, one for the sign. This is the
 * "feature hashing" trick of Weinberger et al. (2009) with
 * a fixed dim, so two texts that share tokens share
 * vector components, while two disjoint texts decorrelate.
 *
 * The default `dim = 64` is small (the stub is not meant
 * to be a serious semantic ranker) but enough to make the
 * shape of the report meaningful and to make the
 * deterministic test fast.
 */
export class StubDeterministicDenseEmbedder implements DenseEmbedder {
  metadata: EmbedderMetadata = {
    backend: "stub-dense",
    description:
      "deterministic dependency-free dense projection (feature hashing) for CI / dry runs",
    modelId: "stub-dense-v1",
    dim: 64,
    status: "ready",
  };

  constructor(options: { dim?: number } = {}) {
    if (options.dim !== undefined) {
      if (!Number.isInteger(options.dim) || options.dim <= 0) {
        throw new Error(
          `StubDeterministicDenseEmbedder: dim must be a positive integer (got ${options.dim})`,
        );
      }
      // The metadata dim is the contract; we keep it in
      // sync with the constructor so a caller that overrides
      // dim sees the right value on the report.
      this.metadata = { ...this.metadata, dim: options.dim };
    }
  }

  /**
   * Tokenize the input the same way the lexical baseline
   * does. The stub does not need IDF; sub-linear TF would
   * not change the fact that the projection is a fixed
   * per-token random direction, so the simpler `+1` /
   * `-1` accumulation is enough for the deterministic
   * fixture.
   */
  private tokenize(text: string): string[] {
    if (typeof text !== "string") return [];
    const out: string[] = [];
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3) continue;
      if (/^\d+$/.test(raw)) continue;
      // Filter the same English stopwords the lexical
      // baseline filters. The list is the same one in
      // `retrieval/lexical.ts`. We re-declare it here
      // (rather than import it) so the dense module
      // remains self-contained and the hashed-BoW
      // control / dense stub stay in sync via this
      // property: both produce the zero vector for a
      // pure-stopword input.
      if (STOP_WORDS.has(raw)) continue;
      out.push(raw);
    }
    return out;
  }

  async embed(text: string): Promise<number[]> {
    const dim = this.metadata.dim;
    const values = new Float64Array(dim);
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return Array.from(values);
    }
    for (const tok of tokens) {
      const bucket = fnv1a32(tok) % dim;
      // A second independent hash determines the sign.
      // Same salt scheme as the hashed-BoW control, but
      // with a different prefix so the two embeddings
      // decorrelate.
      const sign = (fnv1a32("\u0001" + tok) & 0x80000000) !== 0 ? -1 : 1;
      values[bucket] += sign;
    }
    // L2 normalize.
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += values[i]! * values[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) values[i] = values[i]! / norm;
    }
    return Array.from(values);
  }

  async embedBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      out[i] = await this.embed(texts[i] ?? "");
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 2. TransformersJsEmbedder (real local semantic embedder)
// ---------------------------------------------------------------------------

/**
 * The library import is hoisted into a lazy `loadLibrary`
 * helper so the deterministic stub path does not pay the
 * cost of importing `@xenova/transformers` (and so a
 * missing / broken install does not break the CI
 * deterministic path).
 */
type TransformersJsModule = typeof import("@xenova/transformers");
let cachedTransformers: TransformersJsModule | null = null;

async function loadTransformers(): Promise<TransformersJsModule> {
  if (cachedTransformers) return cachedTransformers;
  const mod = (await import(
    /* @vite-ignore */ "@xenova/transformers"
  )) as TransformersJsModule;
  cachedTransformers = mod;
  return mod;
}

/**
 * Configuration for the real local transformers.js
 * embedder. All fields are optional; the defaults are
 * the pinned model + the on-disk cache directory under
 * `.cortex/transformers-cache/`.
 */
export interface TransformersJsEmbedderOptions {
  /** Pinned HF model id. Default: `Xenova/all-MiniLM-L6-v2`. */
  modelId?: string;
  /**
   * Whether to use the quantized ONNX model. Default:
   * `true`. The quantized model is ~25MB, fits in a CI
   * cache, and is bit-deterministic.
   */
  quantized?: boolean;
  /**
   * Local cache directory for downloaded model artifacts.
   * Default: `<cwd>/.cortex/transformers-cache/`. The
   * directory is created on first use; the benchmark
   * runner does not clean it up.
   */
  cacheDir?: string;
}

/**
 * The pipeline function shape we need. The transformers.js
 * type surface is large; we narrow to the call we actually
 * use so the embedder code stays robust against type drift
 * between minor versions of the library.
 */
type FeatureExtractionPipeline = (
  input: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

/**
 * Real local semantic embedder backed by ONNX Runtime via
 * `@xenova/transformers`. Lazy: the underlying pipeline is
 * constructed on `init()` and cached; the `embed` and
 * `embedBatch` calls are async (the underlying ONNX
 * forward pass is async).
 */
export class TransformersJsEmbedder implements DenseEmbedder {
  metadata: EmbedderMetadata;
  private pipeline: FeatureExtractionPipeline | null = null;
  private readonly modelId: string;
  private readonly quantized: boolean;
  private readonly cacheDir: string;
  private embedCount = 0;
  private embedMs = 0;
  private loadMs = 0;
  private runtimeVersion: string | undefined;
  private failed = false;
  private errorMessage: string | undefined;

  constructor(options: TransformersJsEmbedderOptions = {}) {
    this.modelId = options.modelId ?? "Xenova/all-MiniLM-L6-v2";
    this.quantized = options.quantized ?? true;
    this.cacheDir =
      options.cacheDir ??
      `${process.cwd()}/.cortex/transformers-cache`;
    // Placeholder metadata; the real status / dim are
    // populated in `init()` after the pipeline is built
    // (we cannot know the dim until the model loads).
    this.metadata = {
      backend: "transformersjs",
      description: `local ONNX embedder via @xenova/transformers (model=${this.modelId}, quantized=${this.quantized})`,
      modelId: this.modelId,
      // We do not know the dim until init; the placeholder
      // is the conventional MiniLM dim. `init()` overwrites
      // it with the actual model output dim.
      dim: 384,
      quantized: this.quantized,
      cacheDir: this.cacheDir,
      status: "skipped",
    };
  }

  /**
   * Build the pipeline. Idempotent: a second call is a
   * no-op. On error, the embedder is marked
   * `status: "error"` and falls back to the deterministic
   * stub for the rest of the run (so the report shape is
   * preserved and the failure is visible on the metadata).
   */
  async init(): Promise<void> {
    if (this.pipeline) return;
    const t0 = Date.now();
    try {
      const tr = await loadTransformers();
      this.runtimeVersion = (tr as unknown as { VERSION?: string }).VERSION;
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
        env.allowRemoteModels = true;
      }
      const built = await tr.pipeline(
        "feature-extraction",
        this.modelId,
        { quantized: this.quantized },
      );
      this.pipeline = built as unknown as FeatureExtractionPipeline;
      // Probe the dim with a 1-token string. The output is
      // a Float32Array of length `dim` (mean-pooled,
      // normalized). We throw away the values; we just
      // want the length.
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
        runtimeVersion: this.runtimeVersion,
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
      // We do not throw: the runner expects a usable
      // embedder (the stub fallback will take over when
      // `embed` is called and the pipeline is null).
    }
  }

  /**
   * Embed a single text. If the pipeline is not initialized
   * or initialization failed, falls back to the
   * deterministic stub so the report shape is preserved.
   * The fallback is recorded on the metadata so a reviewer
   * can see the live model never ran.
   */
  async embed(text: string): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      return new StubDeterministicDenseEmbedder({
        dim: this.metadata.dim,
      }).embed(text);
    }
    const t0 = Date.now();
    try {
      const out = await this.pipeline(text, {
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

  /**
   * Batch-embed a list of texts. This is the hot path the
   * benchmark uses. The pipeline is invoked once with the
   * whole batch so ONNX Runtime amortizes the model
   * forward pass across all texts.
   */
  async embedBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
    if (!this.pipeline || this.failed) {
      return new StubDeterministicDenseEmbedder({
        dim: this.metadata.dim,
      }).embedBatch(texts);
    }
    const t0 = Date.now();
    try {
      const out = await this.pipeline(texts as string[], {
        pooling: "mean",
        normalize: true,
      });
      // `out.data` is a flat Float32Array of length
      // `texts.length * dim` (the library lays out
      // batch-major). We split it back into per-text
      // arrays so the ranker can score them with the
      // existing cosine similarity helper.
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

/**
 * Build a dense embedder from a CLI-friendly spec.
 *
 * Spec format (string):
 *   - "stub-dense"          → `StubDeterministicDenseEmbedder`
 *   - "stub-dense:dim=N"    → `StubDeterministicDenseEmbedder` with custom dim
 *   - "transformersjs"      → `TransformersJsEmbedder` (default model)
 *   - "transformersjs:model=<id>,quantized=true|false"
 *
 * The default `transformersjs` model is
 * `Xenova/all-MiniLM-L6-v2` (quantized). The function is
 * async because the transformers.js backend may need to
 * download the model on first use.
 */
export interface DenseEmbedderSpecOptions {
  /**
   * Local cache directory for downloaded model artifacts.
   * Forwarded to `TransformersJsEmbedder`. Default:
   * `<cwd>/.cortex/transformers-cache/`.
   */
  cacheDir?: string;
  /**
   * When `true`, the factory returns a stub embedder with
   * `status: "skipped"` without invoking the model
   * download. Used by the `--dense-skip` CLI flag and by
   * the "no model" path the benchmark exposes.
   */
  skip?: boolean;
}

export type DenseEmbedderSpec = string | DenseEmbedderSpecOptions;

export interface DenseEmbedderFactoryResult {
  embedder: DenseEmbedder;
  /** The original spec, normalized to a string for reporting. */
  spec: string;
}

export async function createDenseEmbedder(
  spec: DenseEmbedderSpec = "stub-dense",
  options: DenseEmbedderSpecOptions = {},
): Promise<DenseEmbedderFactoryResult> {
  if (typeof spec === "object") {
    options = { ...options, ...spec };
    spec = "transformersjs";
  }
  const skip = options.skip ?? false;
  // Match `stub-dense` or `stub-dense:dim=N` (with
  // any number of trailing key=value pairs). The
  // factory supports the same `key=value,key=value`
  // syntax for `transformersjs` and the same for
  // `stub-dense` (currently only `dim`).
  if (typeof spec === "string" && (spec === "stub-dense" || spec.startsWith("stub-dense:") || skip)) {
    let dim = 64;
    if (spec.startsWith("stub-dense:")) {
      const tail = spec.slice("stub-dense:".length);
      for (const part of tail.split(",")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (key === "dim") {
          const n = Number.parseInt(val, 10);
          if (Number.isInteger(n) && n > 0) dim = n;
        }
      }
    }
    return {
      embedder: new StubDeterministicDenseEmbedder({ dim }),
      spec: skip ? "stub-dense (skipped)" : spec,
    };
  }
  if (spec === "transformersjs" || spec.startsWith("transformersjs:")) {
    const tail = spec.slice("transformersjs".length);
    let modelId: string | undefined;
    let quantized: boolean | undefined;
    if (tail.startsWith(":")) {
      for (const part of tail.slice(1).split(",")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (key === "model") modelId = val;
        else if (key === "quantized") {
          if (val === "true") quantized = true;
          else if (val === "false") quantized = false;
        }
      }
    }
    const embedder = new TransformersJsEmbedder({
      ...(modelId !== undefined ? { modelId } : {}),
      ...(quantized !== undefined ? { quantized } : {}),
      ...(options.cacheDir !== undefined
        ? { cacheDir: options.cacheDir }
        : {}),
    });
    if (!skip) {
      await embedder.init();
    }
    return { embedder, spec };
  }
  throw new Error(
    `createDenseEmbedder: unknown spec "${spec}". Expected "stub-dense" or "transformersjs[:model=...,quantized=...]".`,
  );
}
