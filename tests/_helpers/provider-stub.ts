/**
 * Shared provider stub helpers.
 *
 * These functions build the canonical scripted `fetch` and the
 * safe analysis payload used by controller / adapter tests.
 * The body shape (Postgres summary, tags, classification) comes
 * from the dominant form across the suite. Tests that need a
 * richer payload can pass an `opts` override or define a local
 * helper alongside this one.
 */

interface ScriptedFetch {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
}

/**
 * Build a scripted `fetch` that records every call's URL and
 * body and returns a single canned response. The responder
 * pattern matches `recall-mvp.test.ts`.
 */
export function scriptFetch(responder: () => Response): ScriptedFetch {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return responder();
  };
  return { fetchImpl, calls };
}

/** A minimal chat-completions response shape. */
export function okChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A valid, safe analysis payload the provider would return.
 * The default fields mirror the dominant form across the suite
 * (Postgres summary, 0.82 confidence, etc.).
 */
export function safeAnalysis(opts: {
  summary?: string;
  confidence?: number;
  classification?: string;
  tags?: string[];
} = {}): string {
  return JSON.stringify({
    summary: opts.summary ?? "The project uses Postgres 16 for the primary store.",
    confidence: opts.confidence ?? 0.82,
    tags: opts.tags ?? ["postgres", "storage"],
    entities: [{ name: "Postgres", kind: "database" }],
    classification: opts.classification ?? "fact",
  });
}