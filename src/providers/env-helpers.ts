function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read an env var and trim it. Whitespace-only values are treated
 * as missing and return `""` so the caller can fall through to the
 * next candidate / default. The returned value is trimmed.
 */
function readTrimmedString(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string") return "";
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : "";
}

/**
 * Pick the first non-empty string from the candidates. Strings
 * that are empty or whitespace-only are treated as "absent" so
 * callers can pass `""` (or `"   "`) from an unset / blank env
 * var and still get the next candidate or fallback default.
 * Returned values are trimmed.
 */
function pickTrimmedString(...candidates: string[]): string {
  for (const c of candidates) {
    if (typeof c === "string") {
      const trimmed = c.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "";
}

/**
 * Parse an API format string. Returns "openai-compatible" for any
 * unrecognized value so that missing env vars default to the
 * safe backwards-compatible behavior.
 */
function readApiFormatValue(name: string): "openai-compatible" | "anthropic" {
  const raw = readTrimmedString(name);
  if (raw === "anthropic") return "anthropic";
  return "openai-compatible";
}

/**
 * Shared adapter configuration shape. Includes every field that
 * either the memory-analysis or the recall-synthesis role may
 * resolve from environment variables. The strict-JSON fields
 * (`primaryStrictJson`, `fallbackStrictJson`) are populated only
 * when the calling role opts in via `opts.strictJson`; roles
 * that don't use strict JSON still receive them (set to false)
 * so a single shared helper can drive both roles.
 */
export interface AdapterRoleConfig {
  primaryBaseUrl: string;
  primaryModel: string;
  primaryProviderLabel: string;
  primaryApiFormat: "openai-compatible" | "anthropic";
  primaryStrictJson: boolean;
  fallbackBaseUrl: string;
  fallbackModel: string;
  fallbackProviderLabel: string;
  fallbackApiFormat: "openai-compatible" | "anthropic";
  fallbackStrictJson: boolean;
  primaryApiKey: string;
  fallbackApiKey: string;
  timeoutMs: number;
  maxTokens: number;
}

export interface LoadRoleConfigOpts {
  defaults: { timeoutMs: number; maxTokens: number };
  /**
   * Whether this role reads the `CURION_*_STRICT_JSON` env vars.
   * `true` for memory-analysis (uses strict JSON mode), `false`
   * for recall-synthesis (does not use strict JSON at all).
   * When `false`, the returned `primaryStrictJson` /
   * `fallbackStrictJson` fields are always `false` regardless of
   * the env vars — preserving the pre-refactor recall behavior
   * where these env vars were never consulted.
   */
  strictJson: boolean;
  /**
   * Optional overrides that take precedence over env values. The
   * override merging matches the pre-refactor per-role logic:
   * explicit overrides win, then env vars, then defaults.
   */
  overrides?: Partial<AdapterRoleConfig>;
}

/**
 * Shared adapter-config resolver for both memory-analysis and
 * recall-synthesis roles. Reads the role-based env vars
 * (`CURION_PRIMARY_*`, `CURION_FALLBACK_*`) plus the generic
 * adapter knobs (`CURION_ADAPTER_TIMEOUT_MS`,
 * `CURION_ADAPTER_MAX_TOKENS`), applies any overrides, and
 * returns a fully-populated `AdapterRoleConfig`.
 *
 * No provider is hardcoded. The primary slot is populated from
 * `CURION_PRIMARY_BASE_URL`, `CURION_PRIMARY_MODEL`, and
 * `CURION_PRIMARY_API_KEY`. If any of these is missing, the
 * field is empty. The fallback slot is empty by default and is
 * populated only when the corresponding `CURION_FALLBACK_*`
 * vars are set.
 *
 * When `apiFormat` is `"anthropic"` and no base URL is provided
 * (from either an override or the env), the default is
 * `https://api.anthropic.com` (Anthropic's official endpoint).
 * This is not a hardcoded provider default — the base URL is
 * part of the API format specification.
 *
 * All string fields (URLs, model ids, keys) are trimmed before
 * being stored. A value that is missing, empty, or
 * whitespace-only is treated as "absent".
 */
export function loadRoleConfig(opts: LoadRoleConfigOpts): AdapterRoleConfig {
  const overrides = opts.overrides ?? {};

  const primaryApiFormat =
    overrides.primaryApiFormat ?? readApiFormatValue("CURION_PRIMARY_API_FORMAT");
  const fallbackApiFormat =
    overrides.fallbackApiFormat ?? readApiFormatValue("CURION_FALLBACK_API_FORMAT");

  const primaryBaseUrlCandidate = pickTrimmedString(
    overrides.primaryBaseUrl ?? "",
    readTrimmedString("CURION_PRIMARY_BASE_URL")
  );
  const fallbackBaseUrlCandidate = pickTrimmedString(
    overrides.fallbackBaseUrl ?? "",
    readTrimmedString("CURION_FALLBACK_BASE_URL")
  );

  return {
    primaryBaseUrl:
      primaryApiFormat === "anthropic" && !primaryBaseUrlCandidate
        ? "https://api.anthropic.com"
        : primaryBaseUrlCandidate,
    primaryModel: pickTrimmedString(
      overrides.primaryModel ?? "",
      readTrimmedString("CURION_PRIMARY_MODEL")
    ),
    primaryProviderLabel: pickTrimmedString(
      overrides.primaryProviderLabel ?? "",
      readTrimmedString("CURION_PRIMARY_PROVIDER_LABEL")
    ),
    primaryApiFormat,
    primaryStrictJson:
      overrides.primaryStrictJson ??
      (opts.strictJson && process.env.CURION_PRIMARY_STRICT_JSON === "true"),
    fallbackBaseUrl:
      fallbackApiFormat === "anthropic" && !fallbackBaseUrlCandidate
        ? "https://api.anthropic.com"
        : fallbackBaseUrlCandidate,
    fallbackModel: pickTrimmedString(
      overrides.fallbackModel ?? "",
      readTrimmedString("CURION_FALLBACK_MODEL")
    ),
    fallbackProviderLabel: pickTrimmedString(
      overrides.fallbackProviderLabel ?? "",
      readTrimmedString("CURION_FALLBACK_PROVIDER_LABEL")
    ),
    fallbackApiFormat,
    fallbackStrictJson:
      overrides.fallbackStrictJson ??
      (opts.strictJson && process.env.CURION_FALLBACK_STRICT_JSON === "true"),
    primaryApiKey: pickTrimmedString(
      overrides.primaryApiKey ?? "",
      readTrimmedString("CURION_PRIMARY_API_KEY")
    ),
    fallbackApiKey: pickTrimmedString(
      overrides.fallbackApiKey ?? "",
      readTrimmedString("CURION_FALLBACK_API_KEY")
    ),
    timeoutMs:
      overrides.timeoutMs ?? readNumber("CURION_ADAPTER_TIMEOUT_MS", opts.defaults.timeoutMs),
    maxTokens:
      overrides.maxTokens ?? readNumber("CURION_ADAPTER_MAX_TOKENS", opts.defaults.maxTokens),
  };
}

export { readNumber, readTrimmedString, pickTrimmedString };
