/**
 * Benchmark-only EmbeddingGemma dense-embedding backend.
 *
 * Why this exists:
 *   EmbeddingGemma is the next benchmark candidate
 *   the user-approved brief asks the project to
 *   evaluate behind the existing `VectorEmbedder`
 *   seam, following the Qwen3 candidate. The
 *   EmbeddingGemma family is Google's text-only
 *   embedding model distilled from Gemma 3, sized
 *   at 300M parameters with a 768-dim embedding
 *   space and a 2048-token context. It is released
 *   as an ONNX-quantized artifact at
 *   `onnx-community/embeddinggemma-300m-ONNX` and
 *   is consumed locally via
 *   `@huggingface/transformers` (the same 3.x
 *   runtime the `Qwen3Embedder` uses).
 *
 *   EmbeddingGemma is documented to support the
 *   `prompt: "task: search result | query: ..."` /
 *   `"title: none | text: ..."` prompt templates
 *   (the canonical prefixes the model was trained
 *   on). The `EmbeddingGemmaEmbedder` applies
 *   the search-result / query template to queries
 *   and the no-title / text template to
 *   documents / passages. The prefixes are
 *   documented in the model's model card; the
 *   `buildQueryPrefix` and `buildDocumentPrefix`
 *   helpers below return the canonical strings
 *   verbatim so a unit test can pin the exact
 *   format.
 *
 * Execution regime (LOCAL, no external API):
 *   - `EmbeddingGemmaEmbedder` is the real local
 *     semantic embedder. The library is loaded
 *     lazily on the first `init()` call; the
 *     pipeline is cached on the instance.
 *   - The default pinned model is
 *     `onnx-community/embeddinggemma-300m-ONNX`
 *     (q8 quantized, 768-dim). The model is
 *     downloaded once from the Hugging Face CDN
 *     and cached on disk.
 *   - Pooling: `mean` (the model's recommended
 *     pooling for the embedding task; the
 *     `feature-extraction` pipeline's `pooling:
 *     "mean"` setting is what the model card
 *     documents for retrieval use cases).
 *   - Normalize: `true` (the model is trained to
 *     produce unit-normalized vectors; cosine
 *     similarity is the natural score scale).
 *   - License caveat: EmbeddingGemma is released
 *     under the Gemma Terms of Use. The user
 *     accepted this caveat for the benchmark
 *     candidate; the `description` field on the
 *     embedder's metadata surfaces the license
 *     abbreviation so a reviewer can audit it on
 *     the artifact. The model is NOT
 *     wired into production; the license is a
 *     research-only caveat, not a deployment
 *     commitment.
 *
 * What this is NOT:
 *   - It is NOT wired into the production
 *     `recall(text)` controller. The
 *     benchmark-only runner is the only consumer.
 *     The public MCP API is unchanged (exactly
 *     `remember(text)` and `recall(text)`).
 *   - It is NOT a replacement for the MiniLM /
 *     `Xenova/all-MiniLM-L6-v2` backend OR the
 *     Qwen3 backend. EmbeddingGemma is opt-in via
 *     the `--embedder embeddinggemma` (or
 *     `embedding-gemma`) CLI flag; the default
 *     benchmark path stays on the MiniLM / stub
 *     backend. EmbeddingGemma and Qwen3 are
 *     sibling candidates in the same
 *     evidence-first series; both may be
 *     benchmarked, one at a time, on the same
 *     harness.
 *   - It is NOT an external API. No remote
 *     inference is performed. The first-run
 *     model download is the only network call
 *     and it is to the Hugging Face CDN.
 *
 * Determinism:
 *   The `EmbeddingGemmaEmbedder` is deterministic
 *   for a given (text, kind, model, ONNX runtime).
 *   The `@huggingface/transformers` runtime is
 *   bit-deterministic for a fixed input and a
 *   fixed thread count. The benchmark runner
 *   asserts this in a deterministic test that
 *   runs the embedder twice on the same input
 *   and checks the cosine of the outputs is 1.0.
 *
 * Score scale:
 *   The EmbeddingGemma backend produces
 *   L2-normalized vectors. Cosine similarity is
 *   in [-1, 1]; for non-negative inputs the
 *   score is in [0, 1]. The same cosine scoring
 *   the existing dense vector variant uses is
 *   the natural score scale for this backend
 *   too.
 *
 * No-answer TNR:
 *   The default threshold is 0 (no filter), the
 *   same default the FTS5 / vector-hash /
 *   vector-dense variants use. Callers that
 *   want stricter abstention can pass a positive
 *   threshold.
 *
 * Why a new module (not an extension of the
 * existing `dense-embedder.ts` or
 * `qwen3-embedder.ts`):
 *   EmbeddingGemma has a fundamentally different
 *   shape from the existing
 *   `TransformersJsEmbedder` (different library,
 *   different pooling default) and a different
 *   prompt template from the Qwen3 backend
 *   (search-result / no-title prefixes, not
 *   the Qwen3 `Instruct:` / `Query:` prefix).
 *   The new module implements the same
 *   `DenseEmbedder` interface the existing
 *   backends do, so the benchmark runner's
 *   `createDenseEmbedder` factory can return any
 *   of the implementations behind the same
 *   spec string. The `embedQuery` /
 *   `embedDocument` distinction is additive: a
 *   benchmark that does not need it can keep
 *   calling `embed` / `embedBatch` (which the
 *   EmbeddingGemma backend maps to
 *   `embedDocument` for backward
 *   compatibility).
 *
 *   The shared `@huggingface/transformers`
 *   boilerplate (lazy load, env/cache config,
 *   pipeline init, runtimeVersion probe, output
 *   coercion, fallback stub, embed timing) is
 *   intentionally NOT extracted into a base
 *   class in this commit. The Qwen3 module is
 *   small and self-contained; the
 *   EmbeddingGemma module is also small and
 *   self-contained; extracting a base class
 *   would couple two candidates that the
 *   evidence-first comparison philosophy
 *   intends to keep independent. The two
 *   modules share the same library version
 *   policy, the same `FeatureExtractionPipeline`
 *   narrowing, and the same `coerceToArray`
 *   helper shape, but they do NOT import each
 *   other. A future refactor can extract the
 *   shared base when the third candidate lands
 *   and the duplication is the right size to
 *   pay the abstraction cost.
 *
 * Source-tree scope:
 *   The module lives under
 *   `src/benchmark/variants/embeddinggemma-embedder.ts`
 *   and is imported only by the benchmark
 *   directory. The production `recall(text)`
 *   controller, the public MCP API, the
 *   controller, the storage layer, the safety
 *   layer, and the providers do NOT import
 *   this module. The source-tree guard in
 *   `tests/retrieval-dense-embeddinggemma.test.ts`
 *   enforces the whitelist.
 *
 * Library version policy:
 *   The module uses
 *   `@huggingface/transformers` ^3.x. The 3.x
 *   API exposes a `pipeline` factory that
 *   returns a feature-extraction function
 *   whose output is a Tensor (or a
 *   tensor-like object). The `coerceToArray`
 *   helper (a local module-private helper,
 *   structurally identical to the Qwen3
 *   module's) converts the tensor to a plain
 *   JS array. The pooling / normalize options
 *   are forwarded as the second argument to
 *   the pipeline. We narrow the `pipeline(...)`
 *   call to a small local type
 *   (`FeatureExtractionPipeline`) so the
 *   embedder code stays robust against type
 *   drift between minor versions of the
 *   library.
 *
 *   Note: the `pipeline` function in 3.x
 *   returns a Promise. The lazy `loadLibrary`
 *   helper awaits the import + the pipeline
 *   build.
 *
 *   Note: the `EmbeddingGemmaEmbedder` and the
 *   `Qwen3Embedder` use the same library and
 *   the same `FeatureExtractionPipeline`
 *   narrowing; a future refactor can extract
 *   a shared base when the third candidate
 *   lands. For now the two are sibling
 *   modules that happen to use the same
 *   runtime.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two text kinds the EmbeddingGemma model
 * distinguishes:
 *   - "query"    — applies the
 *                  `task: search result | query: <query>`
 *                  prefix before tokenization.
 *   - "document" — applies the
 *                  `title: none | text: <text>` prefix
 *                  before tokenization.
 *
 * The default kind is "document" so a caller that
 * passes a plain string into the `embed` /
 * `embedBatch` helpers (the `DenseEmbedder`
 * contract) gets the passage behavior. The
 * benchmark runner calls `embedQuery` explicitly
 * for the user query.
 */
export type EmbeddingGemmaTextKind = "query" | "document";

/**
 * Configuration for the EmbeddingGemma embedder.
 * All fields are optional; the defaults are the
 * pinned model + the on-disk cache directory
 * under `.curion/transformers-cache/`.
 *
 * The defaults match the user's approved
 * research brief:
 *   - modelId   : `onnx-community/embeddinggemma-300m-ONNX`
 *   - dtype     : `q8` (8-bit quantization; ~309MB
 *                 cached per the published ONNX
 *                 community artifact)
 *   - pooling   : `mean` (the model's recommended
 *                 pooling for the embedding task)
 *   - normalize : `true`
 *   - dim       : `768` (the EmbeddingGemma-300M
 *                 embedding dim)
 */
export interface EmbeddingGemmaEmbedderOptions {
  /**
   * Pinned HF model id. Default:
   * `onnx-community/embeddinggemma-300m-ONNX`.
   */
  modelId?: string;
  /**
   * ONNX dtype for the model. Default: `q8`
   * (8-bit quantization). The 3.x runtime
   * accepts dtype names like `"q8"`, `"q4"`,
   * `"fp16"`, `"fp32"`, `"q4f16"`, etc. The
   * EmbeddingGemma community ONNX artifact is
   * published with a `q8` quantization, so the
   * default is the dtype that artifact targets.
   */
  dtype?: "q8" | "q4" | "fp16" | "fp32" | string;
  /**
   * Pooling strategy. The EmbeddingGemma family
   * uses `mean` pooling for the embedding task
   * (this is the documented default in the
   * model card for retrieval use cases).
   * Default: `mean`. A benchmark that wants to
   * A/B pooling is free to override, but the
   * default is the documented EmbeddingGemma
   * recommendation.
   */
  pooling?: "last_token" | "mean" | "cls" | "none";
  /**
   * Whether to L2-normalize the output vector.
   * The EmbeddingGemma model is trained to
   * produce unit-normalized vectors; the
   * runtime's normalize step matches the
   * reference scoring. Default: `true`.
   */
  normalize?: boolean;
  /**
   * Embedding dim. The EmbeddingGemma-300M model
   * produces 768-dim vectors by default. The
   * `init()` call probes the model output and
   * overwrites the placeholder if the probed
   * dim differs. MRL subdims are out of scope
   * for this benchmark; the default is the full
   * 768-dim output. Default: `768`.
   */
  dim?: number;
  /**
   * Local cache directory for downloaded model
   * artifacts. Default:
   * `<cwd>/.curion/transformers-cache/`. The
   * directory is created on first use; the
   * benchmark runner does not clean it up.
   */
  cacheDir?: string;
  /**
   * The task token used to build the
   * `task: <task> | query: <query>` prefix.
   * The model card documents
   * `"search result"` as the recommended
   * default for retrieval. A benchmark that
   * wants to A/B task strings can override.
   * Default: `"search result"`.
   */
  queryTask?: string;
}

// ---------------------------------------------------------------------------
// Library import helper
// ---------------------------------------------------------------------------

/**
 * The shape of the 3.x feature-extraction
 * pipeline the EmbeddingGemma embedder needs.
 * The library's full type surface is large; we
 * narrow to the call shape the embedder actually
 * uses so the code stays robust against type
 * drift between minor versions.
 *
 * This type is structurally identical to the
 * one in `qwen3-embedder.ts`. The two modules
 * share the same library and the same call
 * surface; they are sibling modules that
 * happen to use the same runtime.
 */
type FeatureExtractionPipeline = (
  input: string | string[],
  options?: {
    pooling?: "last_token" | "mean" | "cls" | "none";
    normalize?: boolean;
  },
) => Promise<unknown>;

/**
 * The shape of the `@huggingface/transformers`
 * module we use. The 3.x API exposes
 * `pipeline(...)` and an `env` configuration
 * object as the two integration points the
 * embedder needs.
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
    // The 3.x `@huggingface/transformers`
    // runtime exposes its version on the `env`
    // object. Older shims (or stubbed test
    // doubles) may not, so the property is
    // optional and the embedder also falls back
    // to the top-level `version` export.
    version?: string;
  };
  version?: string;
}

let cachedLibrary: HfTransformersModule | null = null;

/**
 * Lazy import of `@huggingface/transformers`.
 * The import is hoisted into a helper so the
 * deterministic stub path (and the
 * `--dense-skip` path) does not pay the cost
 * of loading the runtime, and so a missing /
 * broken install does not break the CI
 * deterministic path.
 *
 * The helper is structurally identical to the
 * one in `qwen3-embedder.ts`. The two modules
 * use the same library; a future refactor can
 * extract a shared base when the third
 * candidate lands. For now the two are sibling
 * modules that happen to use the same runtime.
 */
async function loadLibrary(): Promise<HfTransformersModule> {
  if (cachedLibrary) return cachedLibrary;
  // The import target uses the package's main
  // entry point. The 3.x package's main is
  // `src/transformers.js` and is published as a
  // CJS+ESM dual package; under NodeNext module
  // resolution the import resolves to the
  // package main with a `.js` extension
  // inferred. We use a runtime `import()` so
  // missing or broken installs surface as a
  // clean error the benchmark runner can fall
  // back from.
  const mod = (await import(/* @vite-ignore */ "@huggingface/transformers")) as
    | HfTransformersModule
    | { default: HfTransformersModule };
  const resolved: HfTransformersModule =
    "default" in mod ? mod.default : mod;
  cachedLibrary = resolved;
  return resolved;
}

// ---------------------------------------------------------------------------
// EmbeddingGemmaEmbedder
// ---------------------------------------------------------------------------

/**
 * Real local EmbeddingGemma dense embedder.
 *
 * Lazy: the underlying feature-extraction
 * pipeline is constructed on `init()` and
 * cached. The `embedQuery` / `embedDocument`
 * methods are async (the underlying ONNX
 * forward pass is async).
 *
 * Backed by `@huggingface/transformers` 3.x and
 * the `onnx-community/embeddinggemma-300m-ONNX`
 * ONNX artifact. The runtime is lazy-loaded; the
 * model is downloaded once on first use from the
 * Hugging Face CDN and cached on disk.
 *
 * Scope (benchmark-only):
 *   - Not wired into the production
 *     `recall(text)` controller.
 *   - Reachable only through the benchmark
 *     runner.
 *   - Source-tree guards in
 *     `tests/retrieval-dense-embeddinggemma.test.ts`
 *     enforce the whitelist.
 */
export class EmbeddingGemmaEmbedder {
  /**
   * The backend metadata the benchmark runner
   * surfaces on the report. The `status` field
   * follows the same contract as the existing
   * `EmbedderMetadata`: `"ready"` means the
   * embedder actually executed; `"skipped"`
   * means it was not invoked; `"error"` means
   * construction or first use failed and the
   * benchmark fell back to the deterministic
   * stub.
   */
  metadata: import("./dense-embedder.js").EmbedderMetadata;
  private pipeline: FeatureExtractionPipeline | null = null;
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly pooling: "last_token" | "mean" | "cls" | "none";
  private readonly normalize: boolean;
  private readonly cacheDir: string;
  private readonly queryTask: string;
  private readonly probedDim: number;
  private embedCount = 0;
  private embedMs = 0;
  private loadMs = 0;
  private runtimeVersion: string | undefined;
  private failed = false;
  private errorMessage: string | undefined;

  constructor(options: EmbeddingGemmaEmbedderOptions = {}) {
    this.modelId =
      options.modelId ?? "onnx-community/embeddinggemma-300m-ONNX";
    this.dtype = options.dtype ?? "q8";
    this.pooling = options.pooling ?? "mean";
    this.normalize = options.normalize ?? true;
    this.cacheDir =
      options.cacheDir ?? `${process.cwd()}/.curion/transformers-cache`;
    this.queryTask = options.queryTask ?? "search result";
    this.probedDim = options.dim ?? 768;
    // Placeholder metadata. The real status /
    // dim / runtimeVersion are populated in
    // `init()` after the pipeline is built (we
    // cannot know the dim until the model
    // loads).
    this.metadata = {
      backend: "embeddinggemma",
      description:
        `local EmbeddingGemma ONNX embedder via @huggingface/transformers ` +
        `(model=${this.modelId}, dtype=${this.dtype}, ` +
        `pooling=${this.pooling}, normalize=${this.normalize}, ` +
        `dim=${this.probedDim}, queryTask="${this.queryTask}", ` +
        `license=Gemma)`,
      modelId: this.modelId,
      dim: this.probedDim,
      quantized: this.dtype.startsWith("q"),
      cacheDir: this.cacheDir,
      status: "skipped",
    };
  }

  /**
   * Build the feature-extraction pipeline.
   * Idempotent: a second call is a no-op. On
   * error, the embedder is marked
   * `status: "error"` and falls back to the
   * deterministic stub for the rest of the run
   * (so the report shape is preserved and the
   * failure is visible on the metadata).
   */
  async init(): Promise<void> {
    if (this.pipeline) return;
    const t0 = Date.now();
    try {
      const lib = await loadLibrary();
      // The 3.x `@huggingface/transformers`
      // runtime exposes its version on the
      // `env` object (not as a top-level
      // `version` export). Fall back to the
      // top-level export for older shims; the
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
      // output is a 1D vector (mean-pooled,
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
      // We do not throw: the runner expects a
      // usable embedder (the stub fallback will
      // take over when `embed` is called and the
      // pipeline is null).
    }
  }

  /**
   * Build the
   * `task: <task> | query: <query>` prefix
   * the EmbeddingGemma model requires for
   * queries. The function is exported so the
   * unit tests can assert on the exact prefix
   * without going through the runtime.
   *
   * Note: the EmbeddingGemma family uses
   * `task: <task> | query: <query>` (single
   * space around the pipe, no leading space,
   * no trailing space) per the model card's
   * documented prompt format. The function
   * returns the prefixed string verbatim. The
   * benchmark runner does not need to know the
   * format; it just calls `embedQuery` /
   * `embedDocument` and the embedder handles
   * the prefixing.
   */
  static buildQueryPrefix(task: string, query: string): string {
    return `task: ${task} | query: ${query}`;
  }

  /**
   * Build the
   * `title: none | text: <text>` prefix the
   * EmbeddingGemma model requires for
   * documents / passages. The function is
   * exported so the unit tests can assert on
   * the exact prefix without going through the
   * runtime.
   *
   * Note: the model card documents
   * `title: none` as the canonical no-title
   * prefix for retrieval use cases. The
   * function returns the prefixed string
   * verbatim. The benchmark runner does not
   * need to know the format; it just calls
   * `embedDocument` and the embedder handles
   * the prefixing.
   */
  static buildDocumentPrefix(text: string): string {
    return `title: none | text: ${text}`;
  }

  /**
   * Embed a query string. The EmbeddingGemma
   * model requires the
   * `task: <task> | query: <query>` prefix for
   * queries. The function applies the prefix
   * and forwards the prefixed text to the
   * underlying pipeline. The output is a
   * unit-normalized 768-dim vector.
   */
  async embedQuery(text: string): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbed(text);
    }
    const prefixed = EmbeddingGemmaEmbedder.buildQueryPrefix(
      this.queryTask,
      text,
    );
    return this.timedSingle(prefixed);
  }

  /**
   * Embed a document / passage string. The
   * EmbeddingGemma model requires the
   * `title: none | text: <text>` prefix for
   * documents. The function applies the prefix
   * and forwards the prefixed text to the
   * underlying pipeline. The output is a
   * unit-normalized 768-dim vector.
   *
   * Identical to `embed`; the explicit name
   * documents the intent at the call site and
   * matches the `EmbeddingGemmaTextKind` enum.
   */
  async embedDocument(text: string): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbed(text);
    }
    const prefixed = EmbeddingGemmaEmbedder.buildDocumentPrefix(text);
    return this.timedSingle(prefixed);
  }

  /**
   * Batch-embed a list of documents. The
   * `DenseEmbedder` contract: a list of
   * `text -> vector` embeddings. The
   * EmbeddingGemma model processes documents
   * in batch mode (with the `title: none`
   * prefix) by default. The benchmark runner
   * that wants a mixed-mode batch should call
   * `embedQuery` / `embedDocument` per text
   * and assemble the batch manually; the
   * EmbeddingGemma batch helper is
   * intentionally document-only to keep the
   * prefixing contract simple and
   * unit-testable.
   */
  async embedDocumentsBatch(
    texts: ReadonlyArray<string>,
  ): Promise<number[][]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbedBatch(texts);
    }
    const prefixed = texts.map((t) =>
      EmbeddingGemmaEmbedder.buildDocumentPrefix(t),
    );
    return this.timedBatch(prefixed);
  }

  /**
   * `DenseEmbedder.embed` contract. Maps to
   * `embedDocument` (with the `title: none`
   * prefix) so the EmbeddingGemma backend is
   * drop-in compatible with the existing
   * `DenseEmbedder` interface. The benchmark
   * runner that wants query-side prefixing
   * calls `embedQuery` explicitly.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedDocument(text);
  }

  /**
   * `DenseEmbedder.embedBatch` contract. Maps
   * to `embedDocumentsBatch` (with the
   * `title: none` prefix) for the same reason.
   * The benchmark runner that wants
   * mixed-mode batching uses `embedQuery` /
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
      // The library returns a Tensor; the
      // coercion is `number[] | number[][]`
      // because we can't statically narrow. The
      // single-input path is documented to
      // return a 1D vector.
      const arr = Array.isArray(out[0]) ? null : (out as number[]);
      if (!arr) {
        throw new Error(
          "EmbeddingGemmaEmbedder.timedSingle: expected a 1D vector, got a 2D array",
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
      // The library returns a Tensor; the
      // batch path is documented to return a
      // 2D array (one vector per input text).
      // The runtime may also return a flat
      // Float32Array in some configurations; we
      // split the flat shape into per-text
      // vectors using the known EmbeddingGemma
      // dim. (The EmbeddingGemma-300M dim is
      // 768; we use the metadata's dim, which
      // was probed at init time.)
      if (out.length > 0 && Array.isArray(out[0])) {
        return out as number[][];
      }
      const flat = out as number[];
      const dim = this.metadata.dim;
      if (flat.length !== texts.length * dim) {
        throw new Error(
          `EmbeddingGemmaEmbedder.timedBatch: flat output length ${flat.length} does not match ${texts.length} * dim(${dim})`,
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
   * Call the underlying pipeline. The 3.x
   * pipeline returns a Tensor; we convert to
   * a plain JS array (or array of arrays) so
   * the ranker can score it with the same
   * cosine helper the existing
   * `vector-dense` variant uses.
   *
   * The function is intentionally permissive
   * about the return shape: we accept anything
   * that looks like a Tensor with a
   * `toArray()` method, an object with a
   * `data` Float32Array, or a plain nested JS
   * array. The 3.x runtime's tensor API
   * exposes `tensor.data` as a Float32Array
   * and `tensor.toArray()` returns the JS
   * nested array. We prefer `toArray()` when
   * present (it returns the canonical JS
   * shape) and fall back to `.data` for older
   * shapes.
   */
  private async callPipeline(
    input: string | string[],
    options: { pooling?: "last_token" | "mean" | "cls" | "none"; normalize?: boolean },
  ): Promise<number[] | number[][]> {
    if (!this.pipeline) {
      throw new Error(
        "EmbeddingGemmaEmbedder.callPipeline: pipeline is not initialized",
      );
    }
    const raw = await this.pipeline(input, options);
    return coerceToArray(raw);
  }

  /**
   * Fallback embedder used when the pipeline
   * is not initialized (or initialization
   * failed). The fallback is a deterministic
   * `StubDeterministicDenseEmbedder` at the
   * EmbeddingGemma dim. The fallback records
   * `status: "error"` on the metadata so a
   * reviewer can see the live model never ran;
   * the ranker still produces a well-formed
   * report shape.
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
 * Coerce a 3.x pipeline result to a plain JS
 * array of numbers (single text) or array of
 * arrays (batched). The coercion is permissive:
 * it accepts a Tensor with `.toArray()`, an
 * object with a `.data` Float32Array, or a
 * plain nested JS array.
 *
 * The EmbeddingGemma batched output lays out
 * batch-major (text-major): for a batch of `N`
 * texts and `dim` features, the data is an
 * `N * dim` Float32Array where text `i`'s
 * features are at offsets
 * `[i*dim, (i+1)*dim)`. We split it back into
 * per-text arrays.
 *
 * The helper is structurally identical to the
 * one in `qwen3-embedder.ts`. The two modules
 * share the same library and the same call
 * surface; they are sibling modules that
 * happen to use the same runtime.
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
      // We do not know the dim from `.data`
      // alone (it is flat). The caller
      // (`timedBatch`) knows the dim and splits
      // accordingly. We return a flat array
      // here; the caller handles the split.
      return Array.from(data);
    }
  }
  throw new Error(
    `coerceToArray: cannot coerce pipeline output of type ${typeof raw}`,
  );
}
