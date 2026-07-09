/**
 * Memory Decision Engine — core schemas and type definitions.
 *
 * Phase 1 of Curion's normalized LLM-assisted decision architecture.
 * This module is the foundation for ONE consolidated semantic
 * decision system that will eventually replace the family of
 * feature-specific LLM classifiers (retraction, supersession,
 * conflict, etc.). Phase 1 ships SHADOW MODE ONLY:
 *
 *   - The schemas and types are stable contracts.
 *   - The provider-facing structured decision call exists behind
 *     the same primary/fallback/repair pattern used by the
 *     memory-analysis and recall-synthesis adapters.
 *   - The remember controller invokes the engine in shadow mode
 *     after the deterministic safety pre-check. The decision
 *     output is traced/logged internally but NEVER mutates
 *     persisted memory, public output, public structured
 *     content, or MCP tool schemas.
 *
 * Design intent (per Phase 1 spec):
 *
 *   1. **Single consolidated engine.** Avoid separate
 *      `detectRetractionWithLLM`, `classifySupersessionWithLLM`,
 *      etc. Future feature-specific LLM paths should be expressed
 *      as decisions against this one schema, not as new engines.
 *
 *   2. **Strict Zod validation.** Same project pattern as
 *      `MemoryAnalysisSchema` and `MemoryAnalysisJsonSchema`. A
 *      parser repair pass handles minor formatting drift; an
 *      outright invalid response falls back to a no-op decision
 *      so remember proceeds deterministically.
 *
 *   3. **Action vocabulary is forward-looking.** The enum below
 *      covers `store` / `supersede` / `invalidate` / `redact` /
 *      `clarify` / `reject` / `no_op` / `flag_conflict` /
 *      `flag_redundant` so Phase 2+ can express any future
 *      feature-specific decision without a schema change. Phase 1
 *      executes NONE of these; the engine only emits the decision
 *      and the controller records/ignores it.
 *
 *   4. **Privacy-conscious.** Evidence packets carry redacted,
 *     bounded, typed facts (length caps, no raw input fields in
 *     persisted traces). The provider prompt redaction rules
 *     established by the memory-analysis adapter carry over
 *     unchanged: the raw input is NOT echoed into the prompt as
 *     a field name; the controller JSON-encodes it as the
 *     `INPUT` delimiter-bounded block, exactly as the existing
 *     memory-analysis prompt does.
 *
 * This module is consumed only by server-internal code. It is
 * never imported by the tool layer. No new public MCP tool or
 * resource is added.
 */

import { z } from "zod";
import type { ProviderError } from "../providers/http-client.js";

// ---------------------------------------------------------------------------
// Action vocabulary (forward-looking; Phase 1 executes none of them)
// ---------------------------------------------------------------------------

/**
 * The set of decisions the engine can emit about a candidate
 * `remember(input)` invocation. Phase 1 does not execute any of
 * these; the controller treats the engine output as observed-only.
 *
 * Values:
 *
 *   - `store`           — proceed with the existing controller
 *                          store path as if the engine were
 *                          silent.
 *   - `supersede`       — the candidate explicitly replaces one
 *                          or more stored memories. Future phases
 *                          may drive the existing
 *                          `detectSupersession` metadata back-
 *                          patch path; Phase 1 records the
 *                          decision only.
 *   - `invalidate`      — the candidate is a retraction of an
 *                          existing memory without a replacement.
 *                          Phase 1 records only.
 *   - `redact`          — the candidate should be stored only
 *                          after deterministic redaction. Phase 1
 *                          records only.
 *   - `clarify`         — ask the user a clarifying question
 *                          before any storage. Phase 1 records
 *                          only.
 *   - `reject`          — do not store; route to the existing
 *                          deterministic rejection path. Phase 1
 *                          records only.
 *   - `flag_conflict`   — the candidate conflicts with one or
 *                          more stored memories; record the
 *                          pointer but still store under the
 *                          current deterministic rules. Phase 1
 *                          records only.
 *   - `flag_redundant`  — the candidate is a paraphrase of an
 *                          existing memory; record only.
 *   - `no_op`           — the engine is explicitly abstaining.
 *                          The controller MUST treat this as
 *                          "no engine signal" and proceed with
 *                          the existing deterministic path
 *                          unchanged. This is the conservative
 *                          default when the engine is uncertain.
 */
export const REMEMBER_DECISION_ACTIONS = [
  "store",
  "supersede",
  "invalidate",
  "redact",
  "clarify",
  "reject",
  "flag_conflict",
  "flag_redundant",
  "no_op",
] as const;

export type RememberDecisionAction = (typeof REMEMBER_DECISION_ACTIONS)[number];

/**
 * Coarse reason categories the engine can attach to its decision.
 * These are stable labels for trace/event payloads; they are not
 * user-facing and not enforced by any downstream rule.
 */
export const REMEMBER_DECISION_REASONS = [
  "explicit_replacement",
  "explicit_retraction",
  "paraphrase_of_existing",
  "conflict_with_existing",
  "redundant_with_existing",
  "ambiguous_or_vague",
  "mixed_sensitive",
  "secret_echoed",
  "policy_violation",
  "low_quality",
  "novel",
  "unspecified",
] as const;

export type RememberDecisionReason = (typeof REMEMBER_DECISION_REASONS)[number];

// ---------------------------------------------------------------------------
// Schema: candidate side references
// ---------------------------------------------------------------------------

/**
 * Bounded reference to a stored memory the engine is reasoning
 * about. Carries NO raw text. The `memoryContent` excerpt is a
 * trimmed prefix of the safe summary so the engine has enough
 * lexical context to disambiguate, but the full summary is never
 * duplicated into the prompt.
 */
export const DecisionTargetMemorySchema = z.object({
  /** Stored-memory id (stable across calls). */
  id: z.number().int().nonnegative(),
  /**
   * Optional kind tag (e.g. "decision", "policy", "fact").
   * Mirrors the controller-side projection.
   */
  kind: z.string().min(1).max(64).optional(),
  /**
   * Bounded lexical excerpt of the safe summary. The provider
   * prompt only sees this prefix; the controller caps the length
   * to a small constant so a long memory cannot bloat the prompt.
   */
  memoryContentExcerpt: z.string().max(240),
});

export type DecisionTargetMemory = z.infer<typeof DecisionTargetMemorySchema>;

// ---------------------------------------------------------------------------
// Schema: existing deterministic decision signals (evidence)
// ---------------------------------------------------------------------------

/**
 * Existing deterministic signals the engine should treat as
 * authoritative EVIDENCE, not as parallel authorities. Each
 * signal is the result of an already-existing local detector;
 * the engine may agree, disagree, or abstain — but the
 * deterministic path keeps ownership of the action.
 *
 * The fields are all optional because Phase 1 builds the
 * evidence packet incrementally; missing fields are treated as
 * "the underlying detector did not produce a signal" (i.e. the
 * silent default), not as "the detector said no".
 */
export const DecisionEvidenceSignalsSchema = z.object({
  /**
   * Result of the deterministic supersession phrase + overlap
   * detector (`detectSupersession`). Only present when the
   * detector fired.
   */
  supersession: z
    .object({
      supersededIds: z.array(z.number().int().nonnegative()).max(64),
      confidence: z.number().min(0).max(1),
    })
    .optional(),
  /**
   * Result of the deterministic replacement-correction detector.
   * Only present when the detector fired.
   */
  replacementCorrection: z
    .object({
      label: z.string().min(1).max(64),
    })
    .optional(),
  /**
   * Result of the deterministic self-conflict detector.
   * Only present when the detector fired.
   */
  selfConflict: z
    .object({
      label: z.string().min(1).max(64),
    })
    .optional(),
  /**
   * Result of the deterministic prompt-injection pattern set.
   * Only present when a pattern matched.
   */
  injectionHits: z
    .array(
      z.object({
        label: z.string().min(1).max(64),
      })
    )
    .optional(),
  /**
   * Result of the deterministic unsafe-preference pattern set.
   * Only present when a pattern matched.
   */
  unsafePreferenceHits: z
    .array(
      z.object({
        label: z.string().min(1).max(64),
      })
    )
    .optional(),
  /**
   * Result of the deterministic vague-memory pattern set.
   * Only present when a pattern matched.
   */
  vagueMemory: z
    .object({
      label: z.string().min(1).max(64),
    })
    .optional(),
  /**
   * Coarse pre-check safety class from `classifyInput`. The
   * controller ALWAYS runs the deterministic pre-check before
   * the shadow engine, so this field is always present on a
   * valid Phase 1 evidence packet.
   */
  safetyClass: z.string().min(1).max(64),
});

export type DecisionEvidenceSignals = z.infer<typeof DecisionEvidenceSignalsSchema>;

// ---------------------------------------------------------------------------
// Schema: evidence packet
// ---------------------------------------------------------------------------

/**
 * Compact, privacy-conscious evidence packet the controller
 * builds and hands to the engine. Carries:
 *
 *   - bounded raw-input metadata (length, hash, NO full text)
 *   - the coarse safety class and a redacted reason string
 *   - a bounded list of related-memory excerpts (no ids leaked
 *     into the prompt; ids are kept for controller-side routing
 *     but the prompt rendering strips them, mirroring the
 *     existing memory-analysis related-memory block)
 *   - the existing deterministic signal summary
 *
 * The packet is a typed contract; the engine MUST NOT receive
 * the raw input as a free-form field name. The prompt builder
 * JSON-encodes the raw input inside the `INPUT:` delimiter-
 * bounded block, exactly as the existing memory-analysis prompt
 * does, so the engine never sees the raw text in the prompt
 * header.
 */
export const RememberDecisionEvidencePacketSchema = z.object({
  /**
   * Length of the raw input in characters. Used by the engine
   * for short-input heuristics; the raw text is NOT included.
   */
  rawInputLength: z.number().int().nonnegative(),
  /**
   * Stable 64-bit FNV-1a hash of the raw input, lowercase.
   * Lets the engine correlate decisions across calls without
   * ever seeing the raw text. Computed once at the seam; the
   * controller never echoes the hash into any user-facing
   * surface.
   */
  rawInputHash: z.string().regex(/^[0-9a-f]{1,16}$/),
  /**
   * Deterministic safety classification and reason. Always
   * present because the controller always runs the pre-check
   * before the shadow engine.
   */
  safety: DecisionEvidenceSignalsSchema,
  /**
   * Bounded related-memory excerpts (top-K, lexically ranked).
   * The packet NEVER includes the raw id token that the
   * existing memory-analysis adapter strips from its prompt;
   * the controller passes ids separately in
   * `relatedIdsForController` so the prompt rendering can
   * still strip them.
   */
  related: z.array(DecisionTargetMemorySchema).max(16),
  /**
   * Stable ids of the related memories, in the same order as
   * `related`. Used by the controller (NOT the prompt) to
   * route engine-emitted supersession / conflict pointers
   * back to actual rows. NEVER echoed into the provider
   * prompt.
   */
  relatedIdsForController: z.array(z.number().int().nonnegative()).max(16),
});

export type RememberDecisionEvidencePacket = z.infer<typeof RememberDecisionEvidencePacketSchema>;

// ---------------------------------------------------------------------------
// Schema: decision output
// ---------------------------------------------------------------------------

/**
 * Strict schema for the engine's structured decision output.
 *
 * Forward-looking fields (`supersededIds`, `conflictsWithIds`,
 * `redundantWithIds`) are typed now so Phase 2+ does not need
 * a schema change. Phase 1 stores them in the shadow trace but
 * never acts on them.
 *
 * The schema is intentionally narrow:
 *   - one `action` from the bounded enum,
 *   - one `reason` label,
 *   - bounded id arrays (max 16 each, ascending),
 *   - a `confidence` in [0, 1] used for trace prioritization
 *     only (Phase 1 does not gate persistence on it),
 *   - a free-form `notes` string for trace-only annotations,
 *     bounded to a small constant so a model cannot flood the
 *     trace.
 */
export const RememberPolicyDecisionSchema = z.object({
  action: z.enum(REMEMBER_DECISION_ACTIONS),
  reason: z.enum(REMEMBER_DECISION_REASONS),
  /**
   * Stable ids the candidate claims to supersede. Used by
   * Phase 2+ to drive the existing `detectSupersession`
   * metadata back-patch path. Phase 1 traces only.
   */
  supersededIds: z.array(z.number().int().nonnegative()).max(16).default([]),
  /**
   * Stable ids the candidate conflicts with. Used by
   * Phase 2+ to populate the existing
   * `relationship.conflictsWith` field. Phase 1 traces only.
   */
  conflictsWithIds: z.array(z.number().int().nonnegative()).max(16).default([]),
  /**
   * Stable ids the candidate is a paraphrase of. Used by
   * Phase 2+ to populate the existing
   * `relationship.olderVariantsOf` field. Phase 1 traces only.
   */
  redundantWithIds: z.array(z.number().int().nonnegative()).max(16).default([]),
  /**
   * Engine's own confidence in [0, 1]. Phase 1 traces this for
   * tuning but does NOT gate any controller behavior on it.
   */
  confidence: z.number().min(0).max(1),
  /**
   * Optional trace-only annotation. Bounded length so the model
   * cannot flood the trace; never echoed to the user.
   */
  notes: z.string().max(280).optional(),
});

export type RememberPolicyDecision = z.infer<typeof RememberPolicyDecisionSchema>;

// ---------------------------------------------------------------------------
// Adapter-level result wrappers
// ---------------------------------------------------------------------------

/**
 * Provider id the decision adapter can target. Mirrors the
 * adapter id set used by `memory-analysis` so the controller's
 * existing test fixture set can be reused.
 */
export type DecisionProviderId =
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "nvidia-nim"
  | "minimax"
  | "custom";

export interface DecisionAdapterSuccess {
  ok: true;
  /**
   * The structured decision. Always validated against
   * `RememberPolicyDecisionSchema` before the adapter returns.
   */
  value: RememberPolicyDecision;
  /**
   * Which provider produced the final result. `"primary"`
   * means the fallback was not used; `"fallback"` means the
   * primary failed or its structured output was unrepairable.
   */
  providerUsed: DecisionProviderId;
  /** Model id that produced the final result. */
  modelUsed: string;
  /** True iff the result came from the fallback provider. */
  fallbackUsed: boolean;
  /** Latency of the winning provider call, in ms. */
  latencyMs: number;
  /** Number of HTTP round trips actually made. */
  httpCalls: number;
}

export interface DecisionAdapterFailure {
  ok: false;
  /**
   * Top-level error classification. `"all-providers-failed"`
   * means primary and fallback both failed;
   * `"missing-config"` means no provider had a configured key;
   * `"invalid-input"` means the evidence packet was missing
   * required fields; `"invalid-output"` means the provider
   * returned output that could not be parsed or schema-
   * validated even after the parser repair pass.
   */
  kind: "all-providers-failed" | "missing-config" | "invalid-input" | "invalid-output";
  /** Redacted human-readable message. Never contains a key. */
  message: string;
  /** Number of HTTP round trips actually made. */
  httpCalls: number;
  /** Last hard error observed, if any (already redacted by the HTTP client). */
  lastError?: ProviderError | undefined;
  /** Optional parser / validator issue list. */
  parseErrors?: string[] | undefined;
}

export type DecisionAdapterResult = DecisionAdapterSuccess | DecisionAdapterFailure;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version of the decision output. Bump on any
 * breaking schema change.
 */
export const REMEMBER_DECISION_SCHEMA_VERSION = "remember-policy/1" as const;

/**
 * Default maximum length of the lexical excerpt included in a
 * `DecisionTargetMemory.memoryContentExcerpt`. Mirrors the
 * evidence-card size used by the recall synthesis prompt.
 */
export const DECISION_TARGET_EXCERPT_MAX_CHARS = 240;

/**
 * Maximum number of related memories included in a single
 * evidence packet. Smaller than the controller's
 * `RELATED_MEMORIES_MAX_TOP_K` (16) so the engine prompt stays
 * compact.
 */
export const DECISION_EVIDENCE_MAX_RELATED = 8;
