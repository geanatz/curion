/**
 * Ambient type declarations for `@huggingface/transformers`.
 *
 * Why this file exists:
 *   The Qwen3 embedder uses the 3.x runtime's
 *   `pipeline(...)` factory and `env` configuration
 *   object. The library does NOT ship with TypeScript
 *   types out of the box (or ships them under a path
 *   that does not match the runtime export surface
 *   the embedder consumes). To keep `tsc` happy
 *   without pulling a separate `@types/...` package
 *   (or pinning a specific library minor), the
 *   embedder narrows the call surface to a small
 *   local interface (`HfTransformersModule`) and this
 *   `.d.ts` file declares that interface as the
 *   library's module shape for the purposes of
 *   `tsc` resolution.
 *
 * Scope:
 *   - This is a TYPE-ONLY stub. It does NOT provide
 *     any runtime behavior. The dynamic
 *     `import("@huggingface/transformers")` in
 *     `qwen3-embedder.ts` resolves to the real
 *     package at runtime; the type assertion is a
 *     narrowing, not a reimplementation.
 *   - The stub declares only the small surface the
 *     embedder uses. A future phase that adds more
 *     library calls (e.g. `AutoTokenizer.from_pretrained`)
 *     can extend the interface; we keep it narrow so
 *     the stub is auditable and so a real
 *     `@types/...` package (when available) can be
 *     swapped in without breaking the embedder.
 *
 * Source-tree scope:
 *   The file lives under `src/benchmark/` and is
 *   only consumed by the benchmark module graph.
 *   The production code (recall controller, server,
 *   tools, providers, safety, storage) does NOT
 *   import this file.
 *
 * Determinism:
 *   The stub is a pure type-only file. It does not
 *   affect runtime behavior. The Qwen3 embedder's
 *   runtime behavior is covered by the unit tests
 *   in `tests/retrieval-dense-qwen3.test.ts` (which
 *   do not require the library to be installed)
 *   and the opt-in live test in
 *   `tests/_helpers/retrieval-dense-qwen3-live.test.ts`
 *   (which does require the library + model).
 */

declare module "@huggingface/transformers" {
  /**
   * Minimal shape of the 3.x feature-extraction
   * pipeline. The library's full type surface is
   * large; we narrow to the call shape the Qwen3
   * embedder actually uses.
   */
  export type FeatureExtractionPipeline = (
    input: string | string[],
    options?: {
      pooling?: "last_token" | "mean" | "cls" | "none";
      normalize?: boolean;
    }
  ) => Promise<unknown>;

  /**
   * The library's `env` configuration object.
   * The Qwen3 embedder writes `cacheDir` and
   * `allowLocalModels` / `allowRemoteModels`.
   */
  export interface HfTransformersEnv {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  }

  /**
   * The library's `pipeline` factory + `env`
   * accessor. The library may also export a
   * `version` string; the embedder reads it
   * opportunistically.
   */
  export function pipeline(
    task: "feature-extraction",
    model: string,
    options?: { dtype?: string; device?: string }
  ): Promise<FeatureExtractionPipeline>;

  export const env: HfTransformersEnv;

  export const version: string | undefined;
}
