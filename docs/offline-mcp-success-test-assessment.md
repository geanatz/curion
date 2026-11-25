# Curion issue #6: offline MCP success-path assessment

**Recommendation:** implement one deterministic stdio round-trip test for `remember.saved` and `recall.answered`.

## Decision

- One child process can exercise both successful public tool callbacks, their actual MCP wire projection, persistence between calls, and provider configuration loaded in the server process.
- Two separate tests would isolate failures, but duplicate the child and provider fixture without covering a distinct contract. Split later only if diagnosis proves difficult.

## Evidence

- `docs/direction.md` (Product boundaries) pins the stable contract: stdio transport, exactly `remember(text)` and `recall(text)`, `text`/`structuredContent` responses, and project-local `.curion/` runtime storage.
- `tests/mcp-stdio-e2e.test.ts`: `StdioMcpClient.start` spawns `dist/index.js`, assigns disposable `HOME`, and `close` removes it; `isolatedEnv` filters inherited settings; `seedProject` creates a disposable project store.
- Existing stdio cases at lines 808, 1159, and 1222 cover `no_memory` and missing-key `provider_error` outcomes; they do not prove a successful provider-backed tool call.
- `tests/structured-content.test.ts`: `callToolHandler` drives registered callbacks for simple statuses, but `projectRecallWireFormat` injects fetch into the controller then projects the answer; the `remember.saved` case similarly runs the controller and builds the projection directly (lines 184, 855, 1072).
- `src/providers/env-helpers.ts::loadRoleConfig`, `src/providers/memory-analysis.ts::loadAdapterConfig`, and `src/providers/recall-synthesis.ts::loadRecallAdapterConfig` read provider settings from environment. `src/providers/http-client.ts::chatCompletion` posts to the configured base URL plus `/chat/completions`.
- **Not yet evidenced:** no current test demonstrates a successful provider response passing through the spawned server and back over stdio; the fixture below is a proposal, not existing behavior or test evidence.

## Smallest feasible fixture

- Add one round-trip test: initialize the child; call `remember` with safe input; then query that saved memory with `recall`.
- Reuse `StdioMcpClient` isolation and a fresh `seedProject` directory. Return a canned analysis JSON response first and a canned answer second from a tiny local OpenAI-compatible HTTP stub.
- Supply only dummy primary key/model values and a primary base URL pinned to the stub's ephemeral `127.0.0.1` port. Leave fallback unset; explicitly disable semantic retrieval and remote downloads.
- Bind the stub to loopback only, accept only the expected chat-completions method/path, and fail on unexpected requests. Keep the environment allowlist; for a strict egress guarantee, block non-loopback fetches in the child or run under network-denied CI.
- Close the child and stub and remove both temporary project storage and `HOME` in `finally`. No real credentials, provider service, or external request is needed.

## Acceptance checks

- The spawned MCP process returns `remember.saved` and then `recall.answered` with the expected summary/answer in both structured content and text; recall demonstrates the first call persisted memory.
- The stub observes exactly the intended two local requests; unexpected retries, fallback calls, paths, or non-loopback URLs fail closed.
- Cleanup runs on success and failure. This assessment did not implement or execute the proposed test.
