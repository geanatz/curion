/**
 * Environment configuration. Reads from process.env only.
 *
 * No secrets are stored in this repo.
 *
 * Role-based provider configuration:
 *   - Primary: CURION_PRIMARY_API_KEY, CURION_PRIMARY_BASE_URL,
 *     CURION_PRIMARY_MODEL
 *   - Fallback: CURION_FALLBACK_API_KEY, CURION_FALLBACK_BASE_URL,
 *     CURION_FALLBACK_MODEL (all optional)
 *
 * Provider labels are auto-derived from base URL via known host
 * substrings (openai, groq, openrouter, ollama, lmstudio, nvidia,
 * minimax, custom) when the explicit CURION_*_PROVIDER_LABEL env
 * vars are not set.
 */

export interface CurionEnv {
  /** Minimum log level for the stderr logger. */
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * API key for the primary provider slot.
   * Env: CURION_PRIMARY_API_KEY.
   */
  primaryKey?: string;
  /**
   * API key for the fallback provider slot (opt-in).
   * Env: CURION_FALLBACK_API_KEY.
   */
  fallbackKey?: string;
  /** Project root override. Default: process.cwd(). */
  projectRoot?: string;
  /** Enable semantic retrieval. Default: false (lexical only). */
  semanticEnabled?: boolean;
  /** Allow remote model download for semantic embedder. Default: true. */
  semanticAllowRemote?: boolean;
  /** Local cache directory for semantic embedder model files. */
  semanticCacheDir?: string;
  /** Hugging Face model id for semantic embedder. Default: Xenova/bge-small-en-v1.5. */
  semanticModelId?: string;
}

function readLevel(): CurionEnv["logLevel"] {
  const raw = (process.env.CURION_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export function loadEnv(): CurionEnv {
  return {
    logLevel: readLevel(),
    primaryKey: process.env.CURION_PRIMARY_API_KEY,
    fallbackKey: process.env.CURION_FALLBACK_API_KEY,
    projectRoot: process.env.CURION_PROJECT_ROOT,
    // Semantic retrieval config (off by default).
    semanticEnabled: process.env.CURION_SEMANTIC_ENABLED === "1",
    semanticAllowRemote: process.env.CURION_SEMANTIC_ALLOW_REMOTE !== "0",
    semanticCacheDir: process.env.CURION_SEMANTIC_CACHE_DIR,
    semanticModelId: process.env.CURION_SEMANTIC_MODEL_ID,
  };
}
