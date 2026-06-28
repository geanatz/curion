/**
 * Benchmark-only BGE-M3 dense-embedding backend.
 *
 * Why this exists:
 *   BGE-M3 is the next benchmark candidate the
 *   user-approved evidence-first series asks the
 *   project to evaluate behind the existing
 *   `VectorEmbedder` seam, following Qwen3 and
 *   EmbeddingGemma. The BGE-M3 family (BAAI/bge-m3)
 *   is a multilingual, multi-granularity
 *   dense-embedding model. It supports three
 *   retrieval modes (dense, sparse, multi-vector);
 *   this module targets the DENSE mode only, the
 *   same mode the MiniLM / Qwen3 / EmbeddingGemma
 *   backends use. The BGE-M3 model is released as
 *   an ONNX-quantized artifact at `Xenova/bge-m3`
 *   for the Transformers.js / `@huggingface/
 *   transformers` 3.x runtime; the community
 *   Xenova mirror is consumed here.
 *
 *   The BGE-M3 dense mode is the natural
 *   comparison point against Qwen3 (1024-dim)
 *   and EmbeddingGemma (768-dim): the BGE-M3
 *   dense embedding is 1024-dim, multi-lingual,
 *   and trained on a similar retrieval /
 *   semantic-similarity objective. The brief is
 *   explicit: BGE-M3 is **one candidate**, not
 *   assumed best. The "best embedder" decision is
 *   deferred until the same harness produces
 *   measurements for each candidate.
 *
 *   For BGE-M3 dense mode the model card does
 *   NOT require a query-side instruction prefix:
 *   the BGE-M3 family uses no `Instruct:` /
 *   `Query:` template (unlike Qwen3) and no
 *   `task:` / `title:` template (unlike
 *   EmbeddingGemma). The BGE-M3 dense mode is
 *   a kind-agnostic embedder: queries and
 *   documents are forwarded verbatim. The
 *   `BgeM3Embedder` therefore implements the
 *   `embedQuery` / `embedDocument` methods as
 *   plain forwarders (with the same kind-aware
 *   interface Qwen3 / EmbeddingGemma use), so
 *   the ranker's `kind: "query"` dispatch path
 *   still routes the query through `embedQuery`
 *   (a kind-aware embedder) and the documents
 *   through `embedBatch`. The kind distinction
 *   is additive: a benchmark that does not
 *   care about it can keep calling
 *   `embed` / `embedBatch`.
 *
 * Execution regime (LOCAL, no external API):
 *   - `BgeM3Embedder` is the real local semantic
 *     embedder. The library is loaded lazily on
 *     the first `init()` call; the pipeline is
 *     cached on the instance.
 *   - The default pinned model is
 *     `Xenova/bge-m3` (the same model the
 *     `transformers.js` v2.17 community mirrors
 *     use; mirrored for `@huggingface/transformers`
 *     3.x). The model is downloaded once from the
 *     Hugging Face CDN and cached on disk.
 *   - Pooling: `cls` (the BGE-M3 dense mode
 *     defaults to CLS pooling per the model card).
 *   - Normalize: `true` (the BGE-M3 dense mode
 *     is trained to produce unit-normalized
 *     vectors; cosine similarity is the natural
 *     score scale).
 *   - Dim: 1024 (the BGE-M3 dense embedding dim).
 *   - Context: 8192 tokens (the BGE-M3 maximum
 *     input length, longer than Qwen3's 32k but
 *     the dense mode is the relevant knob for
 *     short-form retrieval).
 *   - License: MIT (the BGE-M3 model is released
 *     under the MIT license, the most permissive
 *     of the three candidates' licenses). The
 *     `description` field on the embedder's
 *     metadata surfaces the license abbreviation
 *     so a reviewer can audit it on the artifact.
 *
 * What this is NOT:
 *   - It is NOT wired into the production
 *     `recall(text)` controller. The
 *     benchmark-only runner is the only consumer.
 *     The public MCP API is unchanged (exactly
 *     `remember(text)` and `recall(text)`).
 *   - It is NOT a replacement for the MiniLM /
 *     Qwen3 / EmbeddingGemma backend. BGE-M3 is
 *     opt-in via the `--embedder bge-m3` (or
 *     `bgem3`) CLI flag; the default benchmark
 *     path stays on the MiniLM / stub backend.
 *     BGE-M3 is a sibling candidate in the
 *     evidence-first series; all four candidates
 *     (MiniLM, Qwen3, EmbeddingGemma, BGE-M3)
 *     may be benchmarked, one at a time, on the
 *     same harness.
 *   - It is NOT the BGE-M3 multi-vector
 *     (ColBERT-style late-interaction) mode. The
 *     module targets the dense mode only; the
 *     multi-vector mode would require a
 *     different ranker and a different report
 *     shape, and is out of scope for this
 *     benchmark candidate.
 *   - It is NOT an external API. No remote
 *     inference is performed. The first-run
 *     model download is the only network call
 *     and it is to the Hugging Face CDN.
 *
 * Determinism:
 *   The `BgeM3Embedder` is deterministic for a
 *   given (text, kind, model, ONNX runtime). The
 *   `@huggingface/transformers` runtime is
 *   bit-deterministic for a fixed input and a
 *   fixed thread count. The benchmark runner
 *   asserts this in a deterministic test that
 *   runs the embedder twice on the same input
 *   and checks the cosine of the outputs is 1.0.
 *
 * Score scale:
 *   The BGE-M3 backend produces L2-normalized
 *   vectors. Cosine similarity is in [-1, 1];
 *   for non-negative inputs the score is in
 *   [0, 1]. The same cosine scoring the existing
 *   dense vector variant uses is the natural
 *   score scale for this backend too.
 *
 * No-answer TNR:
 *   The default threshold is 0 (no filter), the
 *   same default the FTS5 / vector-hash /
 *   vector-dense variants use. Callers that
 *   want stricter abstention can pass a positive
 *   threshold.
 *
 * Why a new module (not an extension of the
 * existing `dense-embedder.ts`,
 * `qwen3-embedder.ts`, or
 * `embeddinggemma-embedder.ts`):
 *   BGE-M3 has a fundamentally different shape
 *   from the existing backends:
 *   - Default pooling is `cls` (vs MiniLM `mean`
 *     and Qwen3 `last_token`); the BGE-M3 dense
 *     mode is documented to use CLS pooling.
 *   - No prompt template (vs Qwen3's
 *     `Instruct:` / `Query:` and EmbeddingGemma's
 *     `task:` / `title: none`); BGE-M3 dense mode
 *     is kind-agnostic. The kind-aware interface
 *     is preserved (the `embedQuery` /
 *     `embedDocument` methods exist) so the
 *     ranker's `kind: "query"` dispatch path
 *     keeps working unchanged.
 *   - 1024-dim (same dim as Qwen3; vs
 *     EmbeddingGemma's 768 and MiniLM's 384).
 *   - MIT license (vs Qwen3 Apache-2.0 and
 *     EmbeddingGemma Gemma Terms of Use).
 *
 *   The new module implements the same
 *   `DenseEmbedder` interface the existing
 *   backends do, so the benchmark runner's
 *   `createDenseEmbedder` factory can return any
 *   of the implementations behind the same spec
 *   string. The `embedQuery` / `embedDocument`
 *   distinction is additive: a benchmark that
 *   does not need it can keep calling `embed` /
 *   `embedBatch` (which the BGE-M3 backend maps
 *   to `embedDocument` for backward
 *   compatibility).
 *
 *   The shared `@huggingface/transformers`
 *   boilerplate (lazy load, env/cache config,
 *   pipeline init, runtimeVersion probe, output
 *   coercion, fallback stub, embed timing) is
 *   intentionally NOT extracted into a base
 *   class in this commit. The Qwen3 /
 *   EmbeddingGemma / BGE-M3 modules are
 *   small and self-contained; extracting a base
 *   class would couple three candidates that
 *   the evidence-first comparison philosophy
 *   intends to keep independent. The three
 *   modules share the same library version
 *   policy, the same `FeatureExtractionPipeline`
 *   narrowing, and the same `coerceToArray`
 *   helper shape, but they do NOT import each
 *   other. A future refactor can extract the
 *   shared base when the duplication is the
 *   right size to pay the abstraction cost.
 *
 * Source-tree scope:
 *   The module lives under
 *   `src/benchmark/variants/bge-m3-embedder.ts`
 *   and is imported only by the benchmark
 *   directory. The production `recall(text)`
 *   controller, the public MCP API, the
 *   controller, the storage layer, the safety
 *   layer, and the providers do NOT import
 *   this module. The source-tree guard in
 *   `tests/retrieval-dense-bge-m3.test.ts`
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
 *   structurally identical to the Qwen3 /
 *   EmbeddingGemma modules') converts the
 *   tensor to a plain JS array. The pooling /
 *   normalize options are forwarded as the
 *   second argument to the pipeline. We narrow
 *   the `pipeline(...)` call to a small local
 *   type (`FeatureExtractionPipeline`) so the
 *   embedder code stays robust against type
 *   drift between minor versions of the
 *   library.
 *
 *   Note: the `pipeline` function in 3.x
 *   returns a Promise. The lazy `loadLibrary`
 *   helper awaits the import + the pipeline
 *   build.
 *
 *   Note: the `BgeM3Embedder` and the
 *   `Qwen3Embedder` and the
 *   `EmbeddingGemmaEmbedder` use the same
 *   library and the same
 *   `FeatureExtractionPipeline` narrowing; a
 *   future refactor can extract a shared base
 *   when the duplication is the right size to
 *   pay the abstraction cost. For now the
 *   three are sibling modules that happen to
 *   use the same runtime.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two text kinds the BGE-M3 dense mode
 * distinguishes:
 *   - "query"    — the user query string. The
 *                  BGE-M3 dense mode is kind-
 *                  agnostic: no prefix is
 *                  applied. The `embedQuery`
 *                  method exists so the
 *                  ranker's `kind: "query"`
 *                  dispatch path can route
 *                  the query through the
 *                  kind-aware method (forwarded
 *                  to the underlying pipeline
 *                  verbatim).
 *   - "document" — a corpus / passage string.
 *                  Same as the query side: no
 *                  prefix is applied. The
 *                  `embedDocument` method
 *                  exists for the same
 *                  dispatch-ergonomics reason.
 *
 * The default kind is "document" so a caller
 * that passes a plain string into the `embed`
 * / `embedBatch` helpers (the `DenseEmbedder`
 * contract) gets the document behavior. The
 * benchmark runner calls `embedQuery` explicitly
 * for the user query.
 */
export type BgeM3TextKind = "query" | "document";

/**
 * Configuration for the BGE-M3 embedder.
 * All fields are optional; the defaults are
 * the pinned model + the on-disk cache
 * directory under
 * `.curion/transformers-cache/`.
 *
 * The defaults match the user's approved
 * research brief:
 *   - modelId   : `Xenova/bge-m3`
 *   - dtype     : `q8` (8-bit quantization;
 *                 ~568MB cached per the
 *                 published Xenova mirror)
 *   - pooling   : `cls` (the BGE-M3 dense
 *                 mode's documented pooling)
 *   - normalize : `true`
 *   - dim       : `1024` (the BGE-M3 dense
 *                 embedding dim)
 *   - license   : MIT (the BGE-M3 model is
 *                 released under the MIT
 *                 license)
 */
export interface BgeM3EmbedderOptions {
  /**
   * Pinned HF model id. Default:
   * `Xenova/bge-m3`. The Xenova mirror is
   * the same artifact the `@huggingface/
   * transformers` 3.x runtime consumes.
   */
  modelId?: string;
  /**
   * ONNX dtype for the model. Default: `q8`
   * (8-bit quantization). The 3.x runtime
   * accepts dtype names like `"q8"`, `"q4"`,
   * `"fp16"`, `"fp32"`, `"q4f16"`, etc. The
   * BGE-M3 Xenova mirror is published with a
   * `q8` quantization, so the default is the
   * dtype that artifact targets. The
   * `dtype` field is forwarded as-is to the
   * `pipeline(...)` call; a benchmark that
   * wants a different dtype is free to
   * override.
   */
  dtype?: "q8" | "q4" | "fp16" | "fp32" | string;
  /**
   * Pooling strategy. The BGE-M3 dense mode
   * uses CLS pooling. Default: `cls`. A
   * benchmark that wants to A/B pooling is
   * free to override, but the default is the
   * documented BGE-M3 dense mode
   * recommendation.
   */
  pooling?: "last_token" | "mean" | "cls" | "none";
  /**
   * Whether to L2-normalize the output
   * vector. The BGE-M3 dense mode is
   * trained to produce unit-normalized
   * vectors; the runtime's normalize step
   * matches the reference scoring. Default:
   * `true`.
   */
  normalize?: boolean;
  /**
   * Embedding dim. The BGE-M3 dense mode
   * produces 1024-dim vectors by default.
   * The `init()` call probes the model
   * output and overwrites the placeholder
   * if the probed dim differs. Default:
   * `1024`.
   */
  dim?: number;
  /**
   * Local cache directory for downloaded
   * model artifacts. Default:
   * `<cwd>/.curion/transformers-cache/`.
   * The directory is created on first use;
   * the benchmark runner does not clean it
   * up.
   */
  cacheDir?: string;
}

// ---------------------------------------------------------------------------
// Library import helper
// ---------------------------------------------------------------------------

/**
 * The shape of the 3.x feature-extraction
 * pipeline the BGE-M3 embedder needs. The
 * library's full type surface is large; we
 * narrow to the call shape the embedder
 * actually uses so the code stays robust
 * against type drift between minor versions.
 *
 * This type is structurally identical to the
 * one in `qwen3-embedder.ts` and
 * `embeddinggemma-embedder.ts`. The three
 * modules share the same library and the same
 * call surface; they are sibling modules that
 * happen to use the same runtime.
 */
type FeatureExtractionPipeline = (
  input: string | string[],
  options?: {
    pooling?: "last_token" | "mean" | "cls" | "none";
    normalize?: boolean;
  }
) => Promise<unknown>;

/**
 * The shape of the
 * `@huggingface/transformers` module we use.
 * The 3.x API exposes `pipeline(...)` and an
 * `env` configuration object as the two
 * integration points the embedder needs.
 */
interface HfTransformersModule {
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: { dtype?: string; device?: string }
  ) => Promise<FeatureExtractionPipeline>;
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    // The 3.x `@huggingface/transformers`
    // runtime exposes its version on the `env`
    // object. Older shims (or stubbed test
    // doubles) may not, so the property is
    // optional and the embedder also falls
    // back to the top-level `version` export.
    version?: string;
  };
  version?: string;
}

let cachedLibrary: HfTransformersModule | null = null;

/**
 * Lazy import of
 * `@huggingface/transformers`. The import is
 * hoisted into a helper so the deterministic
 * stub path (and the `--dense-skip` path) does
 * not pay the cost of loading the runtime, and
 * so a missing / broken install does not break
 * the CI deterministic path.
 *
 * The helper is structurally identical to the
 * one in `qwen3-embedder.ts` and
 * `embeddinggemma-embedder.ts`. The three
 * modules use the same library; a future
 * refactor can extract a shared base when the
 * fourth candidate lands. For now the three
 * are sibling modules that happen to use the
 * same runtime.
 */
async function loadLibrary(): Promise<HfTransformersModule> {
  if (cachedLibrary) return cachedLibrary;
  // The import target uses the package's
  // main entry point. The 3.x package's main
  // is `src/transformers.js` and is published
  // as a CJS+ESM dual package; under NodeNext
  // module resolution the import resolves to
  // the package main with a `.js` extension
  // inferred. We use a runtime `import()` so
  // missing or broken installs surface as a
  // clean error the benchmark runner can fall
  // back from.
  const mod = (await import(/* @vite-ignore */ "@huggingface/transformers")) as
    | HfTransformersModule
    | { default: HfTransformersModule };
  const resolved: HfTransformersModule = "default" in mod ? mod.default : mod;
  cachedLibrary = resolved;
  return resolved;
}

// ---------------------------------------------------------------------------
// BgeM3Embedder
// ---------------------------------------------------------------------------

/**
 * Real local BGE-M3 dense embedder.
 *
 * Lazy: the underlying feature-extraction
 * pipeline is constructed on `init()` and
 * cached. The `embedQuery` / `embedDocument`
 * methods are async (the underlying ONNX
 * forward pass is async).
 *
 * Backed by `@huggingface/transformers` 3.x
 * and the `Xenova/bge-m3` ONNX artifact. The
 * runtime is lazy-loaded; the model is
 * downloaded once on first use from the
 * Hugging Face CDN and cached on disk.
 *
 * The BGE-M3 dense mode is kind-agnostic
 * (no instruction prefix on either side);
 * the `embedQuery` / `embedDocument`
 * methods are plain forwarders to the
 * underlying pipeline so the ranker's
 * `kind: "query"` dispatch path still
 * routes the query through `embedQuery` and
 * the documents through `embedBatch`.
 *
 * Scope (benchmark-only):
 *   - Not wired into the production
 *     `recall(text)` controller.
 *   - Reachable only through the benchmark
 *     runner.
 *   - Source-tree guards in
 *     `tests/retrieval-dense-bge-m3.test.ts`
 *     enforce the whitelist.
 */
export class BgeM3Embedder {
  /**
   * The backend metadata the benchmark
   * runner surfaces on the report. The
   * `status` field follows the same contract
   * as the existing `EmbedderMetadata`:
   * `"ready"` means the embedder actually
   * executed; `"skipped"` means it was not
   * invoked; `"error"` means construction or
   * first use failed and the benchmark fell
   * back to the deterministic stub.
   */
  metadata: import("./dense-embedder.js").EmbedderMetadata;
  private pipeline: FeatureExtractionPipeline | null = null;
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly pooling: "last_token" | "mean" | "cls" | "none";
  private readonly normalize: boolean;
  private readonly cacheDir: string;
  private readonly probedDim: number;
  private embedCount = 0;
  private embedMs = 0;
  private loadMs = 0;
  private runtimeVersion: string | undefined;
  private failed = false;
  private errorMessage: string | undefined;

  constructor(options: BgeM3EmbedderOptions = {}) {
    this.modelId = options.modelId ?? "Xenova/bge-m3";
    this.dtype = options.dtype ?? "q8";
    this.pooling = options.pooling ?? "cls";
    this.normalize = options.normalize ?? true;
    this.cacheDir = options.cacheDir ?? `${process.cwd()}/.curion/transformers-cache`;
    this.probedDim = options.dim ?? 1024;
    // Placeholder metadata. The real status /
    // dim / runtimeVersion are populated in
    // `init()` after the pipeline is built (we
    // cannot know the dim until the model
    // loads).
    this.metadata = {
      backend: "bge-m3",
      description:
        `local BGE-M3 ONNX embedder via @huggingface/transformers ` +
        `(model=${this.modelId}, dtype=${this.dtype}, ` +
        `pooling=${this.pooling}, normalize=${this.normalize}, ` +
        `dim=${this.probedDim}, license=MIT)`,
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
   * deterministic stub for the rest of the
   * run (so the report shape is preserved
   * and the failure is visible on the
   * metadata).
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
      // resulting string is what the live
      // test asserts on.
      this.runtimeVersion = lib.env?.version ?? lib.version ?? undefined;
      if (lib.env) {
        lib.env.cacheDir = this.cacheDir;
        lib.env.allowLocalModels = true;
        lib.env.allowRemoteModels = true;
      }
      this.pipeline = await lib.pipeline("feature-extraction", this.modelId, { dtype: this.dtype });
      // Probe the dim with a 1-token string.
      // The output is a 1D vector
      // (CLS-pooled, normalized). We throw
      // away the values; we just want the
      // length.
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
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.loadMs = Date.now() - t0;
      this.metadata = {
        ...this.metadata,
        status: "error",
        errorMessage: this.errorMessage,
        loadMs: this.loadMs,
      };
      // We do not throw: the runner expects
      // a usable embedder (the stub fallback
      // will take over when `embed` is called
      // and the pipeline is null).
    }
  }

  /**
   * Embed a query string. The BGE-M3 dense
   * mode is kind-agnostic: no instruction
   * prefix is applied. The method exists
   * for the ranker's `kind: "query"`
   * dispatch path (so the BGE-M3 backend is
   * detected as a kind-aware embedder at the
   * call site). The output is a
   * unit-normalized 1024-dim vector.
   */
  async embedQuery(text: string): Promise<number[]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbed(text);
    }
    return this.timedSingle(text);
  }

  /**
   * Embed a document / passage string.
   * Identical to `embedQuery` (the BGE-M3
   * dense mode is kind-agnostic). The
   * explicit name documents the intent at
   * the call site and matches the
   * `BgeM3TextKind` enum.
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
   * `text -> vector` embeddings. The
   * BGE-M3 dense mode processes documents
   * in batch mode (no prefix, verbatim) by
   * default. The benchmark runner that
   * wants a mixed-mode batch should call
   * `embedQuery` / `embedDocument` per text
   * and assemble the batch manually; the
   * BGE-M3 batch helper is intentionally
   * document-only to keep the contract
   * simple and unit-testable.
   */
  async embedDocumentsBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
    if (!this.pipeline || this.failed) {
      return this.fallbackEmbedBatch(texts);
    }
    return this.timedBatch([...texts]);
  }

  /**
   * `DenseEmbedder.embed` contract. Maps to
   * `embedDocument` so the BGE-M3 backend is
   * drop-in compatible with the existing
   * `DenseEmbedder` interface. The benchmark
   * runner that wants query-side handling
   * calls `embedQuery` explicitly.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedDocument(text);
  }

  /**
   * `DenseEmbedder.embedBatch` contract. Maps
   * to `embedDocumentsBatch` for the same
   * reason. The benchmark runner that wants
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
      // because we can't statically narrow.
      // The single-input path is documented
      // to return a 1D vector.
      const arr = Array.isArray(out[0]) ? null : (out as number[]);
      if (!arr) {
        throw new Error("BgeM3Embedder.timedSingle: expected a 1D vector, got a 2D array");
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
      // Float32Array in some configurations;
      // we split the flat shape into per-text
      // vectors using the known BGE-M3 dim.
      // (The BGE-M3 dense dim is 1024; we
      // use the metadata's dim, which was
      // probed at init time.)
      if (out.length > 0 && Array.isArray(out[0])) {
        return out as number[][];
      }
      const flat = out as number[];
      const dim = this.metadata.dim;
      if (flat.length !== texts.length * dim) {
        throw new Error(
          `BgeM3Embedder.timedBatch: flat output length ${flat.length} does not match ${texts.length} * dim(${dim})`
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
   * pipeline returns a Tensor; we convert
   * to a plain JS array (or array of
   * arrays) so the ranker can score it with
   * the same cosine helper the existing
   * `vector-dense` variant uses.
   *
   * The function is intentionally permissive
   * about the return shape: we accept
   * anything that looks like a Tensor with
   * a `toArray()` method, an object with a
   * `data` Float32Array, or a plain nested
   * JS array. The 3.x runtime's tensor API
   * exposes `tensor.data` as a Float32Array
   * and `tensor.toArray()` returns the JS
   * nested array. We prefer `toArray()` when
   * present (it returns the canonical JS
   * shape) and fall back to `.data` for
   * older shapes.
   */
  private async callPipeline(
    input: string | string[],
    options: { pooling?: "last_token" | "mean" | "cls" | "none"; normalize?: boolean }
  ): Promise<number[] | number[][]> {
    if (!this.pipeline) {
      throw new Error("BgeM3Embedder.callPipeline: pipeline is not initialized");
    }
    const raw = await this.pipeline(input, options);
    return coerceToArray(raw);
  }

  /**
   * Fallback embedder used when the pipeline
   * is not initialized (or initialization
   * failed). The fallback is a deterministic
   * `StubDeterministicDenseEmbedder` at the
   * BGE-M3 dim. The fallback records
   * `status: "error"` on the metadata so a
   * reviewer can see the live model never
   * ran; the ranker still produces a
   * well-formed report shape.
   */
  private async fallbackEmbed(text: string): Promise<number[]> {
    const { StubDeterministicDenseEmbedder } = await import("./dense-embedder.js");
    return new StubDeterministicDenseEmbedder({
      dim: this.metadata.dim,
    }).embed(text);
  }

  private async fallbackEmbedBatch(texts: ReadonlyArray<string>): Promise<number[][]> {
    const { StubDeterministicDenseEmbedder } = await import("./dense-embedder.js");
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
 * The BGE-M3 batched output lays out
 * batch-major (text-major): for a batch of `N`
 * texts and `dim` features, the data is an
 * `N * dim` Float32Array where text `i`'s
 * features are at offsets `[i*dim, (i+1)*dim)`.
 * We split it back into per-text arrays.
 *
 * The helper is structurally identical to the
 * one in `qwen3-embedder.ts` and
 * `embeddinggemma-embedder.ts`. The three
 * modules share the same library and the same
 * call surface; they are sibling modules that
 * happen to use the same runtime.
 */
function coerceToArray(raw: unknown): number[] | number[][] {
  // Plain nested JS array (the canonical
  // 3.x shape): pass through.
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
      // (`timedBatch`) knows the dim and
      // splits accordingly. We return a flat
      // array here; the caller handles the
      // split.
      return Array.from(data);
    }
  }
  throw new Error(`coerceToArray: cannot coerce pipeline output of type ${typeof raw}`);
}
