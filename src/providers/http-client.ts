/**
 * Provider HTTP client for the prototype.
 *
 * Scope (deliberately small):
 *   - Single OpenAI-compatible chat-completions call against an
 *     arbitrary base URL and model id.
 *   - Hard timeout (AbortController).
 *   - No automatic retries. A caller can opt in by calling again.
 *   - Basic error classification: network / timeout / auth / rate
 *     limit / bad request / server / unknown.
 *   - No logging of request bodies, response bodies, or auth headers.
 *
 * This client does not store or print any secret values. The caller
 * supplies the Authorization header value (or an `apiKey` that is
 * converted to `Bearer ...`); the value is not echoed in returned
 * error messages.
 *
 * Error-message sanitization:
 *   - The request's `apiKey` (and any additional caller-supplied
 *     secret strings) is redacted from any error message derived
 *     from a server response body or a network / fetch failure
 *     message.
 *   - Common secret patterns are also scrubbed defensively even
 *     when the caller did not pass them in: `Bearer ...` header
 *     values, known API-key prefixes (`sk-...`, `nvapi-...`), and
 *     JSON / form fields named `api_key`, `apiKey`, `token`,
 *     `authorization`, `password`, or `secret`.
 *   - Server error bodies are truncated to a safe length.
 */

export type ProviderErrorKind =
  | "missing-config"
  | "auth"
  | "rate-limit"
  | "bad-request"
  | "server"
  | "timeout"
  | "network"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  /** HTTP status code, if the failure came from a response. */
  status?: number;
  /** Human-readable, redacted message. Never includes the API key. */
  message: string;
  /** True if the request reached a server (vs. failed in transport). */
  reachedServer: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Provider response_format hint.
 *
 *   - `"json_object"` — request a JSON object. Implemented as
 *     `response_format: { type: "json_object" }`. The model is
 *     expected to return a JSON value but the schema is not
 *     enforced by the server.
 *   - `"text"` — explicitly opt out of any structured response_format.
 *   - `{ kind: "json_schema", schema, strict, name? }` — request a
 *     strict JSON-Schema constrained response. Implemented as
 *     `response_format: { type: "json_schema", json_schema: { ... } }`
 *     with `strict: true`. Not all providers support this; callers
 *     must only send it to providers that advertise support.
 */
export type ChatResponseFormat =
  | "json_object"
  | "text"
  | {
      kind: "json_schema";
      /**
       * The JSON Schema object that constrains the response.
       * For Groq strict mode, the schema MUST set
       * `additionalProperties: false` and list every key in
       * `properties` in `required` (Groq mirrors the OpenAI
       * strict-schema rules). The runner supplies a hand-built
       * schema that satisfies these constraints.
       */
      schema: Record<string, unknown>;
      /** True to require the provider to enforce the schema strictly. */
      strict: boolean;
      /** Optional schema name. Defaults to "response" if omitted. */
      name?: string;
    };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** Sampling temperature. Prototype uses 0 for deterministic parses. */
  temperature?: number;
  /** Optional response_format hint. Some providers ignore it. */
  responseFormat?: ChatResponseFormat;
  /** Cap on output tokens. */
  maxTokens?: number;
  /**
   * Optional reasoning effort hint (e.g. `"low"`, `"medium"`, `"high"`).
   * Forwarded verbatim to providers that advertise the parameter
   * (currently Groq). Not sent to providers that ignore or reject
   * unknown request fields. The runner only sets this for Groq.
   */
  reasoningEffort?: string;
}

export interface ChatCompletionResponse {
  id?: string;
  model: string;
  /** Combined text content from the first choice. */
  content: string;
  /** Raw finish_reason from the provider. */
  finishReason?: string;
  /** Provider-reported token usage, if present. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Latency measured by the client (ms). */
  latencyMs: number;
}

export interface ProviderClientOptions {
  /** Base URL, e.g. "https://api.example.com/v1". No trailing slash. */
  baseUrl: string;
  /** API key. Used as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Network timeout in milliseconds. */
  timeoutMs: number;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional provider name, used in error messages only. */
  providerLabel?: string;
}

/**
 * Run a single OpenAI-compatible chat completion. Returns either a
 * normalized response or a `ProviderError`. Never throws on expected
 * failure modes; throws only on programmer error (bad input).
 */
export async function chatCompletion(
  req: ChatCompletionRequest,
  options: ProviderClientOptions,
): Promise<{ ok: true; response: ChatCompletionResponse } | { ok: false; error: ProviderError }> {
  if (!options.apiKey) {
    return {
      ok: false,
      error: {
        kind: "missing-config",
        message: `${options.providerLabel ?? "provider"}: no api key configured`,
        reachedServer: false,
      },
    };
  }
  if (!options.baseUrl) {
    return {
      ok: false,
      error: {
        kind: "missing-config",
        message: `${options.providerLabel ?? "provider"}: no base url configured`,
        reachedServer: false,
      },
    };
  }
  if (!req.model) {
    throw new Error("chatCompletion: `model` is required");
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new Error("chatCompletion: `messages` must be a non-empty array");
  }

  const url = `${stripTrailingSlash(options.baseUrl)}/chat/completions`;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (req.responseFormat) {
    body.response_format = buildResponseFormat(req.responseFormat);
  }
  if (typeof req.maxTokens === "number") body.max_tokens = req.maxTokens;
  if (typeof req.reasoningEffort === "string" && req.reasoningEffort.length > 0) {
    body.reasoning_effort = req.reasoningEffort;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), options.timeoutMs);
  const start = Date.now();
  const f = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const rawMsg = (err as Error).message || String(err);
    // Defensively scrub the network-error message too: a fetch
    // failure can include a URL that contains the bearer token as
    // a query parameter, or a runtime may include the request
    // headers in the error text.
    const msg = sanitizeServerText(rawMsg, [options.apiKey]);
    if (ac.signal.aborted) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `${options.providerLabel ?? "provider"}: request timed out after ${options.timeoutMs}ms`,
          reachedServer: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message: `${options.providerLabel ?? "provider"}: network error (${latencyMs}ms): ${msg}`,
        reachedServer: false,
      },
    };
  }
  clearTimeout(timer);
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const text = await safeReadText(res);
    return {
      ok: false,
      error: classifyHttpError(
        res.status,
        text,
        options.providerLabel,
        options.apiKey,
      ),
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "bad-request",
        status: res.status,
        message: `${options.providerLabel ?? "provider"}: invalid JSON response: ${(err as Error).message}`,
        reachedServer: true,
      },
    };
  }

  const content = extractContent(json);
  if (content === undefined) {
    return {
      ok: false,
      error: {
        kind: "bad-request",
        status: res.status,
        message: `${options.providerLabel ?? "provider"}: response missing choices[0].message.content`,
        reachedServer: true,
      },
    };
  }

  return {
    ok: true,
    response: {
      id: stringOrUndefined((json as { id?: unknown }).id),
      model:
        stringOrUndefined((json as { model?: unknown }).model) ?? req.model,
      content,
      finishReason: stringOrUndefined(
        (json as { choices?: Array<{ finish_reason?: unknown }> }).choices?.[0]
          ?.finish_reason,
      ),
      usage: extractUsage(json),
      latencyMs,
    },
  };
}

function classifyHttpError(
  status: number,
  text: string,
  providerLabel?: string,
  apiKey?: string,
): ProviderError {
  const label = providerLabel ?? "provider";
  // Scrub the request's api key (if any) and any well-known
  // secret patterns from the server text before composing the
  // user-visible error message.
  const secretsToRedact: string[] = [];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    secretsToRedact.push(apiKey);
  }
  const safeText = sanitizeServerText(text, secretsToRedact);
  if (status === 401 || status === 403) {
    return { kind: "auth", status, message: `${label}: auth failed (HTTP ${status})`, reachedServer: true };
  }
  if (status === 408 || status === 504) {
    return { kind: "timeout", status, message: `${label}: gateway timeout (HTTP ${status})`, reachedServer: true };
  }
  if (status === 429) {
    return { kind: "rate-limit", status, message: `${label}: rate limited (HTTP 429)`, reachedServer: true };
  }
  if (status >= 500) {
    return { kind: "server", status, message: `${label}: server error (HTTP ${status}): ${safeText}`, reachedServer: true };
  }
  if (status >= 400) {
    return { kind: "bad-request", status, message: `${label}: bad request (HTTP ${status}): ${safeText}`, reachedServer: true };
  }
  return { kind: "unknown", status, message: `${label}: unexpected HTTP ${status}: ${safeText}`, reachedServer: true };
}

/**
 * Redact secret-like values from a server-provided text snippet
 * (response body or transport-level error message) and truncate
 * to a safe length.
 *
 * Caller-supplied `knownSecrets` are removed first (case
 * sensitive, exact-match substring). In addition, the following
 * defensive patterns are always scrubbed:
 *
 *   - `Bearer <token>` and `Authorization: ...` header values
 *   - Common API-key prefixes: `sk-...`, `nvapi-...`
 *   - JSON / form fields named `api_key`, `apiKey`, `token`,
 *     `authorization`, `password`, or `secret`, with a string
 *     value: replaced with the field name and `"<redacted>"`.
 *
 * The result is whitespace-collapsed and truncated to 240 chars.
 */
export function sanitizeServerText(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  if (typeof text !== "string") return "";
  let t = text;
  // 1) Caller-supplied known secrets.
  for (const s of knownSecrets) {
    if (typeof s === "string" && s.length >= 4) {
      t = t.split(s).join("<redacted>");
    }
  }
  // 2) Authorization: Bearer <token> and Bearer <token> in any context.
  t = t.replace(
    /(authorization\s*[:=]\s*"?bearer\s+)([^\s"',}\]]+)/gi,
    "$1<redacted>",
  );
  t = t.replace(/\bbearer\s+([A-Za-z0-9._\-+/=]{6,})/gi, "Bearer <redacted>");
  // 3) Common API-key prefixes. Use a length cutoff so we do not
  //    nuke short IDs that happen to start with "sk-".
  t = t.replace(/\bsk-[A-Za-z0-9_\-]{16,}\b/g, "sk-<redacted>");
  t = t.replace(/\bnvapi-[A-Za-z0-9_\-]{16,}\b/g, "nvapi-<redacted>");
  // 4) Named JSON / form fields whose value is a string.
  t = t.replace(
    /("(?:api[_-]?key|apikey|token|authorization|password|secret)"\s*:\s*)"([^"]*)"/gi,
    '$1"<redacted>"',
  );
  // Collapse whitespace and truncate.
  t = t.replace(/\s+/g, " ").trim();
  return t.length > 240 ? `${t.slice(0, 240)}...` : t;
}

function safeReadText(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function extractContent(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as { message?: unknown }).message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  // Some providers return `text` directly.
  const text = (first as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return undefined;
}

function extractUsage(json: unknown): ChatCompletionResponse["usage"] {
  if (!json || typeof json !== "object") return undefined;
  const u = (json as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return undefined;
  const obj = u as Record<string, unknown>;
  return {
    promptTokens: numberOrUndefined(obj.prompt_tokens),
    completionTokens: numberOrUndefined(obj.completion_tokens),
    totalTokens: numberOrUndefined(obj.total_tokens),
  };
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Translate a `ChatResponseFormat` into the OpenAI-compatible
 * `response_format` field. Pure function, exported for tests.
 */
export function buildResponseFormat(
  rf: ChatResponseFormat,
): Record<string, unknown> {
  if (rf === "json_object") return { type: "json_object" };
  if (rf === "text") return { type: "text" };
  const inner: Record<string, unknown> = {
    schema: rf.schema,
    strict: rf.strict === true,
  };
  if (typeof rf.name === "string" && rf.name.length > 0) {
    inner.name = rf.name;
  } else {
    inner.name = "response";
  }
  return { type: "json_schema", json_schema: inner };
}
