/**
 * Native Anthropic Claude provider adapter.
 *
 * Uses the official `@anthropic-ai/sdk` to call the Anthropic Messages API
 * when `apiFormat` is `"anthropic"`. This is a separate code path from
 * the OpenAI-compatible HTTP client used for `apiFormat === "openai-compatible"`.
 *
 * Key differences from OpenAI-compatible path:
 *   - System prompt is a top-level `system` field, not a `role: "system"` message.
 *   - Response content is in `message.content[]` blocks with `type: "text"`.
 *   - Uses `max_tokens` directly (not `max_completion_tokens`).
 *   - Base URL defaults to `https://api.anthropic.com` when apiFormat is
 *     `anthropic` and no base URL is supplied.
 *
 * Security:
 *   - API key values are never included in any returned field or error message.
 *   - The SDK handles the Authorization header internally; we pass the key
 *     as an option and the client redacts it from any error messages we
 *     receive via the `cause` chain.
 *   - No request/response bodies are logged by this module.
 *
 * Strict JSON:
 *   - Not implemented for Anthropic in this initial version. If `strictJson`
 *     is requested, we fall through to prompt-delimited JSON parsing (the
 *     default behavior). Structured output via Anthropic's beta APIs is
 *     deferred until the SDK types definitively confirm stable public
 *     parameters.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ProviderError,
  ProviderErrorKind,
} from "./http-client.js";

/** Anthropic SDK message role. */
type AnthropicRole = "user" | "assistant" | "system";

/** A message in Anthropic's format. */
interface AnthropicMessage {
  role: AnthropicRole;
  content: string;
}

/** Options for the Anthropic chat completion. */
export interface AnthropicChatOptions {
  /** Model id, e.g. "claude-sonnet-4-5". */
  model: string;
  /**
   * Messages in OpenAI-compatible format. The first `role: "system"`
   * message (if any) is extracted and used as the top-level `system`
   * field; remaining messages are passed through with roles mapped.
   */
  messages: ChatMessage[];
  /** Cap on output tokens. */
  maxTokens: number;
  /**
   * Optional fetch override for tests.
   * Note: the Anthropic SDK accepts `fetch` in its constructor options.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional base URL override. When apiFormat is "anthropic" and this
   * is not supplied, defaults to `https://api.anthropic.com`.
   */
  baseUrl?: string;
  /**
   * API key. Used as `Authorization: Bearer <key>` by the SDK.
   * Must not be echoed in any error message.
   */
  apiKey: string;
  /**
   * Network timeout in milliseconds. Passed to the SDK client.
   */
  timeoutMs: number;
}

/** Result shape from the Anthropic path, matching the OpenAI-compatible contract. */
export interface AnthropicChatResult {
  response: {
    id?: string;
    model: string;
    content: string;
    finishReason?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    latencyMs: number;
  };
}

/** Build an Anthropic SDK client configured with the given options. */
function buildSdkClient(opts: AnthropicChatOptions): Anthropic {
  const clientOpts: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: opts.apiKey,
    maxRetries: 0, // We handle retries at the adapter level.
    timeout: opts.timeoutMs,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  };
  return new Anthropic(clientOpts);
}

/**
 * Convert OpenAI-compatible `ChatMessage[]` into Anthropic message format.
 * Extracts the first `role: "system"` message and returns it separately
 * as the top-level `system` param; all other messages are converted.
 *
 * Anthropic only accepts `role: "user"` and `role: "assistant"` in the
 * messages array. A `role: "system"` message is not valid in the messages
 * array and must be passed as the top-level `system` field.
 */
function convertMessages(
  messages: ChatMessage[],
): { system: string | undefined; converted: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user" || msg.role === "assistant") {
      converted.push({ role: msg.role, content: msg.content });
    }
    // Unknown roles are skipped silently.
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    converted,
  };
}

/**
 * Extract the combined text content from Anthropic `ContentBlock[]`.
 * Returns the concatenated text of all `type: "text"` blocks, or undefined
 * if no text block is found.
 */
function extractTextContent(
  content: Anthropic.Message["content"],
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/**
 * Map SDK errors into the adapter's `ProviderError` shape without leaking
 * the API key. The SDK surfaces auth/configuration errors via `cause`
 * chains; we scrub any key-shaped values from the message text.
 */
function mapSdkError(
  err: unknown,
  providerLabel: string,
  apiKey: string,
): ProviderError {
  const rawMsg = (err instanceof Error) ? err.message : String(err);
  const safeMsg = sanitizeForKey(rawMsg, apiKey);
  const kind = classifyAnthropicError(err, safeMsg);

  // Extract HTTP status from SDK error types (AuthenticationError, etc.).
  // These errors have status as a typed property; connection/timeout
  // errors have status === undefined.
  let status: number | undefined;
  if (err instanceof Anthropic.APIError) {
    const s = (err as unknown as { status: unknown }).status;
    if (typeof s === "number") status = s;
  }

  // Walk the error cause chain to find the most specific message.
  let detail = safeMsg;
  let cursor: unknown = err;
  const seen = new Set<object>();
  while (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== "object") break;
    if (seen.has(cursor as object)) break;
    seen.add(cursor as object);
    const e = cursor as Record<string, unknown>;
    if (typeof e.message === "string" && e.message.length > 0 && e.message !== safeMsg) {
      // Prefer a nested message that adds signal without leaking secrets.
      const nested = sanitizeForKey(e.message, apiKey);
      if (nested !== safeMsg) {
        detail = `${detail}: ${nested}`;
      }
    }
    cursor = e.cause;
  }

  return {
    kind,
    ...(status !== undefined ? { status } : {}),
    message: `${providerLabel}: ${detail}`,
    reachedServer: isServerReached(err),
  };
}

/**
 * Classify an Anthropic SDK error into a `ProviderErrorKind`.
 * Uses the error constructor name and, where available, the status code.
 */
function classifyAnthropicError(err: unknown, safeMsg: string): ProviderErrorKind {
  if (err instanceof Anthropic.AuthenticationError) return "auth";
  if (err instanceof Anthropic.RateLimitError) return "rate-limit";
  if (err instanceof Anthropic.BadRequestError) return "bad-request";
  if (err instanceof Anthropic.NotFoundError) return "bad-request";
  if (err instanceof Anthropic.InternalServerError) return "server";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "network";

  //宁可错杀，不可放过
  if (safeMsg.includes("timeout") || safeMsg.includes("timed out")) return "timeout";
  if (safeMsg.includes("401") || safeMsg.includes("403") || safeMsg.includes("authentication")) return "auth";
  if (safeMsg.includes("429") || safeMsg.includes("rate limit")) return "rate-limit";
  if (safeMsg.includes("500") || safeMsg.includes("502") || safeMsg.includes("503") || safeMsg.includes("server error")) return "server";
  if (safeMsg.includes("400") || safeMsg.includes("bad request") || safeMsg.includes("invalid")) return "bad-request";

  return "unknown";
}

/**
 * Heuristically determine whether the error indicates the server was reached.
 * The SDK's error types are definitive when available.
 *
 * Key distinction: `APIError` has a `status` field. Connection errors
 * (`APIConnectionError`, `APIConnectionTimeoutError`) extend `APIError`
 * but have `status: undefined` — they failed before reaching the server.
 * All other `APIError` subclasses have a defined HTTP status code.
 */
function isServerReached(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // Connection errors extend APIError but have status === undefined.
    // These did NOT reach the server.
    const status = (err as unknown as { status: unknown }).status;
    return status !== undefined;
  }
  if (err instanceof Anthropic.AnthropicError) return true;
  if (err instanceof Error) {
    // A cause chain that includes a Response or a fetch-type error
    // with a status code suggests the server was reached.
    let cursor: unknown = err;
    const seen = new Set<object>();
    while (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== "object") break;
      if (seen.has(cursor as object)) break;
      seen.add(cursor as object);
      const e = cursor as Record<string, unknown>;
      if (e instanceof Response) return true;
      if (typeof e.status === "number") return true;
      cursor = e.cause;
    }
  }
  return false;
}

/**
 * Scrub the API key and common secret patterns from a text string.
 * Mirrors the approach in `http-client.ts` for consistency.
 */
function sanitizeForKey(text: string, apiKey: string): string {
  if (typeof text !== "string") return "";
  let t = text;
  if (typeof apiKey === "string" && apiKey.length >= 4) {
    t = t.split(apiKey).join("<redacted>");
  }
  // Defensively scrub Bearer tokens and common key prefixes.
  t = t.replace(/(authorization\s*[:=]\s*"?bearer\s+)([^\s"',}\]]+)/gi, "$1<redacted>");
  t = t.replace(/\bbearer\s+([A-Za-z0-9._\-+/=]{6,})/gi, "Bearer <redacted>");
  t = t.replace(/\bsk-[A-Za-z0-9_\-]{16,}\b/g, "sk-<redacted>");
  t = t.replace(/\bnvapi-[A-Za-z0-9_\-]{16,}\b/g, "nvapi-<redacted>");
  t = t.replace(
    /("(?:api[_-]?key|apikey|token|authorization|password|secret)"\s*:\s*)"([^"]*)"/gi,
    '$1"<redacted>"',
  );
  t = t.replace(/\s+/g, " ").trim();
  return t.length > 240 ? `${t.slice(0, 240)}...` : t;
}

/**
 * Run a chat completion against the Anthropic Messages API.
 *
 * Returns either a normalized result (matching the OpenAI-compatible
 * `ChatCompletionResponse` contract) or a `ProviderError`.
 *
 * This function never throws; all expected error paths return a
 * `{ ok: false, error: ProviderError }` result.
 */
export async function anthropicChatCompletion(
  opts: AnthropicChatOptions,
  providerLabel = "anthropic",
): Promise<{ ok: true; result: AnthropicChatResult } | { ok: false; error: ProviderError }> {
  if (!opts.apiKey) {
    return {
      ok: false,
      error: {
        kind: "missing-config",
        message: `${providerLabel}: no api key configured`,
        reachedServer: false,
      },
    };
  }

  if (!opts.model) {
    return {
      ok: false,
      error: {
        kind: "missing-config",
        message: `${providerLabel}: no model configured`,
        reachedServer: false,
      },
    };
  }

  const { system, converted } = convertMessages(opts.messages);
  if (converted.length === 0) {
    return {
      ok: false,
      error: {
        kind: "bad-request",
        message: `${providerLabel}: no user/assistant messages to send`,
        reachedServer: false,
      },
    };
  }

  const client = buildSdkClient(opts);
  const start = Date.now();

  try {
    const message = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      ...(system ? { system } : {}),
      messages: converted,
    });

    const latencyMs = Date.now() - start;
    const content = extractTextContent(message.content);

    if (content === undefined) {
      return {
        ok: false,
        error: {
          kind: "bad-request",
          message: `${providerLabel}: response missing text content block`,
          reachedServer: true,
        },
      };
    }

    return {
      ok: true,
      result: {
        response: {
          id: message.id,
          model: message.model,
          content,
          finishReason: message.stop_reason ?? undefined,
          usage: {
            promptTokens: message.usage.input_tokens,
            completionTokens: message.usage.output_tokens,
            totalTokens:
              (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0),
          },
          latencyMs,
        },
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      error: {
        ...mapSdkError(err, providerLabel, opts.apiKey),
        // Overwrite reachedServer based on actual error analysis.
        reachedServer: isServerReached(err),
      },
    };
  }
}
