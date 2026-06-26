# Dense Embedder Reference

> Source: [`src/benchmark/variants/dense-embedder.ts`](../variants/dense-embedder.ts) · Interface version: `1.0.0`

## DenseEmbedder interface

All dense embedder implementations satisfy the `DenseEmbedder` contract:

```typescript
interface DenseEmbedder {
  init(): Promise<void>;
  embed(text: string, kind: "query" | "document"): Promise<float32>;
  embedBatch(texts: string[], kind: "query" | "document"): Promise<float32[]>;
  metadata: EmbedderMetadata;
}
```

## Embedder implementations

| Embedder | Flag | License | Notes |
|---|---|---|---|
| `StubDeterministicDenseEmbedder` | `stub-dense` | — | Dependency-free deterministic projection (feature hashing + L2). Default. CI-friendly, no model download. Dim configurable (`stub-dense:dim=128`). |
| `TransformersJsEmbedder` | `transformersjs` | Apache-2.0 | Real local ONNX via `@xenova/transformers`. Default model: `Xenova/all-MiniLM-L6-v2` (384-dim, ~25MB). |
| `Qwen3Embedder` | `qwen3` / `qwen3-hf` | Apache-2.0 | `onnx-community/Qwen3-Embedding-0.6B-ONNX` (1024-dim, q8, ~600MB). Instruction-tuned, last-token pooling. |
| `EmbeddingGemmaEmbedder` | `embeddinggemma` / `embedding-gemma` | **Gemma Terms of Use** | `onnx-community/embeddinggemma-300m-ONNX` (768-dim, q8, ~309MB). Mean pooling. Research-only license. |
| `BgeM3Embedder` | `bge-m3` / `bgem3` | MIT | `Xenova/bge-m3` (1024-dim, q8, ~568MB). CLS pooling, kind-agnostic (no prompt prefix). |

## CLI flags

| Flag | Default | Notes |
|---|---|---|
| `--variant vector-dense` / `hybrid-dense` / `all-dense` | `lexical` | Async dense variants. Sync `runRetrievalBenchmark` throws on them. |
| `--embedder stub-dense` | `stub-dense` | Deterministic, no model download. |
| `--embedder stub-dense:dim=N` | `dim=64` | Stub with a custom dim. |
| `--embedder transformersjs` | `Xenova/all-MiniLM-L6-v2` (quantized) | Real local ONNX embedder. |
| `--embedder transformersjs:model=<id>,quantized=true\|false` | — | Custom model id / quantization. |
| `--embedder embeddinggemma` | `onnx-community/embeddinggemma-300m-ONNX` (q8) | Real local EmbeddingGemma-300M ONNX. License: Gemma. |
| `--embedder embeddinggemma:model=<id>,dtype=<q8\|q4\|fp16\|fp32>,queryTask=<text>,pooling=<mean\|last_token\|cls\|none>` | — | Custom EmbeddingGemma model id / dtype / query task / pooling. |
| `--embedder embedding-gemma` | — | Alias for `--embedder embeddinggemma`. |
| `--embedder bge-m3` | `Xenova/bge-m3` (q8) | Real local BGE-M3 ONNX. License: MIT. |
| `--embedder bge-m3:model=<id>,dtype=<q8\|q4\|fp16\|fp32>,pooling=<cls\|last_token\|mean\|none>` | — | Custom BGE-M3 model id / dtype / pooling. |
| `--embedder bgem3` | — | Alias for `--embedder bge-m3`. |
| `--dense-cache-dir <path>` | `<cwd>/.curion/transformers-cache/` | Local model cache directory. |
| `--dense-skip` | off | Skip live model execution. Factory still dispatches by `--embedder` spec; falls back to deterministic stub at embed time. Reports `status: "skipped"` on metadata. Useful for CI without network. |

## Embedder metadata

Every embedder reports a `metadata` block on the report:

```json
"config": {
  "embeddingBackend": {
    "backend":       "transformersjs",
    "modelId":       "Xenova/all-MiniLM-L6-v2",
    "dim":           384,
    "quantized":     true,
    "runtimeVersion": "2.17.2",
    "status":        "ready",
    "loadMs":        898,
    "embedMs":       20702,
    "embedCount":    3294,
    "cacheDir":      "<cwd>/.curion/transformers-cache"
  }
}
```

### Status values

- `"ready"` — the embedder executed the queries / corpus during the benchmark.
- `"skipped"` — `--dense-skip` was passed; the embedder did not execute. Falls back to the deterministic stub.
- `"error"` — `init()` failed (network error, missing library, or model load error). Falls back to the deterministic stub so the report shape is preserved. Error message is on `errorMessage`.

## Prompt templates (query vs document)

| Embedder | Query prompt | Document prompt |
|---|---|---|
| MiniLM (`transformersjs`) | none (kind-agnostic) | none |
| Qwen3 | `Instruct: <task>\nQuery:<query>` | unprefixed |
| EmbeddingGemma | `task: <task> | query: <query>` | `title: none | text: <text>` |
| BGE-M3 | none (kind-agnostic) | none |
| Stub | none | none |

## Quick reference: running dense benchmarks

```sh
# Deterministic stub (default; no model download; CI-friendly)
npm run benchmark:retrieval:vector-dense
npm run benchmark:retrieval:hybrid-dense
npm run benchmark:retrieval:all-dense

# Real local model (first run downloads ~25MB to .curion/transformers-cache)
npm run benchmark:retrieval:vector-dense:real
npm run benchmark:retrieval:hybrid-dense:real
npm run benchmark:retrieval:all-dense:real

# Skip the model execution explicitly (deterministic-only)
npm run benchmark:retrieval:vector-dense:skip

# Qwen3 dense-embedding candidate (experimental; first run downloads ~600MB q8 ONNX)
npm run benchmark:retrieval:vector-dense:qwen3
npm run benchmark:retrieval:hybrid-dense:qwen3
npm run benchmark:retrieval:all-dense:qwen3
npm run benchmark:retrieval:held-out:hybrid-dense:qwen3

# EmbeddingGemma dense-embedding candidate (experimental; first run downloads ~309MB q8 ONNX)
npm run benchmark:retrieval:vector-dense:embeddinggemma
npm run benchmark:retrieval:hybrid-dense:embeddinggemma
npm run benchmark:retrieval:all-dense:embeddinggemma
npm run benchmark:retrieval:held-out:hybrid-dense:embeddinggemma

# BGE-M3 dense-embedding candidate (experimental; first run downloads ~568MB q8 ONNX)
npm run benchmark:retrieval:vector-dense:bge-m3
npm run benchmark:retrieval:hybrid-dense:bge-m3
npm run benchmark:retrieval:all-dense:bge-m3
npm run benchmark:retrieval:held-out:hybrid-dense:bge-m3
```
