/**
 * Benchmark-only Qwen3 dense-embedding backend.
 *
 * Why this exists:
 *   The Qwen3 embedding model is the next benchmark candidate
 *   the Architect's brief asks us to evaluate behind the
 *   existing `VectorEmbedder` seam. The Qwen3 family (Qwen3
 *   Embedding 0.6B) is an instruction-tuned embedding model
 *   that requires a specific query-side instruction prefix:
 *   `Instruct: <task>\nQuery:<query>` for queries, and
 *   unprefixed text for documents/passages. The model is
 *   released as an ONNX-quantized artifact at
 *   `onnx-community/Qwen3-Embedding-0.6B-ONNX` and is
 *   consumed locally via `@huggingface/transformers` (the
 *   v3.x runtime that replaces the legacy
 *   `@xenova/transformers` v2.17 stack).
 *
 * Execution regime (LOCAL, no external API):
 *   - `Qwen3Embedder` is the real local semantic
 *     embedder. The library is loaded lazily on the first
 *     `init()` call; the pipeline is cached on the
 *     instance.
 *   - The default pinned model is
 *     `onnx-community/Qwen3-Embedding-0.6B-ONNX` (q8
 *     quantized, 1024-dim). The model is downloaded once
 *     from the Hugging Face CDN and cached on disk.
 *   - Pooling: `last_token`. The Qwen3 family requires
 *     last-token pooling (not the MiniLM mean pooling the
 *     existing `TransformersJsEmbedder` uses).
 *   - Normalize: `true` (the model is trained to produce
 *     unit-normalized vectors; cosine similarity is the
 *     natural score scale).
 *
 * What this is NOT:
 *   - It is NOT wired into the production `recall(text)`
 *     controller. The benchmark-only runner is the only
 *     consumer. The public MCP API is unchanged (exactly
 *     `remember(text)` and `recall(text)`).
 *   - It is NOT a replacement for the MiniLM /
 *     `Xenova/all-MiniLM-L6-v2` backend the existing
 *     dense benchmark uses. The Qwen3 backend is opt-in
 *     via the `--embedder qwen3` (or `qwen3-hf`) CLI
 *     flag; the default benchmark path stays on the
 *     MiniLM / stub backend.
 *   - It is NOT an external API. No remote inference is
 *     performed. The first-run model download is the
 *     only network call and it is to the Hugging Face
 *     CDN.
 *
 * Determinism:
 *   The `Qwen3Embedder` is deterministic for a given
 *   (text, kind, model, ONNX runtime). The
 *   `@huggingface/transformers` runtime is bit-deterministic
 *   for a fixed input and a fixed thread count. The
 *   benchmark runner asserts this in a deterministic test
 *   that runs the embedder twice on the same input and
 *   checks the cosine of the outputs is 1.0.
 *
 * Score scale:
 *   The Qwen3 backend produces L2-normalized vectors.
 *   Cosine similarity is in [-1, 1]; for non-negative
 *   inputs the score is in [0, 1]. The same cosine
 *   scoring the existing dense vector variant uses is
 *   the natural score scale for this backend too.
 *
 * No-answer TNR:
 *   The default threshold is 0 (no filter), the same
 *   default the FTS5 / vector-hash / vector-dense
 *   variants use. Callers that want stricter abstention
 *   can pass a positive threshold.
 *
 * Why a new module (not an extension of the existing
 * `dense-embedder.ts`):
 *   The Qwen3 backend has a fundamentally different
 *   shape from the existing `TransformersJsEmbedder`:
 *   - It is backed by `@huggingface/transformers`
 *     (3.x+), not the legacy `@xenova/transformers`
 *     (2.17). The two libraries have incompatible type
 *     surfaces; mixing them in one class would require
 *     a runtime dispatch that obscures the code.
 *   - It has a query-vs-document instruction-format
 *     distinction the MiniLM backend does not. The
 *     benchmark runner needs to call the backend with
 *     `kind: "query"` for the user query string and
 *     `kind: "document"` for the corpus texts. The
 *     MiniLM backend treats every input the same way.
 *   - It defaults to last-token pooling and
 *     normalize=true; the MiniLM backend defaults to
 *     mean pooling and normalize=true. Forcing both
 *     backends into one class would mean two parallel
 *     code paths and a runtime-mode flag.
 *
 *   The new module implements the same `DenseEmbedder`
 *   interface the existing backend does, so the
 *   benchmark runner's `createDenseEmbedder` factory
 *   can return either implementation behind the same
 *   spec string. The `embedQuery` /
 *   `embedDocument` distinction is additive: a
 *   benchmark that does not need it can keep calling
 *   `embed` / `embedBatch` (which the Qwen3 backend
 *   maps to `embedDocument` for backward
 *   compatibility).
 *
 * Source-tree scope:
 *   The module lives under
 *   `src/benchmark/variants/qwen3-embedder.ts` and is
 *   imported only by the benchmark directory. The
 *   production `recall(text)` controller, the public
 *   MCP API, the controller, the storage layer, the
 *   safety layer, and the providers do NOT import
 *   this module. The source-tree guard in
 *   `tests/retrieval-dense-qwen3.test.ts` enforces the
 *   whitelist.
 *
 * Library version policy:
 *   The module uses `@huggingface/transformers` ^3.x.
 *   The 3.x API exposes a `pipeline` factory that
 *   returns a feature-extraction function whose output
 *   is a Tensor (or a tensor-like object). The
 *   `tensor_to_array` helper (provided by the same
 *   library, exported as a top-level symbol) converts
 *   the tensor to a plain JS array. The pooling /
 *     normalize options are forwarded as the second
 *     argument to the pipeline. We narrow the
 *   `pipeline(...)` call to a small local type
 *   (`FeatureExtractionPipeline`) so the embedder
 *   code stays robust against type drift between
 *   minor versions of the library.
 *
 *   Note: the `pipeline` function in 3.x returns a
 *   Promise. The lazy `loadLibrary` helper awaits
 *   the import + the pipeline build.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two text kinds the Qwen3 model distinguishes:
 *   - "query"    — applies the
 *                  `Instruct: <task>\nQuery:<query>` prefix
 *                  before tokenization.
 *   - "document" — does NOT apply a prefix; the model
 *                  encodes the text as-is (the standard
 *                  "passage" mode for retrieval).
 *
 * The default kind is "document" so a caller that
 * passes a plain string into the `embed` /
 * `embedBatch` helpers (the `DenseEmbedder` contract)
 * gets the "passage" behavior. The benchmark runner
 * calls `embedQuery` explicitly for the user query.
 */
export type Qwen3TextKind = "query" | "document";

/**
 * Configuration for the Qwen3 embedder. All fields are
 * optional; the defaults are the pinned model +
 * the on-disk cache directory under
 * `.curion/transformers-cache/`.
 *
 * The defaults match the Architect's brief:
 *   - modelId   : `onnx-community/Qwen3-Embedding-0.6B-ONNX`
 *   - dtype     : `q8` (8-bit quantization; ~600MB
 *                 cached)
 *   - pooling   : `last_token` (the Qwen3-recommended
 *                 pooling for the embedding task)
 *   - normalize : `true`
 *   - dim       : `1024` (the Qwen3-Embedding-0.6B
 *                 embedding dim)
 *   - task      : the model's recommended default
 *                 (`"Given a web search query, retrieve
 *                 relevant passages that best answer
 *                 the query"`)
 */
export interface Qwen3EmbedderOptions {
  /**
   * Pinned HF model id. Default:
   * `onnx-community/Qwen3-Embedding-0.6B-ONNX`.
   */
  modelId?: string;
  /**
   * ONNX dtype for the model. Default: `q8` (8-bit
   * quantization). The 3.x runtime accepts dtype
   * names like `"q8"`, `"q4"`, `"fp16"`, `"fp32"`,
   * `"q4f16"`, etc. The Qwen3 community ONNX artifact
   * is published with a `q8` quantization, so the
   * default is the dtype that artifact targets.
   */
  dtype?: "q8" | "q4" | "fp16" | "fp32" | string;
  /**
   * Pooling strategy. The Qwen3 family uses
   * `last_token` (the embedding is taken from the
   * last token's hidden state). Default: `last_token`.
   * A benchmark that wants to A/B pooling is free to
   * override, but the default is the documented
   * Qwen3-Embedding recommendation.
   */
  pooling?: "last_token" | "mean" | "cls" | "none";
  /**
   * Whether to L2-normalize the output vector. The
   * Qwen3 model is trained to produce unit-normalized
   * vectors; the runtime's normalize step matches the
   * reference scoring. Default: `true`.
   */
  normalize?: boolean;
  /**
   * Embedding dim. The Qwen3-Embedding-0.6B model
   * produces 1024-dim vectors. Default: `1024`. The
   * `init()` call probes the model output and
   * overwrites the placeholder if the probed dim
   * differs.
   */
  dim?: number;
  /**
   * Local cache directory for downloaded model
   * artifacts. Default:
   * `<cwd>/.curion/transformers-cache/`. The directory
   * is created on first use; the benchmark runner does
   * not clean it up.
   */
  cacheDir?: string;
  /**
   * Task instruction used to build the
   * `Instruct: <task>\nQuery:<query>` prefix. Default:
   * the model's documented default for retrieval
   * (`"Given a web search query, retrieve relevant
   * passages that best answer the query"`). A
   * benchmark that wants to study the effect of
   * different task strings can override.
   */
  task?: string;
}

// ---------------------------------------------------------------------------
// Library import helper
// ---------------------------------------------------------------------------

/**
 * The shape of the 3.x feature-extraction pipeline
 * the Qwen3 embedder needs. The library's full type
 * surface is large; we narrow to the call shape the
 * embedder actually uses so the code stays robust
 * against type drift between minor versions.
 */
type FeatureExtractionPipeline = (
  input: string | string[],
  options?: {
    pooling?: "last_token" | "mean" | "cls" | "none";
    normalize?: boolean;
  },
) => Promise<unknown>;

/**
 * The shape of the `@huggingface/transformers` module
 * we use. The 3.x API exposes `pipeline(...)` and an
 * `env` configuration object as the two integration
 * points the embedder needs.
 */
interface HfTransformersModule {
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: { dtype?: string; device?: string },
  ) => Promise<FeatureExtractionPipeline>;
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    // The 3.x `@huggingface/transformers` runtime
    // exposes its version on the `env` object. Older
    // shims (or stubbed test doubles) may not, so the
    // property is optional and the embedder also
    // falls back to the top-level `version` export.
    version?: string;
  };
  version?: string;
}

let cachedLibrary: HfTransformersModule | null = null;

/**
 * Lazy import of `@huggingface/transformers`. The
 * import is hoisted into a helper so the deterministic
 * stub path (and the `--dense-skip` path) does not pay
 * the cost of loading the runtime, and so a missing /
 * broken install does not break the CI deterministic
 * path.
 */
async function loadLibrary(): Promise<HfTransformersModule> {
  if (cachedLibrary) return cachedLibrary;
  // The import target uses the package's main entry
  // point. The 3.x package's main is
  // `src/transformers.js` and is published as a
  // CJS+ESM dual package; under NodeNext module
  // resolution the import resolves to the package
  // main with a `.js` extension inferred. We use a
  // runtime `import()` so missing or broken
  // installs surface as a clean error the benchmark
  // runner can fall back from.
  const mod = (await import(/* @vite-ignore */ "@huggingface/transformers")) as
    | HfTransformersModule
    | { default: HfTransformersModule };
  const resolved: HfTransformersModule =
    "default" in mod ? mod.default : mod;
  cachedLibrary = resolved;
  return resolved;
}

// ---------------------------------------------------------------------------
// Qwen3Embedder
// ---------------------------------------------------------------------------

/**
 * Real local Qwen3 dense embedder.
 *
 * Lazy: the underlying feature-extraction pipeline is
 * constructed on `init()` and cached. The `embedQuery`
 * / `embedDocument` methods are async (the underlying
 * ONNX forward pass is async).
 *
 * Backed by `@huggingface/transformers` 3.x and the
 * `onnx-community/Qwen3-Embedding-0.6B-ONNX` ONNX
 * artifact. The runtime is lazy-loaded; the model is
 * downloaded once on first use from the Hugging Face
 * CDN and cached on disk.
 *
 * Scope (benchmark-only):
 *   - Not wired into the production `recall(text)`
 *     controller.
 *   - Reachable only through the benchmark runner.
 *   - Source-tree guards in
 *     `tests/retrieval-dense-qwen3.test.ts` enforce
 *     the whitelist.
 */
export class Qwen3Embedder {
  /**
   * The backend metadata the benchmark runner
   * surfaces on the report. The `status` field
   * follows the same contract as the existing
   * `EmbedderMetadata`: `"ready"` means the embedder
   * actually executed; `"skipped"` means it was not
   * invoked; `"error"` means construction or first
   * use failed and the benchmark fell back to the
   * deterministic stub.
   */
  metadata: import("./dense-embedder.js").EmbedderMetadata;
  private pipeline: FeatureExtractionPipeline | null = null;
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly pooling: "last_token" | "mean" | "cls" | "none";
  private readonly normalize: boolean;
  private readonly cacheDir: string;
  private readonly task: string;
  private readonly probedDim: number;
  private embedCount = 0;
  private embedMs = 0;
  private loadMs = 0;
  private runtimeVersion: string | undefined;
  private failed = false;
  private errorMessage: string | undefined;

  constructor(options: Qwen3EmbedderOptions = {}) {
    this.modelId =
      options.modelId ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX";
    this.dtype = options.dtype ?? "q8";
    this.pooling = options.pooling ?? "last_token";
    this.normalize = options.normalize ?? true;
    this.cacheDir =
      options.cacheDir ?? `${process.cwd()}/.curion/transformers-cache`;
    this.task =
      options.task ??
      "Given a web search query, retrieve relevant passages that best answer the query";
    this.probedDim = options.dim ?? 1024;
    // Placeholder metadata. The real status / dim /
    // runtimeVersion are populated in `init()` after
    // the pipeline is built (we cannot know the dim
    // until the model loads).
    this.metadata = {
      backend: "qwen3",
      description:
        `local Qwen3 ONNX embedder via @huggingface/transformers ` +
        `(model=${this.modelId}, dtype=${this.dtype}, ` +
        `pooling=${this.pooling}, normalize=${this.normalize}, ` +
        `dim=${this.probedDim}, task="${this.task}")`,
      modelId: this.modelId,
      dim: this.probedDim,
      quantized: this.dtype.startsWith("q"),
      cacheDir: this.cacheDir,
      status: "skipped",
    };
  }

  /**
   * Build the feature-extraction pipeline. Idempotent:
   * a second call is a no-op. On error, the embedder
   * is marked `status: "error"` and falls back to the
   * deterministic stub for the rest of the run (so
   * the report shape is preserved and the failure is
   * visible on the metadata).
   */
  async init(): Promise<void> {
    if (this.pipeline) return;
    const t0 = Date.now();
    try {
      const lib = await loadLibrary();
      // The 3.x `@huggingface/transformers` runtime
      // exposes its version on the `env` object (not
      // as a top-level `version` export). Fall back to
      // the top-level export for older shims; the
      // resulting string is what the live test
      // asserts on.
      this.runtimeVersion =
        lib.env?.version ?? lib.version ?? undefined;
      if (lib.env) {
        lib.env.cacheDir = this.cacheDir;
        lib.env.allowLocalModels = true;
        lib.env.allowRemoteModels = true;
      }
      this.pipeline = await lib.pipeline(
        "feature-extraction",
        this.modelId,
        { dtype: this.dtype },
      );
      // Probe the dim with a 1-token string. The
      // output is a 1D vector (last-token-pooled,
      // normalized). We throw away the values; we
      // just want the length.
      const probe = await this.callPipeline("test", {
        pooling: this.pooling,
        normalize: this.normalize,
      });
      const dim = probe.length;
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
   * Build the `Instruct: <task>\nQuery:<query>` prefix
   * the Qwen3 model requires for queries. The
   * function is exported so the unit tests can assert
   * on the exact prefix without going through the
   * runtime.
   *
   * Note: the Qwen3 family uses
   * `Instruct: <task>\nQuery:<query>` (single newline,
   * no leading space, no trailing space) per the
   * model's documented prompt format. The function
   * returns the prefixed string verbatim. The
   * benchmark runner does not need to know the
   * format; it just calls `embedQuery` /
   * `embedDocument` and the embedder handles the
   * prefixing.
   */
  static buildQueryPrefix(task: string, query: string): string {
    return `Instruct: ${task}\nQuery:${query}`;
  }

  /**
   * Embed a query string. The Qwen3 model requires
   * the `Instruct: <task>\nQuery:<query>` prefix for
   * queries. The function applies the prefix and
   * forwards the prefixed text to the underlying
   * pipeline. The output is a unit-normalized
   * 1024-dim vector.
   */
  async embedQuery(text: string): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbed(text);
    }
    const prefixed = Qwen3Embedder.buildQueryPrefix(this.task, text);
    return this.timedSingle(prefixed);
  }

  /**
   * Embed a document / passage string. The Qwen3
   * model does NOT apply a prefix for documents; the
   * text is forwarded to the underlying pipeline
   * verbatim. The output is a unit-normalized
   * 1024-dim vector.
   *
   * Identical to `embed`; the explicit name documents
   * the intent at the call site and matches the
   * `Qwen3TextKind` enum.
   */
  async embedDocument(text: string): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbed(text);
    }
    return this.timedSingle(text);
  }

  /**
   * Batch-embed a list of documents. The
   * `DenseEmbedder` contract: a list of
   * `text -> vector` embeddings. The Qwen3 model
   * processes documents in batch mode (no prefix) by
   * default. The benchmark runner that wants a
   * mixed-mode batch should call `embedQuery` /
   * `embedDocument` per text and assemble the batch
   * manually; the Qwen3 batch helper is intentionally
   * document-only to keep the prefixing contract
   * simple and unit-testable.
   */
  async embedDocumentsBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbedBatch(texts);
    }
    return this.timedBatch(texts as string[]);
  }

  /**
   * `DenseEmbedder.embed` contract. Maps to
   * `embedDocument` (no prefix) so the Qwen3 backend
   * is drop-in compatible with the existing
   * `DenseEmbedder` interface. The benchmark runner
   * that wants query-side prefixing calls
   * `embedQuery` explicitly.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedDocument(text);
  }

  /**
   * `DenseEmbedder.embedBatch` contract. Maps to
   * `embedDocumentsBatch` (no prefix) for the same
   * reason. The benchmark runner that wants mixed-
   * mode batching uses `embedQuery` /
   * `embedDocument` per text.
   */
  async embedBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
    return this.embedDocumentsBatch(texts);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async timedSingle(text: string): Promise<number[]> {
    const t0 = Date.now();
    try {
      const out = await this.callPipeline(text, {
        pooling: this.pooling,
        normalize: this.normalize,
      });
      // The library returns a Tensor; the coercion
      // is `number[] | number[][]` because we
      // can't statically narrow. The single-input
      // path is documented to return a 1D vector.
      const arr = Array.isArray(out[0]) ? null : (out as number[]);
      if (!arr) {
        throw new Error(
          "Qwen3Embedder.timedSingle: expected a 1D vector, got a 2D array",
        );
      }
      return arr;
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

  private async timedBatch(texts: string[]): Promise<number[][]> {
    const t0 = Date.now();
    try {
      const out = await this.callPipeline(texts, {
        pooling: this.pooling,
        normalize: this.normalize,
      });
      // The library returns a Tensor; the batch
      // path is documented to return a 2D array
      // (one vector per input text). The runtime
      // may also return a flat Float32Array in
      // some configurations; we split the flat
      // shape into per-text vectors using the
      // known Qwen3 dim. (The Qwen3-Embedding-0.6B
      // dim is 1024; we use the metadata's dim,
      // which was probed at init time.)
      if (out.length > 0 && Array.isArray(out[0])) {
        return out as number[][];
      }
      const flat = out as number[];
      const dim = this.metadata.dim;
      if (flat.length !== texts.length * dim) {
        throw new Error(
          `Qwen3Embedder.timedBatch: flat output length ${flat.length} does not match ${texts.length} * dim(${dim})`,
        );
      }
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

  /**
   * Call the underlying pipeline. The 3.x pipeline
   * returns a Tensor; we convert to a plain JS array
   * (or array of arrays) so the ranker can score it
   * with the same cosine helper the existing
   * `vector-dense` variant uses.
   *
   * The function is intentionally permissive about
   * the return shape: we accept anything that looks
   * like a Tensor with a `toArray()` method, an
   * object with a `data` Float32Array, or a plain
   * nested JS array. The 3.x runtime's tensor API
   * exposes `tensor.data` as a Float32Array and
   * `tensor.toArray()` returns the JS nested array.
   * We prefer `toArray()` when present (it returns
   * the canonical JS shape) and fall back to
   * `.data` for older shapes.
   */
  private async callPipeline(
    input: string | string[],
    options: { pooling?: "last_token" | "mean" | "cls" | "none"; normalize?: boolean },
  ): Promise<number[] | number[][]> {
    if (!this.pipeline) {
      throw new Error(
        "Qwen3Embedder.callPipeline: pipeline is not initialized",
      );
    }
    const raw = await this.pipeline(input, options);
    return coerceToArray(raw);
  }

  /**
   * Fallback embedder used when the pipeline is
   * not initialized (or initialization failed).
   * The fallback is a deterministic
   * `StubDeterministicDenseEmbedder` at the Qwen3
   * dim. The fallback records `status: "error"` on
   * the metadata so a reviewer can see the live
   * model never ran; the ranker still produces a
   * well-formed report shape.
   */
  private async fallbackEmbed(text: string): Promise<number[]> {
    const { StubDeterministicDenseEmbedder } = await import(
      "./dense-embedder.js"
    );
    return new StubDeterministicDenseEmbedder({
      dim: this.metadata.dim,
    }).embed(text);
  }

  private async fallbackEmbedBatch(
    texts: ReadonlyArray<string>,
  ): Promise<number[][]> {
    const { StubDeterministicDenseEmbedder } = await import(
      "./dense-embedder.js"
    );
    return new StubDeterministicDenseEmbedder({
      dim: this.metadata.dim,
    }).embedBatch(texts);
  }
}

/**
 * Coerce a 3.x pipeline result to a plain JS array
 * of numbers (single text) or array of arrays
 * (batched). The coercion is permissive: it accepts
 * a Tensor with `.toArray()`, an object with a
 * `.data` Float32Array, or a plain nested JS array.
 *
 * The Qwen3 batched output lays out batch-major
 * (text-major): for a batch of `N` texts and `dim`
 * features, the data is an `N * dim` Float32Array
 * where text `i`'s features are at offsets
 * `[i*dim, (i+1)*dim)`. We split it back into
 * per-text arrays.
 */
function coerceToArray(raw: unknown): number[] | number[][] {
  // Plain nested JS array (the canonical 3.x
  // shape): pass through.
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (Array.isArray(raw[0])) {
      // Nested: assume batch-major.
      return raw as number[][];
    }
    return raw as number[];
  }
  // Tensor-like: try `.toArray()` first, then
  // `.data`.
  if (raw && typeof raw === "object") {
    const candidate = raw as {
      toArray?: () => unknown;
      data?: Float32Array | number[];
    };
    if (typeof candidate.toArray === "function") {
      const arr = candidate.toArray();
      if (Array.isArray(arr)) {
        if (arr.length === 0) return [];
        if (Array.isArray(arr[0])) {
          return arr as number[][];
        }
        return arr as number[];
      }
    }
    if (candidate.data) {
      const data = candidate.data;
      // We do not know the dim from `.data` alone
      // (it is flat). The caller (`timedBatch`)
      // knows the dim and splits accordingly. We
      // return a flat array here; the caller
      // handles the split.
      return Array.from(data);
    }
  }
  throw new Error(
    `coerceToArray: cannot coerce pipeline output of type ${typeof raw}`,
  );
}
