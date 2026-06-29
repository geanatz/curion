# MCP client setup

Curion is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
**stdio** server. Every supported client spawns the `curion` binary as a
subprocess and exchanges JSON-RPC with it over stdin/stdout. Curion writes
all of its own logs to stderr so they cannot corrupt the MCP protocol stream.

This page covers each supported client in detail. For a quick start with
Claude Code, see the [README](../README.md).

## Conventions used in the examples

- The examples assume `@geanatz/curion` was installed **globally** so the
  `curion` binary is on `PATH`.
- If you installed it as a **project dependency** instead, replace `curion`
  in the `command` field with one of:
  - `npx -y @geanatz/curion` (resolves and runs the published package), or
  - the absolute path to `node_modules/.bin/curion` inside your project.
- The provider env vars (`CURION_PRIMARY_API_KEY`, `CURION_PRIMARY_BASE_URL`,
  `CURION_PRIMARY_MODEL`, …) must be present in the environment the client
  uses to spawn the server. Curion does **not** load `.env` files. See
  [Configuration](configuration.md) for the full set.
- Model examples below use `your-model-id` as a placeholder. Substitute the
  identifier of whichever model you actually have access to.

---

## Claude Code (recommended)

Claude Code is the recommended MCP client for Curion. Registering Curion with
`--scope project` keeps the configuration inside the repo (via a `.mcp.json`
file at the project root), so every contributor on the project gets the same
server setup without touching their global MCP config.

### Register for the current project

```sh
claude mcp add --scope project --transport stdio curion -- curion
```

The resulting `.mcp.json` looks like:

```json
{
  "mcpServers": {
    "curion": {
      "type": "stdio",
      "command": "curion",
      "args": []
    }
  }
}
```

### Pass provider env vars through `.mcp.json`

The simplest way to provide the provider env vars is to export them in the
shell before launching Claude Code, or to pass them through Claude Code's own
environment-passing mechanism. To make the env vars part of the project-scoped
config itself, extend `.mcp.json` with an `env` block:

```json
{
  "mcpServers": {
    "curion": {
      "type": "stdio",
      "command": "curion",
      "args": [],
      "env": {
        "CURION_PRIMARY_API_KEY": "sk-...",
        "CURION_PRIMARY_BASE_URL": "https://api.openai.com/v1",
        "CURION_PRIMARY_MODEL": "your-model-id",
        "CURION_PRIMARY_API_FORMAT": "openai-compatible"
      }
    }
  }
}
```

> **Tip for team-shared `.mcp.json`:** commit only the structural entry
> (`command` / `args` / `type`) and keep the `env` block out of source
> control. Use a per-developer shell environment, a secrets manager, or
> Claude Code's environment-file mechanism for the keys.

---

## OpenAI Codex CLI

Add a `[mcp_servers.curion]` entry either to the user-wide
`~/.codex/config.toml` or to `.codex/config.toml` in the project root:

```toml
[mcp_servers.curion]
command = "curion"

[mcp_servers.curion.env]
CURION_PRIMARY_API_KEY = "sk-..."
CURION_PRIMARY_BASE_URL = "https://api.openai.com/v1"
CURION_PRIMARY_MODEL = "your-model-id"
CURION_PRIMARY_API_FORMAT = "openai-compatible"
```

Or register from the command line:

```sh
codex mcp add curion -- curion
```

---

## OpenCode

Add an entry to the user-wide `~/.config/opencode/opencode.json` or to
`opencode.json` in the project root:

```json
{
  "mcp": {
    "curion": {
      "type": "local",
      "command": ["curion"]
    }
  }
}
```

Provider env vars must be available in the environment OpenCode uses to
spawn the server — export them in the shell before launching OpenCode, or
configure them through OpenCode's environment mechanism.

---

## Claude Desktop (generic / secondary)

Claude Desktop is a generic MCP client that can spawn any stdio MCP server,
including `curion`. It is included here as a secondary option; Claude Code
is the recommended client for project-local memory.

Add an entry to `~/.claude.json` (or the project-level equivalent):

```json
{
  "mcpServers": {
    "curion": {
      "command": "curion",
      "env": {
        "CURION_PRIMARY_API_KEY": "sk-...",
        "CURION_PRIMARY_BASE_URL": "https://api.openai.com/v1",
        "CURION_PRIMARY_MODEL": "your-model-id"
      }
    }
  }
}
```

---

## Pi Coding Agent (no native MCP support)

Pi Coding Agent does **not** natively support the Model Context Protocol, so
Curion cannot be registered through Pi's built-in settings. Using Curion
from Pi would require a custom or third-party MCP extension that bridges
Pi to a stdio MCP server, which is outside Curion's scope and is not
officially supported. For native MCP support, use Claude Code, Codex CLI,
or OpenCode above.

---

## Other MCP clients (generic stdio)

Any MCP client that follows the stdio convention can spawn `curion` with
the provider env vars in the environment. The minimum viable invocation is:

```sh
curion
```

with `CURION_PRIMARY_*` (and optionally `CURION_FALLBACK_*`,
`CURION_SEMANTIC_*`, `CURION_LOG_LEVEL`) set in the spawn environment. See
the [Configuration](configuration.md) page for the full variable list.

No `.env` file is loaded — secrets must be passed by the parent process.