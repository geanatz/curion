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
 *
 * Multi-project awareness:
 *   - After a successful `remember` (status: saved), the current
 *     project is registered in the central registry.
 *   - Private projects are not registered.
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
import {
  createSemanticEmbedder,
} from "../retrieval/semantic/embedder.js";
import {
  embedOnRemember,
} from "../retrieval/semantic/embed-on-remember.js";
import { logger } from "../logging/logger.js";
import { startToolBoundaryTrace } from "../trace/index.js";
import { z } from "zod";
import path from "node:path";
import { registerProject } from "../config/registry.js";
import { isProjectPrivate } from "../config/project-config.js";
import { loadEnv } from "../config/env.js";

export const REMEMBER_TOOL_NAME = "remember" as const;
export const REMEMBER_TOOL_DESCRIPTION =
  "Store a piece of project memory. Returns a saved / rejected / clarification_needed / provider_error outcome.";

export interface RememberInput {
  text: string;
}

/**
 * Strict Zod v3 object schema for the public `remember` tool
 * input. `.strict()` makes the MCP SDK's `validateToolInput`
 * reject any unknown top-level key — the only acceptable key
 * is `text`. The SDK wires this through to the on-the-wire
 * `tools/list` JSON schema (with `additionalProperties: false`
 * via the strict-Union projection), so the public input
 * contract is pinned at the schema level, not just at the
 * handler level.
 *
 * Schema surface (preserved):
 *   - one `text` property (string, required, min 1)
 *   - no kinds, states, filters, providers, debug, or storage
 *     knobs
 */
export const REMEMBER_INPUT_SCHEMA = z
  .object({
    text: z
      .string()
      .min(1, "text must not be empty")
      .describe("The memory text to store."),
  })
  .strict();

/**
 * Public tool-layer result. The `message` field is the only field the
 * MCP `text` content block carries. Structured fields are exposed via
 * `outcome` for tests and any future structured-content transport.
 *
 * The public `message` deliberately omits the saved memory id. The id
 * is an internal storage handle and is not part of the user-facing
 * surface; it is preserved on the `memoryId` structured field for
 * tests, future structured-content transport, and any future
 * agent-facing API that needs it. The on-the-wire MCP `text` content
 * block is calm prose: the kind, the confidence, and the persisted
 * summary — never the id.
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
 * Get the current project root from a storage handle.
 * The handle's `dir` is the `.curion/` path; the project root
 * is its parent directory.
 */
function getProjectRootFromHandle(handle: StorageHandle): string {
  return path.dirname(handle.dir);
}

/**
 * Run the narrow `remember(text)` pipeline. Defensive shape check
 * on `input.text`, then delegate to the controller.
 *
 * Tool-boundary tracing (Phase 2): every public invocation
 * opens a single trace run and records one `tool.input` event at
 * entry, one `tool.output` event with the result the handler
 * returns, and the run's final status + duration on exit. The
 * tracer is the existing non-throwing writer; trace failures
 * NEVER change the result and NEVER throw into the MCP path.
 *
 * Multi-project awareness:
 *   - After a successful `remember` (status: saved), the current
 *     project is registered in the central registry if not private.
 */
export async function handleRemember(input: unknown): Promise<RememberResult> {
  // Open the trace run at the public tool boundary. The helper
  // is a no-op when `CURION_TRACE_ENABLED=0` or the writer is
  // unavailable; in either case the rest of the handler runs
  // unchanged.
  const trace = startToolBoundaryTrace({ toolName: "remember", input });
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { text?: unknown }).text !== "string"
    ) {
      // Validation failure (programmer / SDK error — the strict
      // schema should already have rejected this). The trace run
      // finishes as `error` and re-throws.
      throw new Error("remember: `text` (string) is required");
    }
    const text = (input as { text: string }).text;
    if (text.trim().length === 0) {
      throw new Error("remember: `text` (string) must be non-empty");
    }

    const { handle: storage, ownsHandle } = storageProvider();
    const currentProjectRoot = getProjectRootFromHandle(storage);
    const env = loadEnv();
    let outcome: RememberOutcome;
    try {
      outcome = await runRememberController(storage, text);

      // After successful save, generate and store semantic embedding.
      // This must happen while the storage handle is still open.
      // Embedding failures are non-fatal — the memory is already saved.
      // Only attempt when semantic retrieval is enabled via env config.
      if (outcome.status === "saved" && env.semanticEnabled) {
        try {
          const embedder = await createSemanticEmbedder({
            enabled: true,
            allowRemote: env.semanticAllowRemote,
            cacheDir: env.semanticCacheDir,
            modelId: env.semanticModelId,
          });
          const embedResult = await embedOnRemember(
            storage,
            embedder,
            outcome.record.id,
            outcome.record.memoryContent,
            outcome.record.modelId ?? undefined,
          );
          if (!embedResult.stored) {
            logger.debug(
              `remember: embedding failed: ${embedResult.error ?? "unknown"}`,
            );
          }
        } catch (err) {
          // Non-fatal: embedding failure should not break the save outcome.
          logger.debug(
            `remember: embedding threw: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      // Unexpected throw — log and surface a provider_error outcome.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`remember: unexpected controller error: ${msg}`);
      const result: RememberResult = {
        status: "provider_error",
        message:
          "remember: unexpected internal error; nothing was stored",
      };
      // The handler returned a result, so the run is `ok` (the
      // handler itself did not throw). The provider_error status
      // is captured in the persisted tool.output event.
      trace.recordOutput(result);
      trace.finish("ok");
      return result;
    } finally {
      if (ownsHandle) {
        try {
          closeStorage(storage);
        } catch {
          // ignore
        }
      }
    }

    // Register the current project after successful remember.
    // Only register non-private projects.
    if (outcome.status === "saved" && !isProjectPrivate(currentProjectRoot)) {
      registerProject(currentProjectRoot);
    }

    const result = formatOutcome(outcome);
    trace.recordOutput(result);
    trace.finish("ok");
    return result;
  } catch (err) {
    // The handler itself threw (validation or some other
    // unexpected path). Record the run as `error` and re-throw
    // so the MCP layer sees the original error.
    trace.finish("error");
    throw err;
  }
}

function formatOutcome(outcome: RememberOutcome): RememberResult {
  switch (outcome.status) {
    case "saved":
      // Public message omits the saved memory id. The id is
      // an internal storage handle and is preserved on the
      // `memoryId` structured field for tests and any future
      // structured-content transport; the on-the-wire MCP
      // `text` content block carries calm prose only.
      //
      // Phase 1 internal naming cleanup: the internal record
      // carries `memoryContent`; the public surface
      // (`RememberResult.summary`) keeps the public name
      // `summary` for backward compatibility. The tool layer
      // is the boundary that maps between the two.
      return {
        status: "saved",
        message: `Saved memory (${outcome.record.kind}, confidence ${(outcome.record.confidence ?? 0).toFixed(2)}): ${outcome.record.memoryContent}`,
        memoryId: outcome.record.id,
        memoryKind: outcome.record.kind,
        modelId: outcome.record.modelId,
        confidence: outcome.record.confidence,
        summary: outcome.record.memoryContent,
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
