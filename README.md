# Curion

Curion gives compatible AI agents project-local memory they can save and retrieve
across sessions.

Curion runs as an MCP server over stdio. Its `remember(text)` and `recall(text)`
tools each accept only one argument: `text`.

## Requirements

- Node.js 22 or newer
- npm
- An MCP client, such as Codex CLI or Claude Code

## Install

```sh
npm install -g @geanatz/curion
```

The `curion` command is an MCP stdio server entry point. Your MCP client starts
it when needed; do not run it as an interactive terminal command.

## Connect Codex CLI

```sh
codex mcp add curion -- curion
```

Restart or reload Codex CLI if needed. This registers Curion as an MCP server;
it does not configure Curion's model provider.

Claude Code is also supported. To register it for the current project, run:

```sh
claude mcp add --scope project --transport stdio curion -- curion
```

Other clients and setup details are in
[MCP client setup](docs/mcp-clients.md).

## Configure a provider

Curion has no built-in provider. Configure a primary provider in the environment
inherited by the MCP client before launching it. For an OpenAI-compatible API,
set:

```sh
export CURION_PRIMARY_API_KEY='<your-api-key>'
export CURION_PRIMARY_BASE_URL='https://api.example.com/v1'
export CURION_PRIMARY_MODEL='<model-id>'
```

These are placeholders: replace them locally with values from a provider you
choose. Keep real keys out of source control, shared configuration, screenshots,
and support logs. A Codex or Claude login is separate from a provider API key;
signing into either client does not configure Curion's provider.

Curion reads `process.env` from its parent process. It does not load `.env` files,
so a key in a project `.env` file alone will not be available. Provider format
and client-specific environment setup are covered in [Configuration](docs/configuration.md)
and [MCP client setup](docs/mcp-clients.md).

## Use the tools

Ask your agent to remember useful project information, for example:

> Remember that API routes use the `/api/v1` prefix and tests use Vitest.

Later, ask a question that uses the stored context:

> Which prefix do our API routes use?

The agent calls `remember` or `recall` with the request as the tool's single
`text` value. The tools may decline or fail to process a request; they do not
promise that every submitted detail will be saved or found.

## Privacy and storage

Curion stores project memory in a local SQLite database under `.curion/` in the
project directory. That local storage does not mean all processing stays on your
device: when a provider is configured, some submitted tool content or derived
context is sent to that third-party model API to process remember or recall
requests. Review your provider's data handling terms and avoid sending information
you do not want that provider to receive.

Semantic retrieval is optional. If enabled, Curion may download an embedding model
from Hugging Face and cache it locally. It runs on-device after download. Semantic
retrieval can also search other projects that are not marked private. See
[Privacy and storage](docs/privacy-storage.md) for details and how to mark a
project private.

New Windows data directories receive a protected ACL, but Curion does not migrate
ACLs on existing `.curion` directories. Review existing directory permissions
yourself before relying on them for privacy.

## Troubleshooting

- **Curion tools are missing:** confirm the client registered `curion` and can find the globally installed command; reload the client after registration.
- **Provider errors or incomplete results:** check that the provider variables are
  available to the process launching the MCP client and that the key, endpoint,
  and model are valid. Without provider configuration, some `remember` paths may
  reject the request and `recall` may not produce a synthesized answer. Local
  storage does not provide an offline substitute for provider processing.
- **The server does not start:** confirm Node.js is version 22 or newer. For client-specific launch issues, see [MCP client setup](docs/mcp-clients.md).

## More information

- [Configuration](docs/configuration.md) — provider variables and optional settings
- [MCP client setup](docs/mcp-clients.md) — supported clients and launch troubleshooting
- [Privacy and storage](docs/privacy-storage.md) — local data, provider processing, and cross-project recall
- [API reference](docs/reference.md) — tool inputs and responses
- [Release notes](CHANGELOG.md)
