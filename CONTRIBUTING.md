# Contributing to Curion

Thanks for your interest in Curion. This document explains how to set
up the project locally, the conventions we follow, and how to land a
change through a pull request.

Curion is a TypeScript MCP (Model Context Protocol) stdio server that
gives LLM-driven agents a persistent, project-local memory store. The
public API surface is small and stable: two tools (`remember` and
`recall`), each with a single `text` parameter and a frozen
`text` / `structuredContent` output shape. Most contributions are to
the retrieval engine, the storage layer, or the diagnostic test
suite.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
By participating, you agree to its standards.

## How to contribute

### Reporting bugs

Open a GitHub issue at
[`github.com/geanatz/curion/issues`](https://github.com/geanatz/curion/issues).
Please include:

- A clear, descriptive title.
- Steps to reproduce (the exact `text` you passed to `remember` /
  `recall`, your provider config, your Node version).
- The actual output (the `text` content block and the
  `structuredContent` payload) and what you expected.
- A minimal reproducible example if possible.

If the bug is a security issue, **do not** open a public issue — see
[SECURITY.md](./SECURITY.md) for the private reporting channel.

### Suggesting features

Open a GitHub issue with the `enhancement` label. Explain the
motivation, the desired behaviour, and why the change belongs in
Curion (versus a separate project). Remember that the public MCP
surface is frozen at v0.2.x, so changes that affect the two tools'
input schemas, status set, or output shapes need a major-version
discussion.

### Submitting pull requests

1. Fork the repository and create a feature branch off `main`.
2. Make your change with tests. See "Pull request process" below.
3. Ensure `npm test`, `npm run lint`, and `npm run test:coverage` all
   pass locally.
4. Update `CHANGELOG.md` if the change is user-facing.
5. Open a pull request against `main`.

## Development setup

### Prerequisites

- **Node.js 22 LTS or newer.** The CI runs on Node 22; the package's
  `engines` field requires it.
- **npm 10+** (ships with Node 22).
- A C toolchain and Python 3 are required to build the
  `better-sqlite3` native module from source. On Debian / Ubuntu,
  `apt install build-essential python3` is enough. On macOS, the
  Xcode Command Line Tools provide the same. Prebuilt binaries are
  used when available.

### Clone and install

```sh
git clone https://github.com/geanatz/curion.git
cd curion
npm ci
```

`npm ci` installs the locked dependency set from `package-lock.json`.
Use `npm install` only when you intentionally want to update the
lockfile.

### Build, test, and lint

```sh
npm run build          # TypeScript -> dist/
npm test               # node:test runner, all tests
npm run test:coverage  # c8 coverage (text, text-summary, html, lcov)
npm run lint           # biome check src tests
npm run lint:fix       # biome check --write --unsafe src tests
npm run format         # biome format --write src tests
npm run format:check   # biome format src tests  (CI gate)
npm start              # run the built server (after build)
npm run clean          # rm -rf dist
```

Run the build before running the server — the package's `bin` entry
points at `dist/index.js`.

## Project structure

```
src/
  index.ts              # MCP stdio server entry point
  server.ts             # MCP server wiring
  controller/           # remember + recall controllers (domain logic)
  providers/            # Provider adapters (OpenAI-compatible, Anthropic)
  retrieval/            # Lexical + semantic retrieval
    semantic/           # Production semantic retrieval (opt-in)
  storage/              # SQLite persistence (better-sqlite3)
  safety/               # Input safety pre-check
  tools/                # MCP tool implementations
  config/               # Env reading, project config, registry
  trace/                # Trace layer (redaction, retention, writer)
  log/                  # Logger (stderr-only)
  prototype/            # Provider prototype runner (NOT production)
  benchmark/            # Retrieval benchmark harness (NOT production)
    variants/           # Benchmark-only ranker variants
tests/
  contracts.test.ts     # API contract tests
  mcp-stdio-e2e.test.ts # End-to-end stdio tests
  retrieval-*.test.ts   # Retrieval tests
  remember-*.test.ts    # Remember tests
  diagnostics/          # Diagnostic signal tests
    timing.test.ts      #   Critical-path performance tests
    properties.test.ts  #   Property-based tests (fast-check)
  _helpers/             # Shared test helpers
    test-storage.ts     #   mkStorage / rmStorage
    env.ts              #   withCleanEnv
    provider-stub.ts    #   scriptFetch / okChatResponse / safeAnalysis
    fs-walk.ts          #   walkTs
    timing.ts           #   Performance timing helpers
    *.test.ts           #   Live-provider retrieval tests
  shared-test-provider.ts  # Standardised test provider constants
```

`src/prototype/` and `src/benchmark/` are excluded from the default
build (the `files` field in `package.json` ships `dist` but
negates `dist/benchmark/` and `dist/prototype/`). They contain
research code and benchmark-only ranker variants that are not part
of the public MCP surface.

## Code style

- **TypeScript strict mode.** `strict: true` plus
  `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `noImplicitReturns`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`. New code must compile under all
  five.
- **Biome for formatting and linting.** `npm run lint` and
  `npm run format`. The formatter is authoritative — do not
  hand-format around it. Configured in `biome.json`.
- **Style.** 100-character line width, double quotes, semicolons,
  2-space indent, LF line endings. `organizeImports` is enabled;
  Biome will reorder imports on save.
- **Conventional Commits.** Use `feat:`, `fix:`, `chore:`,
  `refactor:`, `test:`, `docs:`, `perf:`, or `build:` as the commit
  message prefix. A scope is optional (`feat(retrieval): …`).
- **Public API is frozen.** Do not change the two tools' input
  schemas, the status set, or the public `text` /
  `structuredContent` shapes without a major-version discussion.
- **No secrets in source.** Real API keys come from the operator's
  environment. Test code uses the constants in
  `tests/shared-test-provider.ts` (which are obviously fake).

## Pull request process

1. **Fork the repository** and create a feature branch off `main`.
   Branch names: `feat/...`, `fix/...`, `refactor/...`,
   `chore/...`, `docs/...`, `test/...`.
2. **Write tests** for any new behaviour. New code under `src/` must
   have a corresponding test under `tests/`. If you are adding a
   new diagnostic signal, follow the patterns in
   `tests/diagnostics/`.
3. **Run the full check locally** before pushing:
   ```sh
   npm run build
   npm test
   npm run lint
   npm run test:coverage
   ```
   All four must pass. Coverage may drop slightly when adding new
   code; flag the change in the PR description.
4. **Update `CHANGELOG.md`** under the `[Unreleased]` section if the
   change is user-facing. Add an entry under `Added`, `Changed`,
   `Fixed`, `Removed`, or `Security` as appropriate.
5. **Open a pull request** against `main`. The PR description should
   include:
   - A one-line summary.
   - The motivation and the user-facing change (if any).
   - Test plan and any manual verification you performed.
   - Any backwards-compatibility implications.
6. **Address review feedback.** The maintainer may request changes
   before merging. Squashing during merge is the default.

## Reporting security issues

Please **do not** file a public GitHub issue for security
vulnerabilities. Instead, follow the private reporting channel in
[SECURITY.md](./SECURITY.md). The expected response time is 7 days.

## License

By contributing, you agree that your contributions will be licensed
under the Apache License, Version 2.0 — the same license that covers
the rest of the project. See [LICENSE](./LICENSE) for the full text.
