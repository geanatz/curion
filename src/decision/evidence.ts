/**
 * Compact evidence builder for the Memory Decision Engine.
 *
 * The builder assembles a `RememberDecisionEvidencePacket` from
 * the data the remember controller already has in scope at the
 * moment it would call the shadow engine. The packet is:
 *
 *   - bounded (length caps on every collection),
 *   - privacy-conscious (no raw input echo; a length + a stable
 *     hash for cross-call correlation),
 *   - redaction-aware (the safety class is the only safety data
 *     the engine sees; secret hits are NOT exposed).
 *
 * The builder never reads the network, never touches storage,
 * and never logs. It is a pure data-shaping helper.
 */

import type { RelatedMemory } from "../providers/memory-analysis.js";
import { type SafetyCheckResult, classifyInput } from "../safety/precheck.js";
import { type SafeMemorySummary, listActiveMemorySummaries } from "../storage/storage.js";
import {
  DECISION_EVIDENCE_MAX_RELATED,
  DECISION_TARGET_EXCERPT_MAX_CHARS,
  type DecisionTargetMemory,
  type RememberDecisionEvidencePacket,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stable input hash (FNV-1a 64-bit, hex truncated to 16 chars)
// ---------------------------------------------------------------------------

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const FNV_MASK_64 = (1n << 64n) - 1n;

/**
 * Compute a stable 64-bit FNV-1a hash of the raw input, lowercased
 * and UTF-8 byte-encoded. Returned as a 16-char lowercase hex
 * string (top 64 bits of the 64-bit digest).
 *
 * Used only for cross-call correlation in shadow traces. The hash
 * is NEVER persisted into user-visible surfaces and is computed
 * from the raw input WITHOUT the secret-pattern redaction that
 * the safety pre-check applies — the hash must be stable
 * regardless of which fragment triggered safety so a future
 * operator can correlate "secret hit" vs. "no safety hit" on
 * the same input.
 */
export function hashRawInput(rawInput: string): string {
  const text = (typeof rawInput === "string" ? rawInput : "").toLowerCase();
  // Use Buffer when available (Node), fall back to UTF-8 manually.
  let bytes: Uint8Array;
  if (typeof Buffer !== "undefined") {
    bytes = new Uint8Array(Buffer.from(text, "utf8"));
  } else {
    bytes = new TextEncoder().encode(text);
  }
  let hash = FNV_OFFSET_64;
  for (let i = 0; i < bytes.length; i += 1) {
    // XOR with byte (cast to bigint); multiply by FNV prime; mask to 64 bits.
    hash ^= BigInt(bytes[i] ?? 0);
    hash = (hash * FNV_PRIME_64) & FNV_MASK_64;
  }
  // Truncate to 64 bits (the digest width) and emit 16 hex chars.
  return hash.toString(16).padStart(16, "0").slice(-16);
}

// ---------------------------------------------------------------------------
// Evidence builder
// ---------------------------------------------------------------------------

export interface DecisionDeterministicSignals {
  /**
   * Result of `detectSupersession`. Pass-through; the builder
   * only flattens it into the typed packet field. Phase 1 calls
   * `detectSupersession` after the candidate row exists, so the
   * builder is invoked with `supersession: undefined` and the
   * field stays empty. Forward-looking typing only.
   */
  supersession?:
    | {
        supersededIds: readonly number[];
        confidence: number;
      }
    | undefined;
  /**
   * Label from the deterministic replacement-correction detector.
   * Pass-through only.
   */
  replacementCorrection?: { label: string } | undefined;
  /**
   * Label from the deterministic self-conflict detector.
   * Pass-through only.
   */
  selfConflict?: { label: string } | undefined;
  /**
   * Labels from the deterministic prompt-injection pattern set.
   * Pass-through only.
   */
  injectionHits?: ReadonlyArray<{ label: string }> | undefined;
  /**
   * Labels from the deterministic unsafe-preference pattern set.
   * Pass-through only.
   */
  unsafePreferenceHits?: ReadonlyArray<{ label: string }> | undefined;
  /**
   * Label from the deterministic vague-memory detector.
   * Pass-through only.
   */
  vagueMemory?: { label: string } | undefined;
}

export interface BuildRememberDecisionEvidenceInput {
  /** The raw controller input. Used only for length + hash. */
  rawInput: string;
  /**
   * Result of the deterministic safety pre-check (`classifyInput`).
   * When omitted, the builder runs `classifyInput(rawInput)` itself.
   * The controller already has the result in scope, so callers
   * should always pass it to avoid a second pre-check pass.
   */
  safety?: SafetyCheckResult;
  /**
   * Related memories returned by the seam. Defaults to an empty
   * list. Each related memory contributes one
   * `DecisionTargetMemory` to the packet's `related` field,
   * capped at `DECISION_EVIDENCE_MAX_RELATED`.
   */
  related?: readonly RelatedMemory[] | undefined;
  /**
   * Storage handle. When provided AND `related` is omitted, the
   * builder reads active memory summaries itself. The controller
   * already has the related set in scope, so callers should
   * always pass it directly to avoid an extra storage read.
   */
  storage?: import("../storage/storage.js").StorageHandle;
  /**
   * Forward-looking deterministic signals. Phase 1 callers pass
   * an empty object; the builder still flattens each present
   * field into the typed packet.
   */
  signals?: DecisionDeterministicSignals | undefined;
}

/**
 * Build the typed evidence packet the engine receives.
 *
 * Defaults are conservative:
 *   - If `safety` is omitted, runs `classifyInput(rawInput)` once.
 *   - If `related` is omitted and `storage` is provided, reads
 *     active summaries directly (capped). The controller should
 *     always pass `related` to avoid the extra storage read.
 *   - Excerpts are trimmed to `DECISION_TARGET_EXCERPT_MAX_CHARS`
 *     and whitespace-normalized.
 */
export function buildRememberDecisionEvidence(
  input: BuildRememberDecisionEvidenceInput
): RememberDecisionEvidencePacket {
  const safety = input.safety ?? classifyInput(input.rawInput);
  const relatedRaw = input.related ?? (input.storage ? safeRelatedFromStorage(input.storage) : []);

  // Cap and project to the engine-side shape. We deliberately do
  // NOT include the storage id in the engine prompt — the engine
  // does not need it, and leaking `#N` tokens into a prompt is the
  // same leak the existing memory-analysis adapter guards against.
  // The controller keeps the id-to-position mapping on
  // `relatedIdsForController` for any Phase 2+ routing that needs
  // it.
  const capped = relatedRaw.slice(0, DECISION_EVIDENCE_MAX_RELATED);
  const relatedTargets: DecisionTargetMemory[] = [];
  const relatedIds: number[] = [];
  for (const r of capped) {
    const id = typeof r.id === "number" && Number.isFinite(r.id) ? r.id : null;
    if (id === null) continue;
    relatedTargets.push({
      id,
      ...(typeof r.kind === "string" && r.kind.length > 0 ? { kind: r.kind } : {}),
      memoryContentExcerpt: buildExcerpt(r.memoryContent),
    });
    relatedIds.push(id);
  }

  const signals = input.signals ?? {};

  return {
    rawInputLength: input.rawInput.length,
    rawInputHash: hashRawInput(input.rawInput),
    safety: {
      safetyClass: safety.class,
      ...(signals.supersession
        ? {
            supersession: {
              supersededIds: [...signals.supersession.supersededIds],
              confidence: signals.supersession.confidence,
            },
          }
        : {}),
      ...(signals.replacementCorrection
        ? { replacementCorrection: { label: signals.replacementCorrection.label } }
        : {}),
      ...(signals.selfConflict ? { selfConflict: { label: signals.selfConflict.label } } : {}),
      ...(signals.injectionHits && signals.injectionHits.length > 0
        ? {
            injectionHits: signals.injectionHits.map((h) => ({ label: h.label })),
          }
        : {}),
      ...(signals.unsafePreferenceHits && signals.unsafePreferenceHits.length > 0
        ? {
            unsafePreferenceHits: signals.unsafePreferenceHits.map((h) => ({ label: h.label })),
          }
        : {}),
      ...(signals.vagueMemory ? { vagueMemory: { label: signals.vagueMemory.label } } : {}),
    },
    related: relatedTargets,
    relatedIdsForController: relatedIds,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildExcerpt(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= DECISION_TARGET_EXCERPT_MAX_CHARS) return normalized;
  // Truncate at a word boundary when possible so the engine sees
  // a coherent prefix, not a mid-word slice.
  const slice = normalized.slice(0, DECISION_TARGET_EXCERPT_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > DECISION_TARGET_EXCERPT_MAX_CHARS * 0.6) {
    return `${slice.slice(0, lastSpace).trim()}…`;
  }
  return `${slice.trim()}…`;
}

function safeRelatedFromStorage(storage: import("../storage/storage.js").StorageHandle) {
  try {
    const summaries = listActiveMemorySummaries(storage, { limit: DECISION_EVIDENCE_MAX_RELATED });
    const out: RelatedMemory[] = [];
    for (const s of summaries) {
      if (!isSafeSummary(s)) continue;
      out.push({
        id: s.id,
        memoryContent: s.memoryContent,
        kind: s.kind,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function isSafeSummary(v: unknown): v is SafeMemorySummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isFinite(o.id)) return false;
  if (typeof o.memoryContent !== "string") return false;
  return true;
}
