/**
 * CLI help text for the `curion` binary.
 *
 * The `curion` binary is primarily an MCP stdio server. A user
 * running `curion --help` from a shell sees this help. A user
 * running `curion --version` sees just the version on its own
 * line (so it can be embedded in scripts / CI).
 *
 * This module is the single source of truth for the help text.
 * The flag interception in `src/index.ts` calls
 * `buildHelpText(VERSION)` and writes the result to stdout.
 *
 * Output conventions:
 *   - Single trailing newline.
 *   - Pure: no I/O. The caller decides where to write the text.
 *   - Self-contained: a user can understand what `curion` is
 *     from this text alone, including the env-var contract and
 *     where to find more docs.
 *
 * The `version` argument is injected so the function stays pure
 * and testable without importing `./version.js`. The
 * entrypoint passes the runtime `VERSION` constant; tests pass
 * a stable fixture.
 */

const DOCS_URL = "https://github.com/geanatz/curion#readme";

/**
 * Build the help text for `curion --help`. Pure function.
 */
export function buildHelpText(version: string): string {
  return [
    "curion — project-local memory layer for AI agents",
    "",
    "Usage:",
    "  curion                  Start the MCP stdio server (default). Speaks",
    "                          JSON-RPC over stdin/stdout; logs travel on",
    "                          stderr. Always launch through an MCP client",
    "                          that manages the stdio transport.",
    "",
    "Options:",
    "  -h, --help              Show this help and exit.",
    "  -v, --version           Print the version and exit.",
    "",
    "Tools (over MCP):",
    "  remember(text)          Store a piece of project memory.",
    "  recall(text)            Retrieve the relevant pieces.",
    "",
    "Configuration:",
    "  Curion is configured through environment variables passed by the",
    "  parent process. It does not load .env files. The minimum is a",
    "  primary provider:",
    "    CURION_PRIMARY_API_KEY, CURION_PRIMARY_BASE_URL,",
    "    CURION_PRIMARY_MODEL",
    "  Optional: a fallback provider, semantic retrieval",
    "  (CURION_SEMANTIC_ENABLED), and log level (CURION_LOG_LEVEL).",
    "",
    `Docs: ${DOCS_URL}`,
    "",
  ].join("\n");
}
