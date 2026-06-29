# Privacy & storage

## Project-local memory

Curion runs in your project directory and remembers what your AI agent
learns across sessions — design decisions, architecture choices, team
conventions, and anything else you store via `remember(text)`. When you
ask via `recall(text)`, it retrieves relevant memories from your local
project store.

Curion is **not** a shared team memory. Each project has its own private
store. Memories are never sent to a shared backend — everything stays
local.

## Cross-project semantic search

When semantic retrieval is enabled (`CURION_SEMANTIC_ENABLED=1`, see
[Configuration](configuration.md)), Curion may semantically search
external **non-private** projects alongside the local project.
**Private projects are never surfaced.**

To mark a project private, create `.curion/config.json` in the project
root:

```json
{ "version": 1, "isPrivate": true }
```

## Storage layout

```
<projectRoot>/.curion/
  curion.sqlite    # SQLite database (gitignored)
```

The database schema is additive and idempotent. **Raw input text is never
persisted** — only controller-normalized summaries and metadata (kind,
confidence, safety flags, timestamps).

## Secrets and `.env` files

Curion does **not** load `.env` files. All configuration — including API
keys — is read from the environment of the parent process (your MCP
client, shell, or process manager). See
[Configuration](configuration.md) for the full list of environment
variables and [MCP client setup](mcp-clients.md) for client-specific
examples of how to pass them.