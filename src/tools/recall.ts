/**
 * `recall(text)` tool.
 *
 * Public MCP contract (unchanged):
 *   - Accepts exactly one public `text` parameter (string).
 *   - Returns a `text` content block carrying a short human-readable
 *     answer, or `No relevant memory found.` when retrieval finds
 *     nothing.
 *   - Must not accept kinds, states, filters, providers, debug, or
 *     storage arguments.
 *
 * MVP behavior:
 *   - `answered`            -> the synthesized answer.
 *   - `no_memory`           -> "No relevant memory found."
 *   - `rejected`            -> a short reason that does not echo
 *                              the query (e.g. obvious secret in
 *                              the query).
 *   - `provider_error`      -> a short, redacted reason; the
 *                              controller does not fabricate an
 *                              answer when the provider fails.
 *
 * The public message is the only thing the MCP `text` content
 * block carries. Structured fields are exposed via `outcome` for
 * tests and any future structured-content transport.
 *
 * Storage and provider behavior are not exposed to the caller.
 */

import {
  runRecallController,
  type RecallOutcome,
} from "../controller/recall-controller.js";
import {
  initStorage,
  closeStorage,
  type StorageHandle,
} from "../storage/storage.js";
import { logger } from "../logging/logger.js";

export const RECALL_TOOL_NAME = "recall" as const;
export const RECALL_TOOL_DESCRIPTION =
  "Retrieve relevant project memory. Returns a synthesized answer from stored memories, or 'No relevant memory found.'.";

export const NO_RELEVANT_MEMORY = "No relevant memory found.";

export interface RecallInput {
  text: string;
}

export const RECALL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    text: {
      type: "string" as const,
      description: "The query to recall memory for.",
    },
  },
  required: ["text"] as const,
  additionalProperties: false as const,
};

/**
 * Tool-layer result. The `message` field is the only field the MCP
 * `text` content block carries. Structured fields are exposed via
 * `outcome` for tests and any future structured-content transport.
 *
 * The public message is never allowed to echo raw input, raw
 * queries, or secret-shaped fragments. The controller returns
 * `provider_error` (not a fabricated answer) when the synthesis
 * output fails validation.
 */
export interface RecallResult {
  status: RecallOutcome["status"];
  /** Short human-readable message. Never echoes raw input. */
  message: string;
  /** Synthesized answer, when `status === "answered"`. */
  answer?: string;
  /** Memory ids the answer was synthesized from, when answered. */
  sourceIds?: number[];
  /** Safety class, when `status === "rejected"`. */
  safetyClass?: string;
}

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
 * Run the narrow `recall(text)` pipeline. Defensive shape check
 * on `input.text`, then delegate to the controller.
 */
export async function handleRecall(input: unknown): Promise<RecallResult> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as { text?: unknown }).text !== "string"
  ) {
    throw new Error("recall: `text` (string) is required");
  }
  const text = (input as { text: string }).text;
  if (text.trim().length === 0) {
    throw new Error("recall: `text` (string) must be non-empty");
  }

  const { handle: storage, ownsHandle } = storageProvider();
  let outcome: RecallOutcome;
  try {
    outcome = await runRecallController(storage, text);
  } catch (err) {
    // Unexpected throw — log and surface a provider_error outcome.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`recall: unexpected controller error: ${msg}`);
    return {
      status: "provider_error",
      message:
        "recall: unexpected internal error; no memory was returned",
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

function formatOutcome(outcome: RecallOutcome): RecallResult {
  switch (outcome.status) {
    case "answered":
      return {
        status: "answered",
        message: outcome.answer,
        answer: outcome.answer,
        sourceIds: [...outcome.sourceIds],
      };
    case "no_memory":
      return {
        status: "no_memory",
        message: NO_RELEVANT_MEMORY,
      };
    case "rejected":
      return {
        status: "rejected",
        message: `Rejected: ${outcome.reason}`,
        safetyClass: outcome.safetyClass,
      };
    case "provider_error":
      return {
        status: "provider_error",
        message: `Provider error: ${outcome.reason}`,
      };
  }
}
