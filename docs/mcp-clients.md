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

## stdio is the only transport

Curion only exposes the stdio transport. It does **not** open any network
sockets and does **not** run as a long-lived process you start from a
terminal. The MCP host (your client) spawns `curion` as a subprocess and is
responsible for the network boundary, all authentication, and all
authorization. The trust boundary is the parent process boundary.

### Anything written to stdout corrupts the protocol

If you wrap `curion` (a shell script, a launcher, a container entrypoint),
**never** capture or redirect stdout. Any non-JSON-RPC bytes on stdout
will break every subsequent frame. Logs must travel on stderr (the
built-in logger is stderr-only). If you need to suppress logs in a
wrapper, redirect stderr (`2>/dev/null` or `2>log.txt`), not stdout.

## Common pitfalls

These cover the failure modes we have seen most often in real client
configurations. They are not Curion bugs; they are how the underlying
transport / shell / OS environment behaves.

### Absolute paths beat shell resolution

MCP hosts spawn the server exactly as written in the config. They do
not run the `command` through a login shell, so shell aliases, `~/.bashrc`
exports, and `nvm` shims may not be available. Prefer an absolute path
in the `command` field when in doubt:

```json
{
  "mcpServers": {
    "curion": {
      "command": "/home/you/.nvm/versions/node/v22/bin/curion"
    }
  }
}
```

You can locate the absolute path of the global install with
`which curion` (POSIX) or `where curion` (Windows cmd). For a
project-local install, use the absolute path to
`node_modules/.bin/curion` inside your project (resolve with
`ls "$(pwd)/node_modules/.bin/curion"`).

### Windows / `npx` wrapper

Some MCP clients on Windows resolve `curion` from `PATH` inconsistently
— particularly when the client itself runs as a service or a packaged
desktop app and does not inherit the user's shell `PATH`. The most
reliable workaround is the `cmd /c npx` wrapper:

```json
{
  "mcpServers": {
    "curion": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@geanatz/curion"]
    }
  }
}
```

PowerShell users can use the equivalent `npx.cmd` form:

```json
{
  "mcpServers": {
    "curion": {
      "command": "npx.cmd",
      "args": ["-y", "@geanatz/curion"]
    }
  }
}
```

If your client passes per-server `env`, keep that block working through
the wrapper — `cmd /c npx ...` inherits the spawn environment by default
on Windows.

### Provider env vars must be in the spawn environment

Curion does **not** load `.env` files. The provider env vars must be
present in the environment the client uses to spawn the server. For
Claude Code, the safest pattern is to export them in your shell before
launching the client; for a project-scoped config, use the per-server
`env` block in `.mcp.json` (and either keep it out of source control or
document how the team provides the secrets).

### Inspect the JSON-RPC stream with the MCP Inspector

The official
[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is
the canonical way to debug a stdio MCP server. It spawns `curion` for
you, lets you list tools, and lets you invoke `remember` / `recall`
with arbitrary `text`:

```sh
npx -y @modelcontextprotocol/inspector curion
```

The Inspector uses the same stdio transport your real client uses, so
whatever works in the Inspector is what your client will see. This is
the recommended first step when a tool call is failing unexpectedly.

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

`.mcp.json` is listed in `.gitignore` by default (Claude Code writes it
locally; it is per-developer state, not source). Do not commit it.

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
`CURION_SEMANTIC_*`, `CURION_LOG_LEVEL`, `CURION_TRACE_ENABLED`) set in
the spawn environment. See the [Configuration](configuration.md) page
for the full variable list.

No `.env` file is loaded — secrets must be passed by the parent process.

If you are integrating Curion with an MCP client that is not listed here
and run into a config issue, the
[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is
the easiest way to confirm whether the server itself starts cleanly
before debugging client wiring.