/**
 * Shared test provider configuration.
 *
 * These values are used by tests that need to exercise the
 * recall or remember controller with explicit provider config.
 * The provider label is derived from the base URL, so these
 * use neutral URLs that resolve to "custom".
 *
 * No vendor defaults: all provider slots are empty unless
 * explicitly configured via these helpers.
 */

// ---------------------------------------------------------------------------
// Neutral test values (provider label derived from base URL)
// ---------------------------------------------------------------------------

/** Test primary API key (placeholder, no network access in tests). */
export const TEST_PRIMARY_KEY = "sk-test-primary-not-real-12345";
/** Test fallback API key (placeholder, no network access in tests). */
export const TEST_FALLBACK_KEY = "sk-test-fallback-not-real-12345";
/** Test primary base URL (resolves to "custom" provider label). */
export const TEST_PRIMARY_BASE_URL = "https://api.example.com/v1";
/** Test fallback base URL (resolves to "custom" provider label). */
export const TEST_FALLBACK_BASE_URL = "https://api.fallback.example/v1";
/** Test primary model id. */
export const TEST_PRIMARY_MODEL = "test/model-primary";
/** Test fallback model id. */
export const TEST_FALLBACK_MODEL = "test/model-fallback";

/**
 * Keys that should be cleaned up by tests that modify process.env.
 * Includes both generic role-based names and legacy vendor-specific names.
 */
export const TEST_ENV_KEYS = [
  // Generic role-based (canonical)
  "CURION_PRIMARY_API_KEY",
  "CURION_FALLBACK_API_KEY",
  "CURION_PRIMARY_BASE_URL",
  "CURION_PRIMARY_MODEL",
  "CURION_FALLBACK_BASE_URL",
  "CURION_FALLBACK_MODEL",
  "CURION_PRIMARY_PROVIDER_LABEL",
  "CURION_FALLBACK_PROVIDER_LABEL",
  "CURION_ADAPTER_TIMEOUT_MS",
  "CURION_ADAPTER_MAX_TOKENS",
  // Legacy vendor-specific (backward compat only)
  "CURION_PROVIDER_PRIMARY_KEY",
  "MINIMAX_API_KEY",
  "CURION_PROVIDER_FALLBACK_KEY",
  "NVIDIA_NIM_API_KEY",
  "CURION_NIM_BASE_URL",
  "CURION_NIM_FALLBACK_MODEL",
  "CURION_MINIMAX_BASE_URL",
  "CURION_MINIMAX_MODEL",
] as const;
