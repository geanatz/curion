/**
 * Shared scripted fetch / no-network stubs for the
 * benchmark harness.
 *
 * The benchmark suites run the real controller / adapter
 * code path but stub out the provider call: the harness
 * installs a scripted `fetch` via the test-only
 * `fetchImpl` override seam and asserts the controller /
 * adapter produces the expected structured outcome.
 *
 * This module centralises the scaffolding every
 * benchmark scripted-fetch was duplicating:
 *
 *   - `okChatResponse(content)` — the minimal
 *     chat-completions 200 response shape the provider
 *     adapter expects.
 *
 *   - `upstreamFailureResponse()` — a 503 with an empty
 *     error body, mirroring the canonical "upstream is
 *     down" response the harness scripts for hard-
 *     failure paths.
 *
 *   - `recordScriptedFetchCall(input, init)` — extract
 *     the URL + body strings from a fetch call so the
 *     harness can audit what was sent without forwarding
 *     it anywhere.
 *
 *   - `buildRecordingScriptedFetch(responder)` — a
 *     scripted `fetch` that records every call's URL +
 *     body and delegates the response to the provided
 *     responder. The handle is the `{fetchImpl, calls}`
 *     pair every scripted-fetch consumer expects.
 *
 * The byte shape of `okChatResponse` and
 * `upstreamFailureResponse` is preserved from the
 * existing inline copies in
 * `src/benchmark/decision-policy-evaluation.ts` and
 * `src/benchmark/adaptive-depth-evaluation.ts` so the
 * migration does not change the per-call bytes the
 * adapter sees.
 *
 * Why this lives in `src/benchmark/_scripted-fetch.ts`
 * (and not in `tests/_helpers/provider-stub.ts`):
 *
 *   The benchmark helpers live under `src/` and have the
 *   `tsconfig.json` `rootDir: "src"` constraint that
 *   prevents importing from `tests/`. The test helper
 *   (`tests/_helpers/provider-stub.ts`) remains the
 *   canonical version for unit tests; this module is the
 *   benchmark-side mirror. The two share the byte shape
 *   so a reviewer who reads both sees the same contract.
 *
 * Scope (benchmark-only):
 *
 *   The scripted fetch is the ONLY provider path. The
 *   harness never reaches a real provider URL; the
 *   `fetchImpl` override seam is the test-only slot the
 *   controller / adapter exposes for exactly this
 *   purpose. A future benchmark that needs a real
 *   provider call is a deliberate, visible change.
 */

export interface ScriptedFetchCall {
  /** The URL the scripted fetch was called with. */
  url: string;
  /** The body string the scripted fetch was called with. */
  body: string;
}

export interface ScriptedFetchHandle {
  /** The function the harness wires into the controller / adapter. */
  fetchImpl: typeof fetch;
  /** Every call the scripted fetch saw, in order. */
  calls: Array<ScriptedFetchCall>;
}

/**
 * Extract the URL + body strings from a fetch call. The
 * function is tolerant of `string` URLs, `URL`
 * instances, and `Request` instances (the shapes `fetch`
 * accepts at runtime). The `Request` shape is DOM-only
 * and not part of `tsconfig.json`'s lib config; we
 * accept `unknown` here and coerce via `.toString()`
 * inside, matching the existing inline benchmark helpers.
 *
 * Used by `buildRecordingScriptedFetch` and by harnesses
 * that maintain their own per-call state machines (e.g.
 * the decision-policy runner's primary / repair / fallback
 * state machine).
 */
export function recordScriptedFetchCall(
  input: unknown,
  init: RequestInit | undefined
): ScriptedFetchCall {
  const url = typeof input === "string" ? input : (input as URL).toString();
  let body = "";
  if (init && typeof init === "object" && "body" in init && init.body) {
    body = String(init.body);
  }
  return { url, body };
}

/**
 * Build a scripted `fetch` that records every call and
 * delegates the response to the supplied responder. The
 * handle is `{ fetchImpl, calls }`; `fetchImpl` is the
 * value the harness wires into the controller / adapter
 * via the `fetchImpl` override seam, and `calls` is the
 * audit log the harness can inspect after the run.
 *
 * The helper is the shared recording scaffolding. The
 * per-call state machine (primary first / primary repair
 * / fallback first / fallback repair) lives in the
 * harness itself; the helper only handles the "record
 * every call + delegate the response" plumbing.
 */
export function buildRecordingScriptedFetch(responder: () => Response): ScriptedFetchHandle {
  const calls: Array<ScriptedFetchCall> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(recordScriptedFetchCall(input, init));
    return responder();
  };
  return { fetchImpl, calls };
}

/**
 * The minimal chat-completions 200 response shape the
 * provider adapter expects. The byte shape is preserved
 * from the inline copies in the existing benchmark
 * runners (`chatCompletionsResponse` in
 * `decision-policy-evaluation.ts`, `okChatResponse` in
 * `adaptive-depth-evaluation.ts`) so the migration does
 * not change the per-call bytes the adapter sees.
 *
 * The function name is `okChatResponse` (matching the
 * adaptive-depth runner's existing local name and the
 * test helper's name) so a reviewer who reads either
 * benchmark runner sees the same contract.
 */
export function okChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/**
 * A 503 response with an empty error body. The harness
 * returns this for scripted provider hard failures so the
 * adapter's hard-failure path surfaces cleanly.
 *
 * The byte shape is preserved from the inline copy in
 * `decision-policy-evaluation.ts`. The function name
 * matches the existing inline name so the harness's
 * `resolveScriptedResponse` can call it without a rename.
 */
export function upstreamFailureResponse(): Response {
  return new Response(JSON.stringify({ error: "upstream" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}
