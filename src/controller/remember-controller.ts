/**
 * `remember(text)` controller.
 *
 * Orchestrates the narrow MVP pipeline:
 *
 *   1. Validate the input shape (handled at the tool boundary).
 *   2. Safety pre-check. Reject or clarify before the provider call.
 *   3. Related-memory lookup seam (placeholder; empty for MVP).
 *   4. Provider call via the real adapter.
 *   5. Validate + normalize the provider result.
 *   6. If valid, persist the sanitized summary + metadata.
 *   7. Return a stable structured result the tool can serialize.
 *
 * The controller is the single owner of the safety pre-check policy,
 * the confidence threshold, and the mapping from provider
 * classification to internal kind. The tool layer is intentionally
 * thin: parse input, call controller, format the public response.
 *
 * The controller never receives a raw input and never returns a raw
 * input. The tool layer is the only boundary at which the raw input
 * is held; it is passed by reference to the safety pre-check (which
 * uses it read-only) and to the provider adapter (which sends it to
 * the model and never echoes it back).
 */

import {
  analyzeMemoryWithFallback,
  type MemoryAnalysisResult,
  type RelatedMemory,
} from "../providers/memory-analysis.js";
import type { MemoryAnalysis } from "../prototype/structured-output.js";
import { classifyInput, redactSummary } from "../safety/precheck.js";
import { findRelatedMemories } from "../retrieval/seam.js";
import {
  insertMemoryRecord,
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
  type StorageHandle,
} from "../storage/storage.js";
import { logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public outcome of the controller. */
export type RememberOutcome =
  | { status: "saved"; record: MemoryRecord; message: string }
  | { status: "rejected"; reason: string; safetyClass: string }
  | { status: "clarification_needed"; question: string; reason: string }
  | { status: "provider_error"; reason: string };

/** Controller options. Most fields have safe defaults. */
export interface RememberControllerOptions {
  /**
   * Confidence threshold below which the controller returns
   * `clarification_needed` instead of saving. Default `0.5`.
   */
  confidenceThreshold?: number;
  /**
   * Max accepted summary length. Provider summaries above this are
   * truncated to the cap before persistence. Default `500`.
   */
  maxSummaryLength?: number;
  /**
   * Optional fetch override passed through to the provider adapter.
   * Test-only: production code does not set this. Used by the test
   * suite to drive the real adapter with a scripted `fetch` so no
   * network access is required.
   */
  providerFetchImpl?: typeof fetch;
  /**
   * Optional API key override for the provider adapter. Test-only:
   * lets the test set a placeholder key without touching the real
   * process env. If set, the controller passes it to
   * `analyzeMemoryWithFallback` for the primary provider.
   */
  providerPrimaryApiKey?: string;
  /**
   * Optional API key override for the provider adapter fallback.
   * Test-only. See `providerPrimaryApiKey`.
   */
  providerFallbackApiKey?: string;
  /**
   * Optional base URL override for the primary provider (test-only).
   */
  providerPrimaryBaseUrl?: string;
  /**
   * Optional base URL override for the fallback provider (test-only).
   */
  providerFallbackBaseUrl?: string;
  /**
   * Optional model id override for the primary provider (test-only).
   */
  providerPrimaryModel?: string;
  /**
   * Optional model id override for the fallback provider (test-only).
   */
  providerFallbackModel?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
export const DEFAULT_MAX_SUMMARY_LENGTH = 500;

/** Internal kind mapping table: provider classification -> internal kind. */
const CLASSIFICATION_TO_KIND: Record<string, MemoryKind> = {
  decision: "decision",
  "project-decision": "decision",
  fact: "fact",
  "project-fact": "fact",
  preference: "preference",
  context: "context",
  "project-context": "context",
  conflict: "conflict",
  "conflict-poisoning": "conflict",
  reference: "reference",
  finding: "finding",
};

/**
 * Mapping from the provider's `classification` field to the internal
 * `MemoryKind` enum. Unknown values map to `finding` (the safe
 * fallback). The match is case-insensitive and trimmed.
 */
function mapProviderKindToInternal(
  providerKind: string | undefined,
): MemoryKind {
  if (!providerKind) return "finding";
  const key = providerKind.trim().toLowerCase();
  if (!key) return "finding";
  for (const k of MEMORY_KINDS) {
    if (key === k) return k;
  }
  if (key in CLASSIFICATION_TO_KIND) {
    return CLASSIFICATION_TO_KIND[key] ?? "finding";
  }
  return "finding";
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Run the narrow MVP `remember` pipeline.
 *
 * Public MCP API is unchanged. This function is consumed by
 * `src/tools/remember.ts`. The controller never throws on expected
 * failure paths; it returns a discriminated union.
 */
export async function runRememberController(
  storage: StorageHandle,
  rawInput: string,
  options: RememberControllerOptions = {},
): Promise<RememberOutcome> {
  const confidenceThreshold =
    options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxSummaryLength =
    options.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH;

  // -- 1. Safety pre-check (no provider call yet) --------------------
  const safety = classifyInput(rawInput);
  logger.debug(
    `remember: pre-check class=${safety.class} reason=${safety.reason}`,
  );
  if (safety.class === "secret") {
    return {
      status: "rejected",
      reason:
        "input contains a secret-shaped fragment; refusing to store or forward it",
      safetyClass: "secret",
    };
  }
  if (safety.class === "mixed-safe-sensitive") {
    return {
      status: "rejected",
      reason:
        "input mixes safe and sensitive fragments; please resubmit only the safe project knowledge as a separate memory",
      safetyClass: "mixed-safe-sensitive",
    };
  }
  if (safety.class === "prompt-injection") {
    return {
      status: "rejected",
      reason:
        "input contains instruction-override or future-agent-instruction language; refusing to store or forward it",
      safetyClass: "prompt-injection",
    };
  }
  if (safety.class === "unsafe-preference") {
    return {
      status: "rejected",
      reason:
        "input asks to weaken safety or persistence policy; refusing to store or forward it",
      safetyClass: "unsafe-preference",
    };
  }
  if (safety.class === "raw-dump") {
    return {
      status: "rejected",
      reason: safety.reason,
      safetyClass: "raw-dump",
    };
  }
  if (safety.class === "vague-junk") {
    return {
      status: "rejected",
      reason: safety.reason,
      safetyClass: "vague-junk",
    };
  }
  if (safety.class === "self-conflict") {
    return {
      status: "clarification_needed",
      reason: safety.reason,
      question:
        "The input contains two opposing project facts. Which one should be stored: the first statement or the revised one? Please reply with the single canonical fact.",
    };
  }

  // -- 2. Related-memory lookup (placeholder seam) --------------------
  const { memories: related } = findRelatedMemories(storage, {
    text: rawInput,
  });
  const relatedForProvider: readonly RelatedMemory[] = related;

  // -- 3. Provider call ----------------------------------------------
  // Build the adapter options object with only defined fields, so
  // the adapter does not receive undefined values for keys that
  // have defaults.
  const adapterOptions: Parameters<
    typeof analyzeMemoryWithFallback
  >[2] = {};
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

  const result: MemoryAnalysisResult = await analyzeMemoryWithFallback(
    rawInput,
    relatedForProvider,
    adapterOptions,
  );

  if (!result.ok) {
    return {
      status: "provider_error",
      reason: result.message,
    };
  }

  // -- 4. Controller validation + normalization ----------------------
  const normalized = validateAndNormalize(
    result.value,
    maxSummaryLength,
  );
  if (!normalized.ok) {
    return normalized.outcome;
  }
  const { summary, kind, confidence, tags, classification, entities } =
    normalized;

  // -- 5. Confidence gate --------------------------------------------
  if (confidence < confidenceThreshold) {
    return {
      status: "clarification_needed",
      reason: `provider confidence ${confidence.toFixed(2)} is below threshold ${confidenceThreshold.toFixed(2)}`,
      question:
        classification && classification.length > 0
          ? `Is this a ${classification}? Please rephrase or confirm so I can store it accurately.`
          : "Could you rephrase or add a bit more context so I can store this accurately?",
    };
  }

  // -- 6. Persist sanitized summary + metadata -----------------------
  const record = insertMemoryRecord(storage, {
    kind,
    state: "active",
    summary,
    providerId: result.providerUsed,
    modelId: result.modelUsed,
    confidence,
    safetyFlags: ["controller-normalized"],
    metadata: {
      tags,
      entities,
      classification: classification ?? null,
      providerFallbackUsed: result.fallbackUsed,
      llmRepairAttempts: result.llmRepairAttempts,
      ...(result.parseStrategy ? { parseStrategy: result.parseStrategy } : {}),
    },
  });

  return {
    status: "saved",
    record,
    message: `saved as #${record.id} (${record.kind}, confidence ${(record.confidence ?? 0).toFixed(2)})`,
  };
}

// ---------------------------------------------------------------------------
// Internal validation + normalization
// ---------------------------------------------------------------------------

interface NormalizedOk {
  ok: true;
  summary: string;
  kind: MemoryKind;
  confidence: number;
  tags: string[];
  classification: string | undefined;
  entities: ReadonlyArray<{ name: string; kind: string }>;
}

interface NormalizedFail {
  ok: false;
  outcome: RememberOutcome;
}

function validateAndNormalize(
  value: MemoryAnalysis,
  maxSummaryLength: number,
): NormalizedOk | NormalizedFail {
  // Whitespace + punctuation normalization (minimal).
  const rawSummary = value.summary ?? "";
  const summary = normalizeSummary(rawSummary);
  if (summary.length === 0) {
    return {
      ok: false,
      outcome: {
        status: "rejected",
        reason: "provider returned an empty summary after normalization",
        safetyClass: "empty-summary",
      },
    };
  }
  // Bounded length. Truncate at a word boundary if possible.
  let bounded = summary;
  if (bounded.length > maxSummaryLength) {
    bounded = truncateAtBoundary(bounded, maxSummaryLength);
  }
  // Defense-in-depth: redact any secret-shaped fragments that the
  // provider may have echoed. If redaction makes the summary empty
  // (or leaves only the redaction marker), fall back to rejection.
  const redacted = redactSummary(bounded);
  if (redacted.trim().length === 0) {
    return {
      ok: false,
      outcome: {
        status: "rejected",
        reason: "provider summary was entirely redacted as secret content",
        safetyClass: "secret-echoed-by-provider",
      },
    };
  }
  // If the entire meaningful content of the redacted summary is
  // just redaction markers, treat it as effectively empty. This
  // catches the "provider returned only the secret" case.
  const meaningfulChars = redacted.replace(/<redacted>/g, "").trim().length;
  if (meaningfulChars < 10) {
    return {
      ok: false,
      outcome: {
        status: "rejected",
        reason:
          "provider summary contained insufficient non-secret content after redaction",
        safetyClass: "secret-echoed-by-provider",
      },
    };
  }
  if (containsRawDumpShape(redacted)) {
    return {
      ok: false,
      outcome: {
        status: "rejected",
        reason:
          "provider summary looks like a raw dump rather than a normalized summary",
        safetyClass: "raw-dump-echo",
      },
    };
  }

  const confidence = clamp01(value.confidence);
  const kind = mapProviderKindToInternal(value.classification);
  const tags = Array.isArray(value.tags) ? value.tags.slice(0, 8) : [];
  const entities = Array.isArray(value.entities) ? value.entities : [];
  const classification = value.classification;

  return {
    ok: true,
    summary: redacted,
    kind,
    confidence,
    tags,
    classification,
    entities,
  };
}

function normalizeSummary(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return slice.slice(0, lastSpace).trim() + "…";
  return slice.trim() + "…";
}

function clamp01(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Heuristic for detecting a "raw dump" in the provider's summary.
 * Conservative: fires only on a clear wall of KEY=VALUE or
 * timestamped lines. A normal 1-2 sentence summary never trips this.
 */
function containsRawDumpShape(summary: string): boolean {
  const lines = summary.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  let dumpLines = 0;
  for (const l of lines) {
    if (/^[A-Z][A-Z0-9_]{2,}=.+$/.test(l)) dumpLines += 1;
    if (/^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(l)) dumpLines += 1;
  }
  return dumpLines / lines.length > 0.6;
}
