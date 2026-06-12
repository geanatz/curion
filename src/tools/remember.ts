/**
 * `remember(text)` tool.
 *
 * Phase 1 contract (preserved):
 *   - Accepts exactly one public `text` parameter (string).
 *   - Must not accept kinds, states, filters, providers, debug, or
 *     storage arguments.
 *
 * MVP vertical slice (Narrow `remember(text)`):
 *   - Returns one of four outcomes: `saved`, `rejected`,
 *     `clarification_needed`, `provider_error`. The public
 *     response shape is stable: a `text` content block carrying a
 *     short human-readable message and, when applicable, the saved
 *     memory id + summary.
 *   - Raw input is never persisted. The controller stores only the
 *     provider-normalized summary + metadata.
 *   - The raw input is passed by reference to the controller; it is
 *     never returned in any field, log, or response.
 *
 * Tool-layer responsibilities:
 *   - Defensive shape check on `input.text`.
 *   - Acquire / reuse a project-local `StorageHandle`.
 *   - Call the controller.
 *   - Format the public `RememberResult`.
 *
 * The controller owns the safety pre-check, the provider call, the
 * validation/normalization, and the persistence write. The tool
 * layer does none of those.
 */

import {
  runRememberController,
  type RememberOutcome,
} from "../controller/remember-controller.js";
import {
  initStorage,
  closeStorage,
  type StorageHandle,
} from "../storage/storage.js";
import { logger } from "../logging/logger.js";

export const REMEMBER_TOOL_NAME = "remember" as const;
export const REMEMBER_TOOL_DESCRIPTION =
  "Store a piece of project memory. Returns a saved / rejected / clarification_needed / provider_error outcome.";

export interface RememberInput {
  text: string;
}

export const REMEMBER_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    text: {
      type: "string" as const,
      description: "The memory text to store.",
    },
  },
  required: ["text"] as const,
  additionalProperties: false as const,
};

/**
 * Public tool-layer result. The `message` field is the only field the
 * MCP `text` content block carries. Structured fields are exposed via
 * `outcome` for tests and any future structured-content transport.
 */
export interface RememberResult {
  status: RememberOutcome["status"];
  /** Short human-readable message. Never echoes raw input. */
  message: string;
  /** Saved memory id, when `status === "saved"`. */
  memoryId?: number;
  /** Saved memory kind, when `status === "saved"`. */
  memoryKind?: string;
  /** Provider model id, when `status === "saved"`. */
  modelId?: string | null;
  /** Provider confidence, when `status === "saved"`. */
  confidence?: number | null;
  /** Persisted summary, when `status === "saved"`. */
  summary?: string;
  /** Safety class, when `status === "rejected"`. */
  safetyClass?: string;
  /** Clarification question, when `status === "clarification_needed"`. */
  question?: string;
}

/**
 * Storage provider hook.
 *
 * A `StorageProvider` returns a `StorageHandle` and a `close` flag.
 * When `close` is true, the tool will close the handle when the
 * controller call finishes. When `close` is false, the caller owns
 * the handle and is responsible for closing it (this is what the
 * production stdio entrypoint does — it owns a single long-lived
 * handle for the life of the process).
 *
 * Tests can override this via `setStorageProvider`. The default
 * returns a fresh per-call handle that the tool will close; this
 * keeps the tool safe to call directly in a test harness.
 */
export interface StorageProviderHandle {
  handle: StorageHandle;
  /** True if the tool should call `closeStorage` after the call. */
  ownsHandle: boolean;
}

type StorageProvider = () => StorageProviderHandle;
let storageProvider: StorageProvider = () => {
  const handle = initStorage();
  return { handle, ownsHandle: true };
};

/** Test/extension hook. Production code does not call this. */
export function setStorageProvider(provider: StorageProvider): void {
  storageProvider = provider;
}

/** Test/extension hook. Resets to the default (per-call) provider. */
export function resetStorageProvider(): void {
  storageProvider = () => {
    const handle = initStorage();
    return { handle, ownsHandle: true };
  };
}

/**
 * Run the narrow `remember(text)` pipeline. Defensive shape check
 * on `input.text`, then delegate to the controller.
 */
export async function handleRemember(input: unknown): Promise<RememberResult> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as { text?: unknown }).text !== "string"
  ) {
    throw new Error("remember: `text` (string) is required");
  }
  const text = (input as { text: string }).text;
  if (text.trim().length === 0) {
    throw new Error("remember: `text` (string) must be non-empty");
  }

  const { handle: storage, ownsHandle } = storageProvider();
  let outcome: RememberOutcome;
  try {
    outcome = await runRememberController(storage, text);
  } catch (err) {
    // Unexpected throw — log and surface a provider_error outcome.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`remember: unexpected controller error: ${msg}`);
    return {
      status: "provider_error",
      message:
        "remember: unexpected internal error; nothing was stored",
    };
  } finally {
    if (ownsHandle) {
      try {
        closeStorage(storage);
      } catch {
        // ignore
      }
    }
  }

  return formatOutcome(outcome);
}

function formatOutcome(outcome: RememberOutcome): RememberResult {
  switch (outcome.status) {
    case "saved":
      return {
        status: "saved",
        message: `Saved memory #${outcome.record.id} (${outcome.record.kind}, confidence ${(outcome.record.confidence ?? 0).toFixed(2)}): ${outcome.record.summary}`,
        memoryId: outcome.record.id,
        memoryKind: outcome.record.kind,
        modelId: outcome.record.modelId,
        confidence: outcome.record.confidence,
        summary: outcome.record.summary,
      };
    case "rejected":
      return {
        status: "rejected",
        message: `Rejected: ${outcome.reason}`,
        safetyClass: outcome.safetyClass,
      };
    case "clarification_needed":
      return {
        status: "clarification_needed",
        message: outcome.question,
        question: outcome.question,
      };
    case "provider_error":
      return {
        status: "provider_error",
        message: `Provider error: ${outcome.reason}`,
      };
  }
}
