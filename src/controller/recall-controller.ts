/**
 * `recall(text)` controller.
 *
 * Orchestrates the narrow MVP pipeline:
 *
 *   1. Defensive shape check on the query string (handled at the
 *      tool boundary, not repeated here).
 *   2. Safety pre-check on the query. A query that contains a
 *      secret-shaped fragment is rejected — we do not log it, we
 *      do not forward it to the provider, and we do not use it to
 *      search stored memories. The public response is a rejection
 *      message that does not echo the query.
 *   3. Read the safe stored memory summaries from local storage.
 *   4. Lexically rank the stored summaries against the query.
 *      If none passes the relevance threshold, return
 *      `no_memory` and DO NOT call the provider.
 *   5. If relevant memories exist, send the small set of top
 *      summaries to the recall-synthesis provider and ask it to
 *      answer the query from memory only.
 *   6. Validate the synthesized answer: non-empty, bounded length,
 *      no obvious secret-shaped fragments, no obvious raw-dump
 *      shape. If validation fails, return `provider_error` (we
 *      never expose an unsafe or fabricated public answer).
 *   7. Return the synthesized answer to the tool layer.
 *
 * Design notes:
 *   - The controller never calls the provider with raw user text.
 *     The query is passed to the provider only as a search
 *     instruction inside the synthesis prompt, and the synthesis
 *     prompt itself never echoes the query back as the answer
 *     (it asks the model to answer FROM memories only).
 *   - The controller never persists the recall query, the
 *     provider's raw response, or the synthesized answer. The
 *     recall MVP is read-only against the memories table.
 *   - The controller never logs the raw query text. It logs a
 *     short, redacted reason on the pre-check, and a fixed-shape
 *     debug line on the storage read / provider call, with no
 *     secret fragments.
 */

import { classifyInput } from "../safety/precheck.js";
import {
  listActiveMemorySummaries,
  type SafeMemorySummary,
  type StorageHandle,
} from "../storage/storage.js";
import {
  rankLexical,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOP_K,
  type LexicalScoredCandidate,
} from "../retrieval/lexical.js";
import {
  synthesizeRecallWithFallback,
  type RecallSynthesisOptions,
  type RecallSynthesisResult,
  type RecallMemoryInput,
} from "../providers/recall-synthesis.js";
import { redactSummary } from "../safety/precheck.js";
import { logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public outcome of the recall controller. */
export type RecallOutcome =
  | {
      status: "answered";
      answer: string;
      /** Memory ids the answer was synthesized from (in rank order). */
      sourceIds: number[];
    }
  | { status: "no_memory" }
  | { status: "rejected"; reason: string; safetyClass: string }
  | { status: "provider_error"; reason: string };

/** Controller options. Most fields have safe defaults. */
export interface RecallControllerOptions {
  /** Minimum lexical score to keep a candidate. Default 0.2. */
  relevanceThreshold?: number;
  /** Max number of top summaries sent to the provider. Default 5. */
  topK?: number;
  /** Max accepted synthesis answer length. Default 800. */
  maxAnswerLength?: number;
  /** Optional fetch override for tests. */
  providerFetchImpl?: typeof fetch;
  /** Optional API key override for the primary provider. */
  providerPrimaryApiKey?: string;
  /** Optional API key override for the fallback provider. */
  providerFallbackApiKey?: string;
  /** Optional base URL override for the primary provider. */
  providerPrimaryBaseUrl?: string;
  /** Optional base URL override for the fallback provider. */
  providerFallbackBaseUrl?: string;
  /** Optional model id override for the primary provider. */
  providerPrimaryModel?: string;
  /** Optional model id override for the fallback provider. */
  providerFallbackModel?: string;
  /** Max number of stored summaries scanned. Default 200. */
  storageLimit?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ANSWER_LENGTH = 800;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Run the narrow MVP `recall` pipeline.
 *
 * Public MCP API is unchanged. This function is consumed by
 * `src/tools/recall.ts`. The controller never throws on expected
 * failure paths; it returns a discriminated union.
 *
 * Important behavior:
 *   - If no stored memory passes the relevance threshold, the
 *     provider is NOT called. We return `no_memory`.
 *   - If the query contains a secret-shaped fragment, the provider
 *     is NOT called and the query is NOT used for retrieval. We
 *     return `rejected` (the public message does not echo the
 *     query). The query text is not logged.
 *   - If the provider fails, we return `provider_error` with a
 *     short, redacted reason. We never fabricate an answer.
 *   - If the provider's answer is empty, exceeds the length cap,
 *     or contains a secret-shaped fragment or a raw-dump shape,
 *     we return `provider_error`. We never expose an unsafe
 *     public answer.
 */
export async function runRecallController(
  storage: StorageHandle,
  query: string,
  options: RecallControllerOptions = {},
): Promise<RecallOutcome> {
  const threshold = options.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const maxLen = options.maxAnswerLength ?? DEFAULT_MAX_ANSWER_LENGTH;
  const storageLimit = options.storageLimit ?? 200;

  // -- 1. Safety pre-check on the query -------------------------------
  //
  // Decision (safer temporary default): reject queries that contain
  // obvious secrets. This matches the remember controller's policy
  // on inputs: secret-shaped fragments must not be forwarded to a
  // provider or used to search storage. The MCP schema already
  // rejects empty queries at the tool boundary; we add this layer
  // as defense in depth. The public message does not echo the
  // query.
  const safety = classifyInput(query);
  logger.debug(
    `recall: pre-check class=${safety.class} reason=${safety.reason}`,
  );
  if (safety.class === "secret") {
    return {
      status: "rejected",
      reason:
        "query contains a secret-shaped fragment; refusing to search or forward it",
      safetyClass: "secret",
    };
  }
  if (safety.class === "mixed-safe-sensitive") {
    return {
      status: "rejected",
      reason:
        "query mixes safe and sensitive fragments; please rephrase the query to remove the sensitive part",
      safetyClass: "mixed-safe-sensitive",
    };
  }
  // Note: we intentionally do NOT route prompt-injection /
  // unsafe-preference / raw-dump / self-conflict / vague-junk
  // inputs to a hard reject here. The recall path is read-only
  // and read-only queries are less dangerous than remember
  // inputs (no persistence, no per-record mutation). A vague
  // query simply yields no matches. The downstream lexical
  // ranker handles them naturally.

  // -- 2. Read safe stored summaries ----------------------------------
  const summaries = listActiveMemorySummaries(storage, {
    limit: storageLimit,
  });
  logger.debug(
    `recall: read ${summaries.length} safe summary(ies) from storage`,
  );

  // -- 3. Lexical ranking ---------------------------------------------
  const ranked: LexicalScoredCandidate[] = rankLexical(
    query,
    summaries.map((s: SafeMemorySummary) => ({
      id: s.id,
      text: s.summary,
      tags: s.tags,
    })),
    { threshold, topK },
  );
  if (ranked.length === 0) {
    logger.debug("recall: no relevant memory; skipping provider call");
    return { status: "no_memory" };
  }
  // Re-attach summaries in the order returned by the ranker.
  // ranked already carries the score-sorted order. We use a
  // single O(N) map lookup so this stays linear even if the
  // store grows.
  const summaryById = new Map<number, SafeMemorySummary>(
    summaries.map((s) => [s.id, s]),
  );
  const topSummaries: SafeMemorySummary[] = [];
  for (const r of ranked) {
    const s = summaryById.get(r.id);
    if (s) topSummaries.push(s);
  }
  // Sanity: every ranked id must have a summary. If this ever
  // fails, it means a memory was deleted between the read and
  // the rank — fall back to no_memory rather than fabricating.
  if (topSummaries.length !== ranked.length) {
    logger.debug(
      "recall: ranked-id missing summary (storage raced); returning no_memory",
    );
    return { status: "no_memory" };
  }

  // -- 4. Provider synthesis -----------------------------------------
  const adapterOptions: RecallSynthesisOptions = {};
  if (options.providerFetchImpl !== undefined) {
    adapterOptions.fetchImpl = options.providerFetchImpl;
  }
  if (options.providerPrimaryApiKey !== undefined) {
    adapterOptions.primaryApiKey = options.providerPrimaryApiKey;
  }
  if (options.providerFallbackApiKey !== undefined) {
    adapterOptions.fallbackApiKey = options.providerFallbackApiKey;
  }
  if (options.providerPrimaryBaseUrl !== undefined) {
    adapterOptions.primaryBaseUrl = options.providerPrimaryBaseUrl;
  }
  if (options.providerFallbackBaseUrl !== undefined) {
    adapterOptions.fallbackBaseUrl = options.providerFallbackBaseUrl;
  }
  if (options.providerPrimaryModel !== undefined) {
    adapterOptions.primaryModel = options.providerPrimaryModel;
  }
  if (options.providerFallbackModel !== undefined) {
    adapterOptions.fallbackModel = options.providerFallbackModel;
  }

  const memories: RecallMemoryInput[] = topSummaries.map((s) => ({
    id: s.id,
    summary: s.summary,
    kind: s.kind,
    tags: s.tags,
  }));
  const result: RecallSynthesisResult = await synthesizeRecallWithFallback(
    query,
    memories,
    adapterOptions,
  );

  if (!result.ok) {
    logger.debug(`recall: provider error: ${result.kind} (${result.message})`);
    return {
      status: "provider_error",
      reason: result.message,
    };
  }

  // -- 5. Validate the synthesized answer ----------------------------
  const validation = validateAnswer(result.answer, maxLen);
  if (!validation.ok) {
    logger.debug(
      `recall: provider answer rejected: ${validation.reason}`,
    );
    return {
      status: "provider_error",
      reason: validation.reason,
    };
  }
  // Use the redacted form so any secret-shaped fragment the
  // model produced (defense in depth) is removed before we hand
  // the text to the tool layer. The validator above already
  // rejected answers that are entirely or mostly redacted.
  const safeAnswer = validation.answer;
  return {
    status: "answered",
    answer: safeAnswer,
    sourceIds: topSummaries.map((s) => s.id),
  };
}

// ---------------------------------------------------------------------------
// Internal answer validation
// ---------------------------------------------------------------------------

interface AnswerOk {
  ok: true;
  /** Validated + redacted answer text. */
  answer: string;
}

interface AnswerFail {
  ok: false;
  reason: string;
}

/**
 * Strip provider-side reasoning blocks from the answer text so the
 * public output is the visible answer only.
 *
 * Removes, in order:
 *   1. `<think>...</think>` blocks — multiline, case-insensitive.
 *   2. `<thinking>...</thinking>` blocks — multiline, case-insensitive.
 *   3. A single leading `Reasoning:` or `Thought:` block — bounded
 *      to the first 2000 chars and only stripped when followed by
 *      a blank line and visible answer text. This is intentionally
 *      conservative: it must not eat the real answer if the model
 *      just happened to use the word "Reasoning" in normal prose.
 *
 * The function never throws and never expands the input. If nothing
 * matches, the input is returned (trimmed) unchanged.
 */
function stripReasoningBlocks(answer: string): string {
  if (typeof answer !== "string" || answer.length === 0) return answer;
  let text = answer;
  // 1) and 2): HTML-style reasoning tags, multiline, case-insensitive.
  // The `s` flag (dotAll) lets `.` match newlines.
  text = text.replace(
    /<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi,
    "",
  );
  // 3) Bounded leading "Reasoning:" / "Thought:" blocks. We only
  // strip when (a) the block is at the start of the text (after
  // trimming), (b) the label is exactly "Reasoning:" or "Thought:"
  // (not a normal sentence that happens to start with the word),
  // and (c) the block is followed by a blank line before the
  // visible answer. This avoids eating legitimate prose.
  const leadingLabelMatch = text.match(
    /^\s*(?:Reasoning|Thought)\s*:\s*([\s\S]{0,2000}?)(?:\n\s*\n|\n\s*$)/i,
  );
  if (leadingLabelMatch && leadingLabelMatch.index !== undefined) {
    const before = text.slice(0, leadingLabelMatch.index);
    const tail = text.slice(leadingLabelMatch.index + leadingLabelMatch[0].length);
    // Only strip if the visible tail has substantive answer text.
    if (tail.trim().length >= 1) {
      text = (before + tail).trimStart();
    }
  }
  return text;
}

function validateAnswer(answer: string, maxLen: number): AnswerOk | AnswerFail {
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return { ok: false, reason: "provider returned an empty answer" };
  }
  // Strip provider reasoning blocks (`<think>...</think>`,
  // `<thinking>...</thinking>`, leading `Reasoning:` / `Thought:`)
  // before validation. This keeps the public output free of the
  // model's internal scratchpad while preserving the visible
  // answer.
  const stripped0 = stripReasoningBlocks(answer).trim();
  if (stripped0.length === 0) {
    return {
      ok: false,
      reason: "provider answer was only reasoning; no visible answer to return",
    };
  }
  // Normalize whitespace and bound length.
  let text = stripped0.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ");
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen).trimEnd()}…`;
  }
  // Defense in depth: redact any secret-shaped fragment that the
  // provider may have echoed.
  const redacted = redactSummary(text);
  const stripped = redacted.replace(/<redacted>/g, "").trim();
  if (stripped.length === 0) {
    return {
      ok: false,
      reason: "provider answer was entirely redacted as secret content",
    };
  }
  if (stripped.length < 10) {
    return {
      ok: false,
      reason:
        "provider answer contained insufficient non-secret content after redaction",
    };
  }
  if (looksLikeRawDump(redacted)) {
    return {
      ok: false,
      reason:
        "provider answer looks like a raw dump rather than a synthesized answer",
    };
  }
  return { ok: true, answer: redacted };
}

function looksLikeRawDump(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  let dumpLines = 0;
  for (const l of lines) {
    if (/^[A-Z][A-Z0-9_]{2,}=.+$/.test(l)) dumpLines += 1;
    if (/^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(l)) dumpLines += 1;
  }
  return dumpLines / lines.length > 0.6;
}
