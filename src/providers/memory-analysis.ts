/**
 * Real provider adapter for structured memory-analysis calls.
 *
 * This module is the production-safe adapter layer that wraps the
 * prototype HTTP client + parser with a primary→fallback policy,
 * a same-provider adapter-level LLM repair step, and a typed
 * result/error contract.
 *
 * Public MCP surface is unchanged: this file is consumed only by
 * other server-internal modules. No new tools, parameters,
 * resources, or prompts are added.
 *
 * Provider configuration (role-based, no vendor defaults):
 *   - Primary: CURION_PRIMARY_API_KEY, CURION_PRIMARY_BASE_URL,
 *     CURION_PRIMARY_MODEL, CURION_PRIMARY_API_FORMAT,
 *     CURION_PRIMARY_PROVIDER_LABEL (optional),
 *     CURION_PRIMARY_STRICT_JSON (default false)
 *   - Fallback: CURION_FALLBACK_API_KEY, CURION_FALLBACK_BASE_URL,
 *     CURION_FALLBACK_MODEL, CURION_FALLBACK_API_FORMAT,
 *     CURION_FALLBACK_PROVIDER_LABEL (optional),
 *     CURION_FALLBACK_STRICT_JSON (default false)
 *
 * API format:
 *   - `"openai-compatible"` (default): uses the OpenAI-compatible
 *     /chat/completions endpoint via the raw HTTP client.
 *   - `"anthropic"`: uses the official `@anthropic-ai/sdk`.
 *     When apiFormat is "anthropic" and no base URL is supplied,
 *     the default is `https://api.anthropic.com`. Model and key
 *     must still be explicit via CURION_*_MODEL and CURION_*_API_KEY.
 *
 * If no provider is configured, the adapter returns
 * `missing-config` without making any HTTP call. There are no
 * built-in defaults — the operator must explicitly configure
 * at least one provider.
 *
 * Provider-id derivation:
 *   The provider label (`AdapterProviderId`) is derived from the
 *   configured base URL via `resolveAdapterProviderId`. This mirrors
 *   the recall-synthesis adapter's design: a swapped / overridden base
 *   URL produces a label that matches the actual endpoint, so the
 *   `providerLabel` surfaced to the http-client, the `providerUsed`
 *   field on success, and the operator-visible error messages all
 *   stay honest even when the slot is reassigned.
 *
 *   Recognized hosts (case-insensitive substring match):
 *     - "anthropic"  -> "anthropic"
 *     - "openai"     -> "openai"
 *     - "groq"       -> "groq"
 *     - "openrouter" -> "openrouter"
 *     - "ollama"     -> "ollama"
 *     - "lmstudio"   -> "lmstudio"
 *     - "nvidia"     -> "nvidia-nim"
 *     - "minimax"    -> "minimax"
 *     - otherwise    -> "custom"
 *
 * Fallback policy:
 *   1. Call primary.
 *   2. If primary returns a usable structured result, return it.
 *   3. If primary returns an unparsable / schema-invalid result,
 *      attempt one **adapter-level LLM repair** call on the SAME
 *      primary provider with a corrective "JSON only" instruction.
 *      (This is distinct from the in-parser text-repair pass
 *      inside `parseMemoryAnalysis`, which may report
 *      `parseStrategy: "repaired"` for the same response.)
 *   4. If repair still fails OR the primary had a hard failure
 *      (auth, network, timeout, 5xx, missing-config), RESTART the
 *      whole analysis on the fallback provider from scratch, if a
 *      fallback key is configured AND a fallback base URL + model
 *      are configured. Partial provider state is never mixed
 *      across providers.
 *   5. If no fallback is configured, or the configured fallback
 *      also fails, return a typed `AdapterFailure` with
 *      `kind: "all-providers-failed"` and the last error.
 *
 * Repair terminology:
 *   - `llmRepairAttempts` (on `AdapterSuccess`): count of
 *     adapter-level provider round trips used to repair an
 *     unparsable model response. Always 0 or 1.
 *   - `parseStrategy === "repaired"` (on `AdapterSuccess` and
 *     inside the parser): the in-parser regex/text cleanup pass
 *     inside `parseMemoryAnalysis` was needed to validate the
 *     final JSON. This is a parser-level concern, not a
 *     provider round trip.
 *   The two are independent. The adapter counts provider round
 *   trips in `llmRepairAttempts`; the parser reports its own
 *   location / cleanup strategy in `parseStrategy`.
 *
 * Security:
 *   - No API key values appear in any returned field, error
 *     message, or log. The HTTP client does not log request or
 *     response bodies, and the adapter does not include the
 *     input text in any serialized result.
 *   - Authorization headers and key strings are never constructed
 *     here; the HTTP client owns the `Authorization: Bearer ...`
 *     assembly. The adapter passes an opaque key string into
 *     `chatCompletion`, which is the only place it is used.
 */

import {
  chatCompletion,
  type ChatMessage,
  type ProviderError,
} from "./http-client.js";
import { anthropicChatCompletion } from "./anthropic.js";
import {
  parseMemoryAnalysis,
  MEMORY_ANALYSIS_JSON_SCHEMA,
  type MemoryAnalysis,
} from "./structured-output.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
//
// No provider is hardcoded. The operator must configure at least
// one provider via the CURION_PRIMARY_* env vars. The fallback
// slot is empty by default (opt-in via CURION_FALLBACK_*).
//
// Generic adapter knobs:
/** Default per-request timeout in ms. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;
/** Default per-request max output tokens. */
export const DEFAULT_ADAPTER_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * API format for a provider slot.
 *
 * `"openai-compatible"` — use the OpenAI-compatible /chat/completions
 * endpoint with raw HTTP (the existing path).
 *
 * `"anthropic"` — use the official Anthropic SDK / Messages API.
 * System prompts are sent as a top-level `system` field rather
 * than a `role: "system"` message. The base URL defaults to
 * `https://api.anthropic.com` when apiFormat is `anthropic` and no
 * base URL override is supplied.
 *
 * The API format is independent of the provider id: setting
 * `apiFormat: "anthropic"` on an OpenAI-compatible base URL is
 * invalid (Anthropic SDK will fail to route correctly), but the
 * slot configuration is accepted as-is. The operator is responsible
 * for supplying correct values.
 */
export type ApiFormat = "openai-compatible" | "anthropic";

/**
 * Provider id the adapter can target.
 *
 * `"custom"` is reserved for the case where the configured base URL
 * does not match any provider we recognize. Callers can branch on it
 * the same way they branch on the named values; it is informational,
 * not an error condition. This mirrors `RecallProviderId` in the
 * recall-synthesis adapter.
 */
export type AdapterProviderId =
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "nvidia-nim"
  | "minimax"
  | "custom";

/** A piece of related memory context to include in the prompt (optional). */
export interface RelatedMemory {
  /** Stable id of the related memory (number from the `memories` table). */
  id: number;
  /**
   * Short, redacted memory content of the related memory. Never
   * the raw text.
   *
   * Phase 1 internal naming cleanup: the internal field is
   * `memoryContent`; the provider JSON contract and the public
   * surface still use `summary`. The seam / controller is
   * responsible for translating between the two surfaces.
   */
  memoryContent: string;
  /** Optional kind tag, e.g. "memory". */
  kind?: string;
}

export interface MemoryAnalysisInput {
  /**
   * The user text to analyze. The adapter does NOT echo this back
   * in any result field. The prompt builder uses it as INPUT, but
   * the returned `MemoryAnalysis` is a sanitized structured value
   * (summary, confidence, tags, entities, classification).
   */
  text: string;
}

/**
 * Per-call options. All fields are optional; sensible defaults
 * are used when omitted.
 */
export interface MemoryAnalysisAdapterOptions {
  /**
   * Per-request timeout in ms. Defaults to `CURION_ADAPTER_TIMEOUT_MS`
   * (or `DEFAULT_ADAPTER_TIMEOUT_MS` if unset).
   */
  timeoutMs?: number;
  /**
   * Per-request max output tokens. Defaults to
   * `CURION_ADAPTER_MAX_TOKENS` (or `DEFAULT_ADAPTER_MAX_TOKENS`).
   */
  maxTokens?: number;
  /**
   * Override the primary provider key. When unset, the adapter
   * reads `CURION_PRIMARY_API_KEY` from `process.env`.
   */
  primaryApiKey?: string;
  /**
   * Override the fallback provider key. When unset, the adapter
   * reads `CURION_FALLBACK_API_KEY` from `process.env`.
   * The fallback slot is unconfigured by default.
   */
  fallbackApiKey?: string;
  /**
   * Override the primary base URL. Defaults to
   * `CURION_PRIMARY_BASE_URL`.
   */
  primaryBaseUrl?: string;
  /**
   * Override the fallback base URL. Defaults to
   * `CURION_FALLBACK_BASE_URL`. With no env var and no override,
   * the fallback slot is empty.
   */
  fallbackBaseUrl?: string;
  /**
   * Override the primary model id. Defaults to
   * `CURION_PRIMARY_MODEL`.
   */
  primaryModel?: string;
  /**
   * Override the fallback model id. Defaults to
   * `CURION_FALLBACK_MODEL`. With no env var and no override,
   * the fallback slot is empty.
   */
  fallbackModel?: string;
  /**
   * Optional fetch override for tests. Tests can supply a stub
   * `fetch` to drive the adapter without network access.
   */
  fetchImpl?: typeof fetch;
  /**
   * Skip the same-provider repair attempt. Defaults to false
   * (repair enabled). Useful for tests and for callers that
   * want a strict "fallback on any parse failure" behavior.
   */
  disableRepair?: boolean;
  /**
   * Skip the fallback. Defaults to false. Useful for tests that
   * want to observe the primary path in isolation.
   */
  disableFallback?: boolean;
  /**
   * Override the primary API format. Defaults to
   * `CURION_PRIMARY_API_FORMAT` (or "openai-compatible").
   */
  primaryApiFormat?: ApiFormat;
  /**
   * Override the fallback API format. Defaults to
   * `CURION_FALLBACK_API_FORMAT` (or "openai-compatible").
   */
  fallbackApiFormat?: ApiFormat;
}

/**
 * Successful structured result from the adapter.
 */
export interface AdapterSuccess {
  ok: true;
  /** The structured memory analysis. */
  value: MemoryAnalysis;
  /**
   * Which provider produced the final result. `"primary"` means
   * the fallback was not used; `"fallback"` means the primary
   * failed or its structured output could not be repaired.
   */
  providerUsed: AdapterProviderId;
  /** Model id that produced the final result. */
  modelUsed: string;
  /**
   * True iff the result came from the fallback provider because
   * the primary failed or its structured output was unrepairable.
   */
  fallbackUsed: boolean;
  /**
   * Number of **adapter-level LLM repair attempts** applied to the
   * provider that ultimately produced the result. This is the
   * "ask the same model again with a corrective JSON-only
   * instruction" retry, not the in-parser text-repair pass. Always
   * 0 or 1.
   *
   * This field is intentionally distinct from `parseStrategy`:
   *   - `llmRepairAttempts` counts *provider round trips* used to
   *     fix an unparsable response.
   *   - `parseStrategy === "repaired"` indicates the in-parser
   *     regex/text cleanup pass inside `parseMemoryAnalysis` was
   *     needed to make the final JSON valid.
   * The two can appear independently: a model response may parse
   * cleanly via the parser's "repaired" strategy on the first try
   * (`llmRepairAttempts: 0`), or it may need a provider-level
   * repair call whose response then parses via the raw or fenced
   * strategy (`llmRepairAttempts: 1`).
   */
  llmRepairAttempts: 0 | 1;
  /**
   * Parser strategy that produced the final value, if any. Set by
   * `parseMemoryAnalysis`; reflects the *location / cleanup* the
   * parser used to extract and validate the JSON. The `"repaired"`
   * value indicates the in-parser text-repair pass inside
   * `parseMemoryAnalysis` and is **unrelated** to
   * `llmRepairAttempts` (which counts adapter-level provider
   * round trips).
   */
  parseStrategy?: "raw" | "fenced" | "balanced" | "repaired";
  /** Latency of the winning provider call, in ms. */
  latencyMs: number;
  /** Number of HTTP round trips actually made. */
  httpCalls: number;
}

/**
 * Failure result from the adapter. Returned rather than thrown
 * so callers can branch on `kind` without try/catch.
 */
export interface AdapterFailure {
  ok: false;
  /**
   * Top-level error classification. `"all-providers-failed"`
   * means primary and fallback both failed; `"missing-config"`
   * means neither provider had a configured key at all.
   */
  kind:
    | "all-providers-failed"
    | "missing-config"
    | "invalid-input";
  /**
   * Human-readable, redacted message. Never contains a key
   * value or the input text.
   */
  message: string;
  /** Last hard error observed, if any (already redacted by the HTTP client). */
  lastError?: ProviderError;
  /** Last structured-output failure observed, if any. */
  lastParseErrors?: string[];
  /**
   * Number of HTTP round trips actually made before giving up.
   * Always <= 4 (primary + repair + fallback + fallback-repair) when
   * a fallback is configured. With no fallback configured, the cap
   * is 2 (primary + repair).
   */
  httpCalls: number;
}

export type MemoryAnalysisResult = AdapterSuccess | AdapterFailure;

// ---------------------------------------------------------------------------
// Config resolution (env-only, no dotenv discovery)
// ---------------------------------------------------------------------------

export interface AdapterConfig {
  primaryBaseUrl: string;
  primaryModel: string;
  primaryProviderLabel: string;
  primaryApiFormat: ApiFormat;
  primaryStrictJson: boolean;
  fallbackBaseUrl: string;
  fallbackModel: string;
  fallbackProviderLabel: string;
  fallbackApiFormat: ApiFormat;
  fallbackStrictJson: boolean;
  primaryApiKey: string;
  fallbackApiKey: string;
  timeoutMs: number;
  maxTokens: number;
}

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
function readApiFormat(name: string): ApiFormat {
  const raw = readTrimmedString(name);
  if (raw === "anthropic") return "anthropic";
  return "openai-compatible";
}

/**
 * Resolve adapter configuration from `process.env` only. The
 * adapter does not call `loadDotEnv`; the stdio runtime relies
 * on the parent process's environment, and tests can override
 * keys via `options.primaryApiKey` / `options.fallbackApiKey`.
 *
 * No provider is hardcoded. The primary slot is populated from
 * CURION_PRIMARY_BASE_URL, CURION_PRIMARY_MODEL, and
 * CURION_PRIMARY_API_KEY. If any of these is missing, the slot
 * is empty. The fallback slot is empty by default and is
 * populated only when all three CURION_FALLBACK_* vars are set.
 *
 * Provider labels are derived from the base URL when the
 * CURION_*_PROVIDER_LABEL env vars are not set. Strict JSON
 * mode is disabled by default and can be enabled per-role via
 * CURION_*_STRICT_JSON=true. API format defaults to
 * "openai-compatible" for backwards compatibility with the
 * generic model.
 *
 * When apiFormat is "anthropic" and no base URL is provided,
 * the default is https://api.anthropic.com (Anthropic's official
 * endpoint). This is not a hardcoded provider default — the base
 * URL is part of the API format specification, not a model or
 * provider choice.
 *
 * All string fields (URLs, model ids, and the API keys themselves)
 * are trimmed before being stored. A value that is missing,
 * empty, or whitespace-only is treated as "absent".
 *
 * Values that may carry secrets (the keys) are returned as
 * opaque trimmed strings and never echoed back through any
 * other adapter API surface.
 */
export function loadAdapterConfig(
  overrides: Partial<AdapterConfig> = {},
): AdapterConfig {
  const primaryApiFormat = overrides.primaryApiFormat
    ?? readApiFormat("CURION_PRIMARY_API_FORMAT");
  const fallbackApiFormat = overrides.fallbackApiFormat
    ?? readApiFormat("CURION_FALLBACK_API_FORMAT");

  // Base URL defaults for the Anthropic API format.
  const primaryBaseUrlCandidate = pickTrimmedString(
    overrides.primaryBaseUrl ?? "",
    readTrimmedString("CURION_PRIMARY_BASE_URL"),
  );
  const fallbackBaseUrlCandidate = pickTrimmedString(
    overrides.fallbackBaseUrl ?? "",
    readTrimmedString("CURION_FALLBACK_BASE_URL"),
  );

  const cfg: AdapterConfig = {
    primaryBaseUrl: primaryApiFormat === "anthropic" && !primaryBaseUrlCandidate
      ? "https://api.anthropic.com"
      : primaryBaseUrlCandidate,
    primaryModel: pickTrimmedString(
      overrides.primaryModel ?? "",
      readTrimmedString("CURION_PRIMARY_MODEL"),
    ),
    primaryProviderLabel: pickTrimmedString(
      overrides.primaryProviderLabel ?? "",
      readTrimmedString("CURION_PRIMARY_PROVIDER_LABEL"),
    ),
    primaryApiFormat,
    primaryStrictJson: overrides.primaryStrictJson ?? (
      process.env.CURION_PRIMARY_STRICT_JSON === "true"
    ),
    fallbackBaseUrl: fallbackApiFormat === "anthropic" && !fallbackBaseUrlCandidate
      ? "https://api.anthropic.com"
      : fallbackBaseUrlCandidate,
    fallbackModel: pickTrimmedString(
      overrides.fallbackModel ?? "",
      readTrimmedString("CURION_FALLBACK_MODEL"),
    ),
    fallbackProviderLabel: pickTrimmedString(
      overrides.fallbackProviderLabel ?? "",
      readTrimmedString("CURION_FALLBACK_PROVIDER_LABEL"),
    ),
    fallbackApiFormat,
    fallbackStrictJson: overrides.fallbackStrictJson ?? (
      process.env.CURION_FALLBACK_STRICT_JSON === "true"
    ),
    primaryApiKey: pickTrimmedString(
      overrides.primaryApiKey ?? "",
      readTrimmedString("CURION_PRIMARY_API_KEY"),
    ),
    fallbackApiKey: pickTrimmedString(
      overrides.fallbackApiKey ?? "",
      readTrimmedString("CURION_FALLBACK_API_KEY"),
    ),
    timeoutMs: overrides.timeoutMs ?? readNumber(
      "CURION_ADAPTER_TIMEOUT_MS",
      DEFAULT_ADAPTER_TIMEOUT_MS,
    ),
    maxTokens: overrides.maxTokens ?? readNumber(
      "CURION_ADAPTER_MAX_TOKENS",
      DEFAULT_ADAPTER_MAX_TOKENS,
    ),
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the user-role prompt for the initial analysis call. The
 * shape mirrors the prototype's `buildStructuredPrompt` but adds
 * an explicit "related memories" block when provided. The input
 * text is JSON-encoded to clearly delimit it inside the prompt.
 */
function buildAnalysisUserPrompt(
  text: string,
  relatedMemories: readonly RelatedMemory[] | undefined,
): string {
  const lines: string[] = [];
  lines.push("Return EXACTLY one JSON object. No prose, no markdown, no code fences.");
  lines.push("The object MUST match this TypeScript shape:");
  lines.push("{");
  lines.push('  "summary": string,        // Write a 1-3 sentence narrative memory that preserves the useful context from the input. Write as if the information is being remembered for future recall, not as a retrospective curator note. Preserve who/what/why/when and concrete terms (file names, branch names, feature names, decisions, constraints) when present. Do not start with "The user asked", "This memory captures", or similar curator framings. Do not invent details. Do not include memory IDs or internal storage references.');
  lines.push('  "confidence": number,     // 0..1, your confidence in the summary');
  lines.push('  "tags": string[],         // up to 8 short tags');
  lines.push('  "entities"?: {name: string, kind: string}[], // optional named entities');
  lines.push('  "classification"?: string // optional short label. Valid labels:');
  lines.push('                               //   decision  = chosen direction / resolved choice');
  lines.push('                               //   policy    = standing future behavior / rule (e.g. "always use X for Y")');
  lines.push('                               //   constraint = hard boundary / requirement / limitation (e.g. "never exceed N")');
  lines.push('                               //   preference = user likes / style');
  lines.push('                               //   fact       = observed result / verifiable info');
  lines.push('                               //   context    = background / surrounding situation');
  lines.push('                               //   conflict   = tension / contradiction');
  lines.push('                               //   reference  = domain knowledge / schema / documented fact');
  lines.push('                               //   finding    = observed result / evidence (default fallback)');
  lines.push("}");
  lines.push("");
  lines.push("Wrap the JSON in a ```json ... ``` block. Do not include any other text.");
  if (relatedMemories && relatedMemories.length > 0) {
    lines.push("");
    // The related-memory block is prose-only. The internal `id`
    // field on `RelatedMemory` is preserved for controller-side
    // relationship derivation, but it is intentionally OMITTED
    // from the provider prompt: emitting `#123` (or any other
    // internal id token) would leak a storage handle into the
    // model's input and would be a no-op for the disambiguation
    // use case the block exists to serve. The model uses the
    // `memoryContent` + optional `kind` only.
    lines.push("Related memories (use only to disambiguate entities; do not copy):");
    for (const rm of relatedMemories) {
      if (rm.kind) {
        lines.push(`- (${rm.kind}): ${rm.memoryContent}`);
      } else {
        lines.push(`- ${rm.memoryContent}`);
      }
    }
  }
  lines.push("");
  lines.push("INPUT:");
  lines.push(JSON.stringify(text));
  return lines.join("\n");
}

/**
 * Build the user-role prompt for the same-provider repair call.
 * Keeps the original structured-output instruction but adds an
 * explicit "return JSON only" directive and echoes the previous
 * invalid response so the model can fix it.
 *
 * The previous response is treated as untrusted model output and
 * is included verbatim (truncated) so the adapter can avoid
 * re-sending the original input text on the repair leg. This
 * keeps the repair prompt free of the user input.
 */
function buildRepairUserPrompt(previousBadResponse: string): string {
  const truncated = previousBadResponse.length > 1500
    ? `${previousBadResponse.slice(0, 1500)}...`
    : previousBadResponse;
  return [
    "Your previous response could not be parsed as a valid JSON object matching the requested schema.",
    "Return ONLY a single JSON object that matches the schema below. No prose, no markdown, no code fences.",
    "",
    "{",
    '  "summary": string,',
    '  "confidence": number,     // 0..1',
    '  "tags": string[],         // up to 8 short tags',
    '  "entities"?: {name: string, kind: string}[]',
    '  "classification"?: string // optional. Valid: decision, policy, constraint, preference, fact, context, conflict, reference, finding',
    "}",
    "",
    "Wrap the JSON in a ```json ... ``` block. Do not include any other text.",
    "",
    "Your previous response was:",
    "----- BEGIN PREVIOUS RESPONSE -----",
    truncated,
    "----- END PREVIOUS RESPONSE -----",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Provider-id resolution (derived from the base URL)
//
// The provider label is informational: it appears in the
// `providerLabel` passed to the http-client, in the
// `providerUsed` field of the success result, and in failure
// messages. To avoid drift between the label and the actual
// endpoint the request is sent to, the label is derived from the
// base URL itself instead of being hardcoded at each call site.
//
// Recognized hosts (case-insensitive substring match):
//   - "openai"     -> "openai"
//   - "groq"       -> "groq"
//   - "openrouter" -> "openrouter"
//   - "ollama"     -> "ollama"
//   - "lmstudio"   -> "lmstudio"
//   - "nvidia"     -> "nvidia-nim"
//   - "minimax"    -> "minimax"
//   - otherwise    -> "custom"
//
// This mirrors `resolveRecallProviderId` in the recall-synthesis
// adapter: swapping the base URL (or overriding it via env vars
// or MCP tool options) automatically produces the correct label
// without any further code change.
// ---------------------------------------------------------------------------

/**
 * Derive an `AdapterProviderId` from the base URL the request
 * will actually be sent to. The match is intentionally a case-
 * insensitive substring on the host portion so that env-style
 * overrides still resolve correctly.
 */
export function resolveAdapterProviderId(baseUrl: string): AdapterProviderId {
  const url = (baseUrl ?? "").toLowerCase();
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("openai")) return "openai";
  if (url.includes("groq")) return "groq";
  if (url.includes("openrouter")) return "openrouter";
  if (url.includes("ollama")) return "ollama";
  if (url.includes("lmstudio")) return "lmstudio";
  if (url.includes("nvidia")) return "nvidia-nim";
  if (url.includes("minimax")) return "minimax";
  return "custom";
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Analyze a piece of memory text using the primary provider, with
 * a same-provider repair attempt on parse failure and a full
 * fallback to a secondary provider on hard failure or unrepairable
 * structured output.
 *
 * The function never throws on expected error paths. It returns a
 * discriminated union (`AdapterSuccess` or `AdapterFailure`).
 *
 * Security guarantees:
 *   - The input `text` is used to build the prompt but is never
 *     included in any field of the returned object.
 *   - API key values are never included in any returned field or
 *     error message.
 *   - The HTTP client (used under the hood) does not log request
 *     or response bodies.
 *
 * Behavior:
 *   - If neither provider is configured, returns
 *     `{ ok: false, kind: "missing-config", ... }` without making
 *     any HTTP call.
 *   - If `input.text` is empty or not a string, returns
 *     `{ ok: false, kind: "invalid-input", ... }` without making
 *     any HTTP call.
 *   - On success, `fallbackUsed` is true iff the result came from
 *     the fallback provider.
 *   - On failure, `kind: "all-providers-failed"` is returned and
 *     `httpCalls` reflects the total calls actually made.
 */
export async function analyzeMemoryWithFallback(
  input: string,
  relatedMemories?: readonly RelatedMemory[],
  options: MemoryAnalysisAdapterOptions = {},
): Promise<MemoryAnalysisResult> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return {
      ok: false,
      kind: "invalid-input",
      message: "analyzeMemoryWithFallback: `text` must be a non-empty string",
      httpCalls: 0,
    };
  }

  const cfg = loadAdapterConfig({
    ...(options.primaryApiKey !== undefined
      ? { primaryApiKey: options.primaryApiKey }
      : {}),
    ...(options.fallbackApiKey !== undefined
      ? { fallbackApiKey: options.fallbackApiKey }
      : {}),
    ...(options.primaryBaseUrl !== undefined
      ? { primaryBaseUrl: options.primaryBaseUrl }
      : {}),
    ...(options.fallbackBaseUrl !== undefined
      ? { fallbackBaseUrl: options.fallbackBaseUrl }
      : {}),
    ...(options.primaryModel !== undefined
      ? { primaryModel: options.primaryModel }
      : {}),
    ...(options.fallbackModel !== undefined
      ? { fallbackModel: options.fallbackModel }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.primaryApiFormat !== undefined
      ? { primaryApiFormat: options.primaryApiFormat }
      : {}),
    ...(options.fallbackApiFormat !== undefined
      ? { fallbackApiFormat: options.fallbackApiFormat }
      : {}),
  });

  if (!cfg.primaryApiKey && !cfg.fallbackApiKey) {
    return {
      ok: false,
      kind: "missing-config",
      message:
        "analyzeMemoryWithFallback: no provider api key configured (set CURION_PRIMARY_API_KEY or CURION_FALLBACK_API_KEY)",
      httpCalls: 0,
    };
  }

  // --- Primary attempt + same-provider repair -------------------------
  // The primary provider id is derived from `cfg.primaryBaseUrl`
  // so the label in `providerLabel` / `providerUsed` / error
  // messages always matches the endpoint the request is sent to.
  const primaryProvider: AdapterProviderId = (cfg.primaryProviderLabel as AdapterProviderId)
    || resolveAdapterProviderId(cfg.primaryBaseUrl);
  const primaryResult: ProviderAttemptResult = cfg.primaryApiKey
    ? await runProviderWithRepair({
        provider: primaryProvider,
        baseUrl: cfg.primaryBaseUrl,
        model: cfg.primaryModel,
        apiKey: cfg.primaryApiKey,
        timeoutMs: cfg.timeoutMs,
        maxTokens: cfg.maxTokens,
        text: input,
        relatedMemories,
        fetchImpl: options.fetchImpl,
        disableRepair: options.disableRepair,
        strictJson: cfg.primaryStrictJson,
        apiFormat: cfg.primaryApiFormat,
      })
    : {
        ok: false,
        message: "primary provider not configured",
        lastError: {
          kind: "missing-config",
          message: `${primaryProvider}: no api key configured`,
          reachedServer: false,
        },
        httpCalls: 0,
      };

  if (primaryResult.ok) {
    return toAdapterSuccess(primaryResult, false, 0);
  }

  // --- Fallback attempt (only if fallback is configured and not disabled)
  if (options.disableFallback) {
    return {
      ok: false,
      kind: "all-providers-failed",
      message: primaryResult.message,
      lastError: primaryResult.lastError,
      lastParseErrors: primaryResult.lastParseErrors,
      httpCalls: primaryResult.httpCalls,
    };
  }

  // The fallback slot is empty by default (no base URL, no model,
  // no key). The slot is only usable when the operator has
  // explicitly configured all three (key + URL + model). If the
  // slot is empty for any reason, we surface `all-providers-failed`
  // and do NOT make a second HTTP call.
  if (!cfg.fallbackApiKey || !cfg.fallbackBaseUrl || !cfg.fallbackModel) {
    return {
      ok: false,
      kind: "all-providers-failed",
      message: primaryResult.lastError
        ? `primary failed and no fallback configured: ${primaryResult.lastError.message}`
        : primaryResult.message,
      lastError: primaryResult.lastError,
      lastParseErrors: primaryResult.lastParseErrors,
      httpCalls: primaryResult.httpCalls,
    };
  }

  // Restart the whole analysis on the fallback provider. Same
  // derivation rule as the primary: the label follows the base
  // URL, so a swapped or overridden fallback URL still produces
  // a label that matches the actual endpoint.
  const fallbackProvider: AdapterProviderId = (cfg.fallbackProviderLabel as AdapterProviderId)
    || resolveAdapterProviderId(cfg.fallbackBaseUrl);
  const fallbackResult: ProviderAttemptResult = await runProviderWithRepair({
    provider: fallbackProvider,
    baseUrl: cfg.fallbackBaseUrl,
    model: cfg.fallbackModel,
    apiKey: cfg.fallbackApiKey,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    text: input,
    relatedMemories,
    fetchImpl: options.fetchImpl,
    disableRepair: options.disableRepair,
    strictJson: cfg.fallbackStrictJson,
    apiFormat: cfg.fallbackApiFormat,
  });

  if (fallbackResult.ok) {
    return toAdapterSuccess(fallbackResult, true, primaryResult.httpCalls);
  }

  return {
    ok: false,
    kind: "all-providers-failed",
    message: `primary and fallback both failed: primary=${truncateMsg(primaryResult.message, 200)}; fallback=${truncateMsg(fallbackResult.message, 200)}`,
    lastError: fallbackResult.lastError ?? primaryResult.lastError,
    lastParseErrors: fallbackResult.lastParseErrors ?? primaryResult.lastParseErrors,
    httpCalls: primaryResult.httpCalls + fallbackResult.httpCalls,
  };
}

function toAdapterSuccess(
  attempt: ProviderAttemptOk,
  fallbackUsed: boolean,
  priorCalls: number,
): AdapterSuccess {
  const success: AdapterSuccess = {
    ok: true,
    value: attempt.value,
    providerUsed: attempt.provider,
    modelUsed: attempt.model,
    fallbackUsed,
    llmRepairAttempts: attempt.llmRepairAttempts,
    latencyMs: attempt.latencyMs,
    httpCalls: attempt.httpCalls + priorCalls,
  };
  if (attempt.parseStrategy) {
    return { ...success, parseStrategy: attempt.parseStrategy };
  }
  return success;
}

function truncateMsg(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// ---------------------------------------------------------------------------
// Per-provider attempt (with optional same-provider repair)
// ---------------------------------------------------------------------------

interface ProviderAttemptBase {
  ok: boolean;
  message: string;
  lastError?: ProviderError;
  lastParseErrors?: string[];
  httpCalls: number;
}

interface ProviderAttemptOk extends ProviderAttemptBase {
  ok: true;
  value: MemoryAnalysis;
  provider: AdapterProviderId;
  model: string;
  /**
   * Adapter-level LLM repair attempts applied to this provider
   * (0 or 1). Distinct from `parseStrategy`, which reflects the
   * in-parser cleanup pass.
   */
  llmRepairAttempts: 0 | 1;
  parseStrategy?: "raw" | "fenced" | "balanced" | "repaired";
  latencyMs: number;
}

interface ProviderAttemptFail extends ProviderAttemptBase {
  ok: false;
}

type ProviderAttemptResult = ProviderAttemptOk | ProviderAttemptFail;

interface RunProviderArgs {
  provider: AdapterProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  text: string;
  relatedMemories: readonly RelatedMemory[] | undefined;
  fetchImpl: typeof fetch | undefined;
  disableRepair: boolean | undefined;
  strictJson: boolean;
  apiFormat: ApiFormat;
}

/** Build responseFormat based on strictJson setting. */
function buildResponseFormat(strictJson: boolean): "json_object" | {
  kind: "json_schema";
  schema: Record<string, unknown>;
  strict: boolean;
  name: string;
} {
  if (strictJson) {
    return {
      kind: "json_schema",
      schema: MEMORY_ANALYSIS_JSON_SCHEMA,
      strict: true,
      name: "memory_analysis",
    };
  }
  return "json_object";
}

async function runProviderWithRepair(
  args: RunProviderArgs,
): Promise<ProviderAttemptResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a structured-output assistant. You must return exactly one JSON object, optionally wrapped in a ```json ... ``` block. No other text.",
    },
    {
      role: "user",
      content: buildAnalysisUserPrompt(args.text, args.relatedMemories),
    },
  ];

  // Route based on API format.
  const isAnthropic = args.apiFormat === "anthropic";

  // First call.
  const first = isAnthropic
    ? await runAnthropicCall({
        model: args.model,
        messages,
        maxTokens: args.maxTokens,
        fetchImpl: args.fetchImpl,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
        providerLabel: `${args.provider}/${args.model}`,
      })
    : await runOpenAiCompatibleCall({
        model: args.model,
        messages,
        maxTokens: args.maxTokens,
        fetchImpl: args.fetchImpl,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
        strictJson: args.strictJson,
        providerLabel: `${args.provider}/${args.model}`,
      });

  if (!first.ok) {
    return {
      ok: false,
      message: `${args.provider}: hard failure (${first.error.kind}): ${first.error.message}`,
      lastError: first.error,
      httpCalls: 1,
    };
  }

  const firstParse = parseMemoryAnalysis(first.response.content);
  if (firstParse.ok && firstParse.value) {
    return {
      ok: true,
      message: "ok",
      value: firstParse.value,
      provider: args.provider,
      model: args.model,
      llmRepairAttempts: 0,
      ...(firstParse.strategy ? { parseStrategy: firstParse.strategy } : {}),
      latencyMs: first.response.latencyMs,
      httpCalls: 1,
    };
  }

  if (args.disableRepair) {
    return {
      ok: false,
      message: `${args.provider}: structured output invalid and repair disabled`,
      lastParseErrors: firstParse.errors,
      httpCalls: 1,
    };
  }

  // Same-provider repair attempt.
  const repairMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a structured-output assistant. You must return exactly one JSON object, optionally wrapped in a ```json ... ``` block. No other text.",
    },
    {
      role: "user",
      content: buildRepairUserPrompt(first.response.content),
    },
  ];

  const second = isAnthropic
    ? await runAnthropicCall({
        model: args.model,
        messages: repairMessages,
        maxTokens: args.maxTokens,
        fetchImpl: args.fetchImpl,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
        providerLabel: `${args.provider}/${args.model}#repair`,
      })
    : await runOpenAiCompatibleCall({
        model: args.model,
        messages: repairMessages,
        maxTokens: args.maxTokens,
        fetchImpl: args.fetchImpl,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
        strictJson: args.strictJson,
        providerLabel: `${args.provider}/${args.model}#repair`,
      });

  if (!second.ok) {
    return {
      ok: false,
      message: `${args.provider}: hard failure during repair (${second.error.kind}): ${second.error.message}`,
      lastError: second.error,
      httpCalls: 2,
    };
  }

  const secondParse = parseMemoryAnalysis(second.response.content);
  if (secondParse.ok && secondParse.value) {
    return {
      ok: true,
      message: "ok",
      value: secondParse.value,
      provider: args.provider,
      model: args.model,
      llmRepairAttempts: 1,
      ...(secondParse.strategy ? { parseStrategy: secondParse.strategy } : {}),
      latencyMs: second.response.latencyMs,
      httpCalls: 2,
    };
  }

  return {
    ok: false,
    message: `${args.provider}: structured output invalid after repair`,
    lastParseErrors: secondParse.errors,
    httpCalls: 2,
  };
}

/** Call OpenAI-compatible endpoint via the raw HTTP client. */
async function runOpenAiCompatibleCall(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  strictJson: boolean;
  providerLabel: string;
}): Promise<{ ok: true; response: { content: string; latencyMs: number } } | { ok: false; error: ProviderError }> {
  const responseFormat = buildResponseFormat(opts.strictJson);
  const r = await chatCompletion(
    {
      model: opts.model,
      messages: opts.messages,
      temperature: 0,
      responseFormat,
      maxTokens: opts.maxTokens,
    },
    {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      providerLabel: opts.providerLabel,
    },
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, response: { content: r.response.content, latencyMs: r.response.latencyMs } };
}

/** Call Anthropic Messages API via the official SDK. */
async function runAnthropicCall(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  providerLabel: string;
}): Promise<{ ok: true; response: { content: string; latencyMs: number } } | { ok: false; error: ProviderError }> {
  // strictJson is not implemented for Anthropic in this initial version;
  // we use prompt-delimited JSON parsing only. The SDK does not currently
  // have a stable public parameter for structured output that we can enable
  // confidently from these types.
  const r = await anthropicChatCompletion(
    {
      model: opts.model,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      fetchImpl: opts.fetchImpl,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
    },
    opts.providerLabel,
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, response: { content: r.result.response.content, latencyMs: r.result.response.latencyMs } };
}
