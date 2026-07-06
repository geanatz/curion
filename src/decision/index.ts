/**
 * Memory Decision Engine — public surface for server-internal
 * consumers.
 *
 * This module is the canonical import target for everything the
 * controller layer needs from the decision engine. It is NEVER
 * imported by the tool layer (no MCP tool or resource exposes
 * the engine directly) and never imported by storage or
 * retrieval helpers.
 *
 * Phase 1 ships SHADOW MODE ONLY. The engine emits a structured
 * decision; the controller traces it and never alters persisted
 * memory based on it.
 */

export {
  DECISION_EVIDENCE_MAX_RELATED,
  DECISION_TARGET_EXCERPT_MAX_CHARS,
  type DecisionAdapterFailure,
  type DecisionAdapterResult,
  type DecisionAdapterSuccess,
  type DecisionProviderId,
  type DecisionTargetMemory,
  type RememberDecisionAction,
  REMEMBER_DECISION_ACTIONS,
  type RememberDecisionEvidencePacket,
  RememberDecisionEvidencePacketSchema,
  type RememberDecisionReason,
  REMEMBER_DECISION_REASONS,
  REMEMBER_DECISION_SCHEMA_VERSION,
  type RememberPolicyDecision,
  RememberPolicyDecisionSchema,
} from "./types.js";

export {
  REMEMBER_POLICY_DECISION_JSON_SCHEMA,
  parseRememberPolicyDecision,
  type DecisionParseResult,
} from "./structured-output.js";

export {
  buildRememberDecisionEvidence,
  type BuildRememberDecisionEvidenceInput,
  type DecisionDeterministicSignals,
  hashRawInput,
} from "./evidence.js";

export {
  type RememberDecisionMode,
  type RememberDecisionPolicy,
  loadRememberDecisionPolicy,
  REMEMBER_DECISION_POLICY_ENV_VAR,
  resolveRememberDecisionPolicy,
} from "./policy.js";

export {
  DECISION_DEFAULT_MAX_TOKENS,
  DECISION_DEFAULT_TIMEOUT_MS,
  type DecisionAdapterConfig,
  type DecisionAdapterOptions,
  decideRememberPolicyWithFallback,
  loadDecisionAdapterConfig,
  resolveDecisionProviderId,
} from "./adapter.js";
