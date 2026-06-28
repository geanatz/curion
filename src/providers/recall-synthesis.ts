/**
 * Recall synthesis provider adapter.
 *
 * This is a thin synthesis-only adapter used by the recall
 * controller to turn a small set of safe stored memory summaries
 * into a natural-language answer to the user's query. It mirrors
 * the policy of the `memory-analysis` adapter (primary → fallback,
 * typed result) but has a much smaller surface:
 *
 *   - Input: a small set of safe memory summaries + a query.
 *   - Output: a single synthesized answer string.
 *   - No JSON-parsing dependency; the model is asked to return
 *     plain text. The controller validates the returned text
 *     (non-empty, bounded length, no obvious secret-shaped
 *     fragments) before exposing it.
 *
 * Security:
 *   - The query is NOT echoed into the request body in a way that
 *     will land in logs (the http-client does not log bodies).
 *   - The stored summaries sent to the provider are the safe,
 *     controller-normalized summaries — never raw input. The
 *     schema does not have a raw input column, so this is
 *     enforced at the storage layer.
 *   - The synthesized answer is not persisted by this adapter.
 *     The recall MVP does not store recall queries or provider
 *     responses.
 *
 * Provider configuration (role-based, no vendor defaults):
 *   - Primary: CURION_PRIMARY_API_KEY, CURION_PRIMARY_BASE_URL,
 *     CURION_PRIMARY_MODEL, CURION_PRIMARY_PROVIDER_LABEL (optional)
 *   - Fallback: CURION_FALLBACK_API_KEY, CURION_FALLBACK_BASE_URL,
 *     CURION_FALLBACK_MODEL, CURION_FALLBACK_PROVIDER_LABEL (optional)
 *
 * If no provider is configured, the adapter returns
 * `missing-config` without making any HTTP call. There are no
 * built-in defaults — the operator must explicitly configure
 * at least one provider.
 *
 * Fallback policy:
 *   - Primary is tried first.
 *   - If primary returns a hard failure (auth / network / timeout /
 *     5xx / missing-config), the adapter restarts the synthesis
 *     on the fallback provider, when a fallback key AND a
 *     fallback base URL AND a fallback model are all configured.
 *     The fallback slot is unconfigured by default; a partial
 *     configuration (e.g. a fallback key with no URL) leaves the
 *     slot empty and the adapter does not attempt a fallback
 *     call.
 *   - There is no same-provider LLM repair pass for recall: the
 *     model is asked for plain text, not structured JSON, so the
 *     only failure modes are transport errors and content-policy
 *     refusal. The controller's text-validation pass is the
 *     defense in depth for content issues.
 *   - If no fallback is configured, or the configured fallback
 *     also fails, the adapter returns
 *     `{ ok: false, kind: "all-providers-failed" }`. The
 *     controller surfaces this as `provider_error` — no
 *     fabricated answer.
 */

import {
  chatCompletion,
  type ChatMessage,
  type ProviderError,
} from "./http-client.js";
import { anthropicChatCompletion } from "./anthropic.js";
import { loadRoleConfig } from "./env-helpers.js";

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
export const RECALL_DEFAULT_TIMEOUT_MS = 30_000;
/** Default per-request max output tokens. */
export const RECALL_DEFAULT_MAX_TOKENS = 512;

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
 */
export type RecallApiFormat = "openai-compatible" | "anthropic";

/**
 * Provider id the recall synthesis adapter can target.
 *
 * `"custom"` is reserved for the case where the configured base URL
 * does not match any provider we recognize. Callers can branch on it
 * the same way they branch on the named values; it is informational,
 * not an error condition.
 */
export type RecallProviderId =
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "nvidia-nim"
  | "minimax"
  | "custom";

/**
 * A safe memory entry handed to the synthesis adapter.
 *
 * Phase 1 internal naming cleanup: the internal field is
 * `memoryContent`. The recall controller maps the public
 * `summary` projection (and the SQL `summary` column) to this
 * internal field at the storage / controller boundary.
 */
export interface RecallMemoryInput {
  /** Stable id (memory table id). */
  id: number;
  /** Controller-normalized safe memory content. */
  memoryContent: string;
  /** Optional kind tag. */
  kind?: string;
  /** Optional short tags from metadata. */
  tags?: string[];
}

/** Per-call options. */
export interface RecallSynthesisOptions {
  /** Override primary provider key. */
  primaryApiKey?: string;
  /** Override fallback provider key. */
  fallbackApiKey?: string;
  /** Override primary base URL. */
  primaryBaseUrl?: string;
  /** Override fallback base URL. */
  fallbackBaseUrl?: string;
  /** Override primary model id. */
  primaryModel?: string;
  /** Override fallback model id. */
  fallbackModel?: string;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Per-request max output tokens. Default 512. */
  maxTokens?: number;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Skip the fallback. */
  disableFallback?: boolean;
  /** Override primary API format. */
  primaryApiFormat?: RecallApiFormat;
  /** Override fallback API format. */
  fallbackApiFormat?: RecallApiFormat;
}

/** Successful synthesis result. */
export interface RecallSynthesisSuccess {
  ok: true;
  /** The synthesized plain-text answer. */
  answer: string;
  /** Which provider produced the final result. */
  providerUsed: RecallProviderId;
  /** Model id that produced the final result. */
  modelUsed: string;
  /** True if the result came from the fallback. */
  fallbackUsed: boolean;
  /** Latency of the winning call (ms). */
  latencyMs: number;
  /** Number of HTTP calls made. */
  httpCalls: number;
}

/** Failure result. */
export interface RecallSynthesisFailure {
  ok: false;
  kind: "all-providers-failed" | "missing-config" | "invalid-input";
  message: string;
  lastError?: ProviderError | undefined;
  httpCalls: number;
}

export type RecallSynthesisResult =
  | RecallSynthesisSuccess
  | RecallSynthesisFailure;

// ---------------------------------------------------------------------------
// Config resolution (env-only, mirrors the analysis adapter)
// ---------------------------------------------------------------------------

export interface RecallAdapterConfig {
  primaryBaseUrl: string;
  primaryModel: string;
  primaryProviderLabel: string;
  primaryApiFormat: RecallApiFormat;
  fallbackBaseUrl: string;
  fallbackModel: string;
  fallbackProviderLabel: string;
  fallbackApiFormat: RecallApiFormat;
  primaryApiKey: string;
  fallbackApiKey: string;
  timeoutMs: number;
  maxTokens: number;
}

/**
 * Resolve recall-synthesis adapter config from env. Uses the same
 * role-based env vars as the analysis adapter. Returns trimmed
 * strings; whitespace-only values are treated as absent.
 *
 * No provider is hardcoded. The primary slot is populated from
 * CURION_PRIMARY_BASE_URL, CURION_PRIMARY_MODEL, and
 * CURION_PRIMARY_API_KEY. If any of these is missing, the slot
 * is empty. The fallback slot is empty by default and is
 * populated only when all three CURION_FALLBACK_* vars are set.
 *
 * When apiFormat is "anthropic" and no base URL is provided,
 * the default is https://api.anthropic.com (Anthropic's official
 * endpoint). This is not a hardcoded provider default — the base
 * URL is part of the API format specification.
 */
export function loadRecallAdapterConfig(
  overrides: Partial<RecallAdapterConfig> = {},
): RecallAdapterConfig {
  const full = loadRoleConfig({
    defaults: {
      timeoutMs: RECALL_DEFAULT_TIMEOUT_MS,
      maxTokens: RECALL_DEFAULT_MAX_TOKENS,
    },
    // The recall role never uses strict JSON; the shared helper
    // gates the strict-JSON env vars behind this flag so the
    // returned values stay `false` regardless of the env.
    strictJson: false,
    overrides,
  });
  // The shared helper returns the full role config (including
  // the strict-JSON fields the recall role does not use). Strip
  // them here so the public return shape is unchanged from the
  // pre-refactor `RecallAdapterConfig`.
  return {
    primaryBaseUrl: full.primaryBaseUrl,
    primaryModel: full.primaryModel,
    primaryProviderLabel: full.primaryProviderLabel,
    primaryApiFormat: full.primaryApiFormat,
    fallbackBaseUrl: full.fallbackBaseUrl,
    fallbackModel: full.fallbackModel,
    fallbackProviderLabel: full.fallbackProviderLabel,
    fallbackApiFormat: full.fallbackApiFormat,
    primaryApiKey: full.primaryApiKey,
    fallbackApiKey: full.fallbackApiKey,
    timeoutMs: full.timeoutMs,
    maxTokens: full.maxTokens,
  };
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
//   - "anthropic"  -> "anthropic"
//   - "openai"     -> "openai"
//   - "groq"       -> "groq"
//   - "openrouter" -> "openrouter"
//   - "ollama"     -> "ollama"
//   - "lmstudio"   -> "lmstudio"
//   - "nvidia"     -> "nvidia-nim"
//   - "minimax"    -> "minimax"
//   - otherwise    -> "custom"
//
// This means swapping the primary/fallback base URLs in the
// future (or overriding them via env vars or MCP tool options)
// will automatically produce the correct label without any
// further code change.
// ---------------------------------------------------------------------------

/**
 * Derive a `RecallProviderId` from the base URL the request will
 * actually be sent to. The match is intentionally a case-
 * insensitive substring on the host portion so that env-style
 * overrides still resolve correctly.
 */
function resolveRecallProviderId(baseUrl: string): RecallProviderId {
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
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the user-role prompt for the synthesis call. The model is
 * asked to answer the query using ONLY the provided memory
 * summaries. The query is JSON-encoded so the model can clearly
 * see it as a delimiter-bounded user input; the controller does
 * not rely on the model to follow that delimiter for safety, but
 * the prompt also explicitly forbids the model from inventing
 * facts, returning raw dumps, or echoing the input verbatim.
 */
function buildSynthesisUserPrompt(
  query: string,
  memories: ReadonlyArray<RecallMemoryInput>,
): string {
  const lines: string[] = [];
  lines.push("Answer the QUERY using only the MEMORIES below.");
  lines.push(
    "Write a useful recall result. Include the relevant details from the memories that answer the query — names, decisions, dates, file paths, branches, and concrete specifics — not just a compressed summary.",
  );
  lines.push(
    "For broad orientation queries, identify the main themes and include the specific entities, decisions, and constraints that support each theme.",
  );
  lines.push(
    "Use multiple sentences when the query covers multiple topics or memories. Use as many sentences as needed to cover the relevant material; do not artificially compress.",
  );
  lines.push(
    "Write in continuous prose. Do not include memory IDs, bullets, headings, code blocks, raw logs, or instruction commentary.",
  );
  lines.push("Do not invent details that are not in the memories.");
  lines.push("If the memories do not answer the query, say: I don't have that information in memory.");
  lines.push("");
  lines.push("MEMORIES (id: summary):");
  for (const m of memories) {
    const kind = m.kind ? ` [${m.kind}]` : "";
    lines.push(`- #${m.id}${kind}: ${m.memoryContent}`);
  }
  lines.push("");
  lines.push("QUERY:");
  lines.push(JSON.stringify(query));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Run the recall synthesis with primary → fallback. Never throws on
 * expected failure paths; returns a discriminated union.
 *
 * The adapter DOES NOT validate the synthesized answer — that is
 * the controller's job. The adapter's contract is: best-effort
 * transport, return the raw text the model produced, or return a
 * typed failure.
 */
export async function synthesizeRecallWithFallback(
  query: string,
  memories: ReadonlyArray<RecallMemoryInput>,
  options: RecallSynthesisOptions = {},
): Promise<RecallSynthesisResult> {
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      ok: false,
      kind: "invalid-input",
      message: "synthesizeRecallWithFallback: `query` must be a non-empty string",
      httpCalls: 0,
    };
  }
  if (!Array.isArray(memories) || memories.length === 0) {
    // Defensive: the controller never calls us with an empty list,
    // but if it ever does, short-circuit without an HTTP call.
    return {
      ok: false,
      kind: "invalid-input",
      message: "synthesizeRecallWithFallback: `memories` must be a non-empty array",
      httpCalls: 0,
    };
  }

  const cfg = loadRecallAdapterConfig({
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
        "synthesizeRecallWithFallback: no provider api key configured (set CURION_PRIMARY_API_KEY or CURION_FALLBACK_API_KEY)",
      httpCalls: 0,
    };
  }

  // --- Primary attempt -------------------------------------------------
  // The primary provider id is derived from `cfg.primaryBaseUrl`
  // so the label in `providerLabel` / `providerUsed` / error
  // messages always matches the endpoint the request is sent to.
  const primaryProvider: RecallProviderId = (cfg.primaryProviderLabel as RecallProviderId)
    || resolveRecallProviderId(cfg.primaryBaseUrl);
  const primaryResult = cfg.primaryApiKey
    ? await runSynthesisCall({
        provider: primaryProvider,
        baseUrl: cfg.primaryBaseUrl,
        model: cfg.primaryModel,
        apiKey: cfg.primaryApiKey,
        timeoutMs: cfg.timeoutMs,
        maxTokens: cfg.maxTokens,
        query,
        memories,
        fetchImpl: options.fetchImpl,
        apiFormat: cfg.primaryApiFormat,
      })
    : {
        ok: false as const,
        message: "primary provider not configured",
        lastError: {
          kind: "missing-config" as const,
          message: `${primaryProvider}: no api key configured`,
          reachedServer: false,
        },
        httpCalls: 0,
      };

  if (primaryResult.ok) {
    return {
      ok: true,
      answer: primaryResult.answer,
      providerUsed: primaryResult.provider,
      modelUsed: primaryResult.model,
      fallbackUsed: false,
      latencyMs: primaryResult.latencyMs,
      httpCalls: primaryResult.httpCalls,
    };
  }

  if (options.disableFallback) {
    return {
      ok: false,
      kind: "all-providers-failed",
      message: primaryResult.message,
      lastError: primaryResult.lastError,
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
      httpCalls: primaryResult.httpCalls,
    };
  }

  // --- Fallback attempt (fresh, no state shared with primary) ----------
  // Same derivation rule as the primary: the label follows the
  // base URL, so a swapped or overridden fallback URL still
  // produces a label that matches the actual endpoint.
  const fallbackProvider: RecallProviderId = (cfg.fallbackProviderLabel as RecallProviderId)
    || resolveRecallProviderId(cfg.fallbackBaseUrl);
  const fallbackResult = await runSynthesisCall({
    provider: fallbackProvider,
    baseUrl: cfg.fallbackBaseUrl,
    model: cfg.fallbackModel,
    apiKey: cfg.fallbackApiKey,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    query,
    memories,
    fetchImpl: options.fetchImpl,
    apiFormat: cfg.fallbackApiFormat,
  });

  if (fallbackResult.ok) {
    return {
      ok: true,
      answer: fallbackResult.answer,
      providerUsed: fallbackResult.provider,
      modelUsed: fallbackResult.model,
      fallbackUsed: true,
      latencyMs: fallbackResult.latencyMs,
      httpCalls: primaryResult.httpCalls + fallbackResult.httpCalls,
    };
  }

  return {
    ok: false,
    kind: "all-providers-failed",
    message: `primary and fallback both failed: primary=${primaryResult.message}; fallback=${fallbackResult.message}`,
    lastError: fallbackResult.lastError ?? primaryResult.lastError,
    httpCalls: primaryResult.httpCalls + fallbackResult.httpCalls,
  };
}

// ---------------------------------------------------------------------------
// Per-provider attempt
// ---------------------------------------------------------------------------

interface SynthesisAttemptOk {
  ok: true;
  answer: string;
  provider: RecallProviderId;
  model: string;
  latencyMs: number;
  httpCalls: number;
}

interface SynthesisAttemptFail {
  ok: false;
  message: string;
  lastError?: ProviderError;
  httpCalls: number;
}

type SynthesisAttemptResult = SynthesisAttemptOk | SynthesisAttemptFail;

interface RunSynthesisArgs {
  provider: RecallProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  query: string;
  memories: ReadonlyArray<RecallMemoryInput>;
  fetchImpl: typeof fetch | undefined;
  apiFormat: RecallApiFormat;
}

async function runSynthesisCall(
  args: RunSynthesisArgs,
): Promise<SynthesisAttemptResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You write project-memory recall answers for another coding agent. Use only the provided memories. Answer in plain text only.",
    },
    {
      role: "user",
      content: buildSynthesisUserPrompt(args.query, args.memories),
    },
  ];

  const isAnthropic = args.apiFormat === "anthropic";
  const providerLabel = `${args.provider}/${args.model}#recall`;

  let answer: string;
  let latencyMs: number;

  if (isAnthropic) {
    const r = await anthropicChatCompletion(
      {
        model: args.model,
        messages,
        maxTokens: args.maxTokens,
        ...(args.fetchImpl !== undefined && { fetchImpl: args.fetchImpl }),
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
      },
      providerLabel,
    );
    if (!r.ok) {
      return {
        ok: false,
        message: `${args.provider}: hard failure (${r.error.kind}): ${r.error.message}`,
        lastError: r.error,
        httpCalls: 1,
      };
    }
    answer = r.result.response.content;
    latencyMs = r.result.response.latencyMs;
  } else {
    const r = await chatCompletion(
      {
        model: args.model,
        messages,
        temperature: 0,
        // No response_format hint: we want plain text.
        maxTokens: args.maxTokens,
      },
      {
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
        providerLabel,
      },
    );
    if (!r.ok) {
      return {
        ok: false,
        message: `${args.provider}: hard failure (${r.error.kind}): ${r.error.message}`,
        lastError: r.error,
        httpCalls: 1,
      };
    }
    answer = r.response.content;
    latencyMs = r.response.latencyMs;
  }

  if (typeof answer !== "string" || answer.trim().length === 0) {
    return {
      ok: false,
      message: `${args.provider}: empty response content`,
      httpCalls: 1,
    };
  }
  return {
    ok: true,
    answer,
    provider: args.provider,
    model: args.model,
    latencyMs,
    httpCalls: 1,
  };
}
