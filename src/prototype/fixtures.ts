/**
 * Prototype fixtures for the provider runner.
 *
 * These fixtures represent the P1..P6 structured-output experiments
 * approved for the Phase 1 prototype. Each fixture is a small input
 * that the runner will ask each candidate model to analyze. The
 * runner does not need to know the right answer; it just records
 * parse success, schema validity, and latency.
 *
 * The fixture text is synthetic project context. No real API keys
 * or secrets are embedded.
 *
 * The fixture set is intentionally small and deterministic. Adding
 * more fixtures later is a matter of extending this list.
 */

export interface PrototypeFixture {
  /** Short stable id, e.g. "P1". */
  id: string;
  /** Human description. */
  description: string;
  /** Input text fed to the model. */
  text: string;
}

export const PROTOTYPE_FIXTURES: readonly PrototypeFixture[] = [
  {
    id: "P1",
    description: "Project overview: short factual context.",
    text: "Curion is a project-local memory layer for AI agents. It exposes exactly two tools, remember and recall, over a stdio MCP transport.",
  },
  {
    id: "P2",
    description: "Build and test instruction: structured procedural context.",
    text: "To build and test: run `npm install`, then `npm run build`, then `npm test`. The default log level is info and can be lowered to debug via CURION_LOG_LEVEL=debug.",
  },
  {
    id: "P3",
    description: "Provider configuration: a small list of facts.",
    text: "Curion uses role-based provider configuration. The primary provider is configured via CURION_PRIMARY_BASE_URL, CURION_PRIMARY_API_KEY, and CURION_PRIMARY_MODEL. An optional fallback can be configured via CURION_FALLBACK_BASE_URL, CURION_FALLBACK_API_KEY, and CURION_FALLBACK_MODEL.",
  },
  {
    id: "P4",
    description: "Storage rules: a small policy statement.",
    text: "Project storage lives under the project-local .curion directory. The schema intentionally has no raw text column. The .curion directory and the local .env are gitignored.",
  },
  {
    id: "P5",
    description: "Public API contract: a short stability statement.",
    text: "The public MCP API is exactly two tools, remember and recall, each with one public text parameter. No kinds, states, filters, providers, debug, or storage arguments are accepted.",
  },
  {
    id: "P6",
    description: "Retrieval variants: a short list of placeholder variants.",
    text: "Retrieval benchmark variants in Phase 1 are: fts5, vector, hybrid-rrf, hybrid-rerank, and hybrid-entity-temporal. They are placeholders; the runner will exercise them but no real retrieval is wired in.",
  },
];

export function fixtureById(id: string): PrototypeFixture | undefined {
  return PROTOTYPE_FIXTURES.find((f) => f.id === id);
}
