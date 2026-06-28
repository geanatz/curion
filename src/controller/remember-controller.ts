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

import { logger } from "../logging/logger.js";
import {
  type MemoryAnalysisResult,
  type RelatedMemory,
  analyzeMemoryWithFallback,
} from "../providers/memory-analysis.js";
import type { MemoryAnalysis } from "../providers/structured-output.js";
import {
  type RelationshipMetadataFields,
  buildPersistedMetadata,
  deriveRelationshipMetadata,
} from "../retrieval/relationship.js";
import { findRelatedMemories } from "../retrieval/seam.js";
import { detectSupersession } from "../retrieval/supersession.js";
import { classifyInput, redactSummary } from "../safety/precheck.js";
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
  type SafeMemorySummary,
  type StorageHandle,
  addSupersededByToMemory,
  insertMemoryRecord,
  updateMemoryMetadata,
} from "../storage/storage.js";
import type { Clarification } from "../tools/remember-structured-content.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public outcome of the controller. */
export type RememberOutcome =
  | { status: "saved"; record: MemoryRecord; message: string }
  | {
      status: "rejected";
      reason: string;
      safetyClass: string;
      clarification_needed?: Clarification;
    }
  | { status: "provider_error"; reason: string };

/** Controller options. Most fields have safe defaults. */
export interface RememberControllerOptions {
  /**
   * Confidence threshold below which the controller returns
   * `rejected` with `clarification_needed` instead of saving.
   * Default `0.5`.
   */
  confidenceThreshold?: number;
  /**
   * Max accepted summary length. Provider summaries above this are
   * truncated to the cap before persistence. Default `1440`.
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
  /**
   * Optional clock override for tests. When set, the controller
   * uses this function to obtain the `derivedAt` timestamp
   * written into the `relationship` metadata block (spec §6).
   * Production code does not set this; the controller defaults
   * to `Date.now` at the seam. Tests can pin a deterministic
   * timestamp to make the persisted JSON byte-stable.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
export const DEFAULT_MAX_SUMMARY_LENGTH = 1440;

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
  // Policy variants: standing future behavior / rule
  policy: "policy",
  "project-policy": "policy",
  "user-policy": "policy",
  rule: "policy",
  "standing-rule": "policy",
  "operating-rule": "policy",
  // Constraint variants: hard boundary / requirement / limitation
  constraint: "constraint",
  "project-constraint": "constraint",
  requirement: "constraint",
  limitation: "constraint",
  boundary: "constraint",
  "hard-limit": "constraint",
  finding: "finding",
};

/**
 * Mapping from the provider's `classification` field to the internal
 * `MemoryKind` enum. Unknown values map to `finding` (the safe
 * fallback). The match is case-insensitive and trimmed.
 */
function mapProviderKindToInternal(providerKind: string | undefined): MemoryKind {
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
  options: RememberControllerOptions = {}
): Promise<RememberOutcome> {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxSummaryLength = options.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH;

  // -- 1. Safety pre-check (no provider call yet) --------------------
  const safety = classifyInput(rawInput);
  logger.debug(`remember: pre-check class=${safety.class} reason=${safety.reason}`);
  if (safety.class === "secret") {
    return {
      status: "rejected",
      reason: "input contains a secret-shaped fragment; refusing to store or forward it",
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
      reason: "input asks to weaken safety or persistence policy; refusing to store or forward it",
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
      status: "rejected",
      reason: "input contains opposing project facts; please resubmit the single canonical fact",
      safetyClass: "self-conflict",
      clarification_needed: {
        question:
          "The input contains two opposing project facts. Which one should be stored: the first statement or the revised one? Please reply with the single canonical fact.",
      },
    };
  }
  if (safety.class === "vague-memory") {
    // Hardening pass: the input is dominated by demonstrative +
    // vague-noun references with no concrete content. We cannot
    // tell what the user wants us to remember, so we ask them to
    // supply the actual memory. The provider is NOT called.
    return {
      status: "rejected",
      reason:
        "input is dominated by vague placeholder references; please resubmit the concrete fact you want remembered",
      safetyClass: "vague-memory",
      clarification_needed: {
        question:
          "Your message references an unspecified past decision or discussion. What concrete memory should I store?",
      },
    };
  }
  if (safety.class === "replacement-correction") {
    // Hardening pass: the input asserts a direct correction
    // ("Postgres, not SQLite") that replaces one named thing
    // with another. The user-stated preference is "do not
    // assume" — we ask the agent to confirm the single
    // canonical fact and whether to replace older related
    // memories. The provider is NOT called.
    return {
      status: "rejected",
      reason:
        "input asserts a direct correction / replacement; please resubmit the single canonical fact and confirm whether to replace older related memories",
      safetyClass: "replacement-correction",
      clarification_needed: {
        question:
          "Your message asserts one fact replacing another (for example 'X, not Y'). Which is the single canonical fact, and should I replace older related memories with it?",
      },
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
  const adapterOptions: Parameters<typeof analyzeMemoryWithFallback>[2] = {};
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
    adapterOptions
  );

  if (!result.ok) {
    return {
      status: "provider_error",
      reason: result.message,
    };
  }

  // -- 4. Controller validation + normalization ----------------------
  const normalized = validateAndNormalize(result.value, maxSummaryLength);
  if (!normalized.ok) {
    return normalized.outcome;
  }
  const { memoryContent, kind, confidence, tags, classification, entities } = normalized;

  // -- 5. Confidence gate --------------------------------------------
  if (confidence < confidenceThreshold) {
    const question =
      classification && classification.length > 0
        ? `Is this a ${classification}? Please rephrase or confirm so I can store it accurately.`
        : "Could you rephrase or add a bit more context so I can store this accurately?";
    return {
      status: "rejected",
      reason: `provider confidence ${confidence.toFixed(2)} is below threshold ${confidenceThreshold.toFixed(2)}`,
      safetyClass: "low-confidence",
      clarification_needed: {
        question,
      },
    };
  }

  // -- 6. Persist sanitized summary + metadata -----------------------
  // The write path is two SQL statements, by design:
  //
  //   1. INSERT the row with the controller-normalized metadata
  //      (tags / entities / classification / providerFallbackUsed
  //      / llmRepairAttempts / parseStrategy) and NO `relationship`
  //      block. The candidate's real autoincrement `id` is unknown
  //      at this point, so the detector would have to guess it,
  //      and a guessed id would make the `olderVariantsOf` rule
  //      structurally always-empty (every real row has id > 0).
  //   2. With the real id, re-derive `relationship` metadata
  //      against the same related-memories set the seam returned
  //      and UPDATE only the `metadata` column on the just-
  //      inserted row. The pure helper is non-mutating and never
  //      overwrites a pre-existing `relationship` key, so the
  //      second write is a safe, append-only patch.
  //
  // The `metadata` column is the only thing the second statement
  // touches. `state` is unchanged (`active`), the persisted
  // memory content (DB column `summary`) is unchanged, the
  // autoincrement id is unchanged. No schema change, no raw-text
  // storage, no public-message change. The clock for `derivedAt`
  // is controller-supplied via `options.now`; the pure helper
  // itself never reads it.
  const existingMetadata: Record<string, unknown> = {
    tags,
    entities,
    classification: classification ?? null,
    providerFallbackUsed: result.fallbackUsed,
    llmRepairAttempts: result.llmRepairAttempts,
    ...(result.parseStrategy ? { parseStrategy: result.parseStrategy } : {}),
  };
  const record = insertMemoryRecord(storage, {
    kind,
    state: "active",
    memoryContent,
    providerId: result.providerUsed,
    modelId: result.modelUsed,
    confidence,
    safetyFlags: ["controller-normalized"],
    metadata: existingMetadata,
  });

  // -- 6b. Post-insert relationship-derivation ----------------------
  // The related-memories list the seam returned is the candidate
  // set the controller already feeds to the provider prompt
  // (spec §3.3). We re-use it here to derive the conservative
  // `relationship` block with the candidate's REAL id, then
  // append the block onto the row's existing metadata via a
  // typed, narrow `metadata` patch. Rows with malformed related
  // ids are skipped before derivation so a -1 or NaN can never
  // reach the detector or be persisted.
  const relatedSummaries: SafeMemorySummary[] = related
    .map(toSafeMemorySummary)
    .filter((s): s is SafeMemorySummary => s !== null);
  const candidateSummary: SafeMemorySummary = {
    // The candidate's real id is the autoincrement value
    // `insertMemoryRecord` just returned. The detector's
    // `olderVariantsOf` rule requires `other.id <
    // candidate.id`; using the real id here is what makes
    // that rule meaningful in the controller path.
    id: record.id,
    kind,
    state: "active",
    memoryContent,
    tags,
    classification: classification ?? null,
    confidence,
  };
  const derived: RelationshipMetadataFields = deriveRelationshipMetadata({
    candidate: candidateSummary,
    others: relatedSummaries,
    asOf: (options.now ?? Date.now)(),
  });

  // -- 6c. Supersession detection (Phase I extension) ------------
  // Run the supersession detector over a broader supersession-
  // specific candidate set to find any memories the new candidate
  // explicitly supersedes (e.g. "no longer use X, use Y instead;
  // replaced by; superseded by").
  //
  // The supersession candidate set is derived from BOTH the raw
  // input text AND the normalized candidate summary (memoryContent).
  // This dual-text union ensures that topically similar memories
  // (like a freshly-created same-topic policy) are included even
  // when they don't lexically overlap with the raw input's dominant
  // tokens (e.g. the old "MiniMax as default" policy doesn't
  // overlap with "nvidia/nim" tokens in the raw input for the
  // new NVIDIA policy update).
  //
  // We use topK=16 (RELATED_MEMORIES_MAX_TOP_K) to maximize
  // candidate coverage for supersession detection, since the
  // provider prompt token budget is not a concern here.
  //
  // The detector is pure, conservative, and returns null when
  // uncertain. When it fires, we:
  //   - Add `supersedes: [oldId, ...]` to the new row's block.
  //   - Back-patch each superseded old row with
  //     `supersededBy: [newId]`.
  // The supersession signal contributes to `detectionConfidence`
  // and can make a supersession-only block (no conflictsWith /
  // olderVariantsOf) worth persisting.
  // Pass rawInputText so the detector can use the user's explicit
  // supersession language (e.g. "supersedes") even if the provider
  // summary rephrased it (e.g. to "superseding").
  const { memories: supersessionCandidates } = findRelatedMemories(storage, {
    text: rawInput,
    candidateText: memoryContent,
    topK: 16,
  });
  const supersessionCandidateSummaries: SafeMemorySummary[] = supersessionCandidates
    .map(toSafeMemorySummary)
    .filter((s): s is SafeMemorySummary => s !== null);

  const supersession = detectSupersession({
    candidate: candidateSummary,
    others: supersessionCandidateSummaries,
    rawInputText: rawInput,
  });
  if (supersession !== null && supersession.supersededIds.length > 0) {
    // Merge supersession ids into the derived block.
    derived.supersedes = supersession.supersededIds;
    if (supersession.confidence > derived.detectionConfidence) {
      derived.detectionConfidence = supersession.confidence;
    }
    // Back-patch each superseded old row: add supersededBy pointing
    // to the new candidate's id. Safe for missing/deleted rows —
    // `addSupersededByToMemory` is a no-op when the row does not
    // exist.
    for (const supersededId of supersession.supersededIds) {
      addSupersededByToMemory(storage, supersededId, record.id);
    }
  }

  // The helper is append-only: it preserves the existing
  // metadata keys (tags / entities / classification / ...) and
  // only adds a `relationship` block when the derived block
  // carries at least one non-empty id list. A row whose
  // derived block is empty (the MVP default) gets NO update
  // at all, keeping the persisted JSON byte-equal to pre-
  // Phase-B for the no-related-memories case.
  // Phase I extension: supersession-only blocks (no
  // conflictsWith / olderVariantsOf) are now also considered
  // meaningful and are persisted.
  //
  // Pass `existingMetadata` (not `record.metadata`) as the base
  // for the new row's relationship block. `existingMetadata`
  // is the clean controller-built object with no `relationship`
  // key, ensuring the append-only invariant holds and a
  // supersession-only block is written even if the storage
  // layer returned a modified metadata object.
  const patched = buildPersistedMetadata(existingMetadata, derived);
  const hasRelationshipKey =
    Object.prototype.hasOwnProperty.call(patched, "relationship") &&
    patched.relationship !== undefined;
  if (hasRelationshipKey) {
    // Update ONLY the metadata column on the row we just
    // inserted. `updateMemoryMetadata` is a typed, narrow
    // patch; it does not touch state, memory content
    // (DB column `summary`), or any other column.
    const updated = updateMemoryMetadata(storage, record.id, patched);
    return {
      status: "saved",
      record: updated,
      // Public message omits the saved memory id. The id is
      // an internal storage handle and is preserved on the
      // returned `record.id` for tests, structured transport,
      // and any future agent-facing API that needs it. The
      // on-the-wire MCP `text` content block carries calm
      // prose only — the kind and the confidence. The tool
      // layer in `src/tools/remember.ts` uses the same
      // no-id wording for the user-facing message.
      message: `saved (${updated.kind}, confidence ${(updated.confidence ?? 0).toFixed(2)})`,
    };
  }

  return {
    status: "saved",
    record,
    message: `saved (${record.kind}, confidence ${(record.confidence ?? 0).toFixed(2)})`,
  };
}

// ---------------------------------------------------------------------------
// Internal validation + normalization
// ---------------------------------------------------------------------------

interface NormalizedOk {
  ok: true;
  /**
   * Controller-normalized memory content. Maps the provider
   * output `MemoryAnalysis.summary` (the JSON field name in the
   * provider contract) to the internal `memoryContent` name.
   * The provider contract is unchanged; the internal rename
   * keeps the controller-side variable consistent with
   * `MemoryRecordInput.memoryContent` and
   * `SafeMemorySummary.memoryContent`.
   */
  memoryContent: string;
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
  maxSummaryLength: number
): NormalizedOk | NormalizedFail {
  // Whitespace + punctuation normalization (minimal). The
  // provider field is still `MemoryAnalysis.summary`; we map
  // it to the internal `memoryContent` here.
  const rawSummary = value.summary ?? "";
  const memoryContent = normalizeSummary(rawSummary);
  if (memoryContent.length === 0) {
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
  let bounded = memoryContent;
  if (bounded.length > maxSummaryLength) {
    bounded = truncateAtBoundary(bounded, maxSummaryLength);
  }
  // Defense-in-depth: redact any secret-shaped fragments that the
  // provider may have echoed. If redaction makes the memory
  // content empty (or leaves only the redaction marker), fall
  // back to rejection.
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
        reason: "provider summary contained insufficient non-secret content after redaction",
        safetyClass: "secret-echoed-by-provider",
      },
    };
  }
  if (containsRawDumpShape(redacted)) {
    return {
      ok: false,
      outcome: {
        status: "rejected",
        reason: "provider summary looks like a raw dump rather than a normalized summary",
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
    memoryContent: redacted,
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

// ---------------------------------------------------------------------------
// Relationship wiring helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `SafeMemorySummary` from a `RelatedMemory`.
 *
 * The seam's MVP returns only `{ id, memoryContent, kind? }`
 * (Phase 1 internal naming cleanup: the seam field is the
 * internal `memoryContent`). The relationship detector consumes
 * a `SafeMemorySummary`, which also carries `state`, `tags`,
 * `classification`, `confidence`. For seam rows that omit those,
 * we fill conservative defaults (`state: "active"` because the
 * seam only returns active candidates, `tags: []`,
 * `classification: null`, `confidence: null`).
 *
 * A non-finite / non-number `id` is REJECTED (returns `null`)
 * rather than coerced to a sentinel. Coercing a malformed id
 * to `-1` would persist a row whose `olderVariantsOf` /
 * `conflictsWith` lists carry `[-1]`, which is wrong on
 * every read: there is no memory with id `-1`. Skipping the
 * row entirely is the safe behavior; the controller still
 * continues for the other related memories.
 */
function toSafeMemorySummary(r: RelatedMemory): SafeMemorySummary | null {
  if (typeof r.id !== "number" || !Number.isFinite(r.id)) {
    return null;
  }
  if (typeof r.memoryContent !== "string") {
    return null;
  }
  return {
    id: r.id,
    kind: "finding",
    state: "active",
    memoryContent: r.memoryContent,
    tags: [],
    classification: null,
    confidence: null,
  };
}
