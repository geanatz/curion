# Configuration

Curion is configured entirely through environment variables passed by the
parent process (your MCP client, shell, or process manager). Curion does
**not** load `.env` files — secrets must be passed by the parent process.

For client-specific wiring (where these env vars go in `.mcp.json`,
`config.toml`, etc.), see [MCP client setup](mcp-clients.md).

## Required: a primary provider

Curion has **no built-in provider defaults**. You must configure at least a
primary provider to use `remember` and `recall`.

| Variable                  | Description |
|---------------------------|---|
| `CURION_PRIMARY_API_KEY`  | API key for the primary provider. |
| `CURION_PRIMARY_BASE_URL` | Base URL for the primary provider's endpoint. For OpenAI-compatible providers this is the base URL for `/chat/completions`. For Anthropic, this defaults to `https://api.anthropic.com` when `CURION_PRIMARY_API_FORMAT=anthropic` and is not set. |
| `CURION_PRIMARY_MODEL`    | Model id for the primary provider (e.g. `gpt-4o`, or any Anthropic model you have access to). |
| `CURION_PRIMARY_API_FORMAT` | API format: `openai-compatible` (default) or `anthropic`. Controls whether to use the OpenAI-compatible HTTP path or the official Anthropic SDK. |

Optional primary-provider knobs:

| Variable                          | Default           | Description |
|-----------------------------------|-------------------|---|
| `CURION_PRIMARY_PROVIDER_LABEL`   | auto-detected from base URL | Human-readable label used in logs. |
| `CURION_PRIMARY_STRICT_JSON`      | `false`           | Set to `true` to enforce stricter JSON-shape handling for the provider response. |

### Examples

OpenAI-compatible (default format):

```sh
export CURION_PRIMARY_API_KEY=sk-...
export CURION_PRIMARY_BASE_URL=https://api.openai.com/v1
export CURION_PRIMARY_MODEL=gpt-4o
```

Anthropic:

```sh
export CURION_PRIMARY_API_FORMAT=anthropic
export CURION_PRIMARY_API_KEY=sk-ant-...
export CURION_PRIMARY_MODEL=your-anthropic-model
```

## Optional: a fallback provider

The fallback slot is empty by default. To add one, mirror the primary
variables with the `CURION_FALLBACK_` prefix:

```sh
export CURION_FALLBACK_API_KEY=...
export CURION_FALLBACK_BASE_URL=https://api.example.com/v1
export CURION_FALLBACK_MODEL=your-model-id
export CURION_FALLBACK_API_FORMAT=openai-compatible   # or "anthropic"
```

Optional fallback knobs: `CURION_FALLBACK_PROVIDER_LABEL`,
`CURION_FALLBACK_STRICT_JSON`.

## Optional: semantic retrieval

Semantic retrieval is **off by default**. When enabled, Curion runs both
lexical (token-overlap) and semantic (dense vector) retrieval, then fuses the
rankings. This recovers paraphrase matches that the lexical ranker misses.

Enable it with:

```sh
export CURION_SEMANTIC_ENABLED=1
```

| Variable                       | Default                              | Description |
|--------------------------------|--------------------------------------|---|
| `CURION_SEMANTIC_ENABLED`      | `0`                                  | Set to `1` to enable semantic retrieval. |
| `CURION_SEMANTIC_ALLOW_REMOTE` | `1`                                  | Set to `0` to disable Hugging Face CDN model download (requires the model to already be cached locally). |
| `CURION_SEMANTIC_CACHE_DIR`    | `<projectRoot>/.curion/transformers-cache/` | Local model cache directory. |
| `CURION_SEMANTIC_MODEL_ID`     | `Xenova/bge-small-en-v1.5`           | Embedder model id. |

The default embedder (`Xenova/bge-small-en-v1.5`, 384-dim, quantized,
~25 MB) runs entirely on-device (CPU, no GPU). First launch downloads the
ONNX model from Hugging Face CDN and caches it locally.

## Logging

| Variable          | Default | Description |
|-------------------|---------|---|
| `CURION_LOG_LEVEL`| `info`  | Minimum log level: `debug`, `info`, `warn`, `error`. |

Logs are written to **stderr** so they cannot corrupt the MCP protocol
stream on stdout. Set `CURION_LOG_LEVEL=debug` for verbose retrieval and
controller diagnostics.