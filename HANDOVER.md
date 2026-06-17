# Curion Session Handover

> Human-readable companion to the 16 curion memory records saved this session.
> Source of truth for resuming the Curion rename work without re-reading the
> 8 archived session transcripts (~73,879 lines).
>
> Last updated: 2026-06-16, end of session 9 (the rename session).

---

## 1. Session Header

**Date:** 2026-06-16
**User:** geanatz
**Project:** Curion (renamed this session from `cortex-mcp-v2`)
**Session goal:** Rename `cortex-mcp-v2` to `Curion`, move old project aside, populate the new Curion memory store with high-signal information from the 8 archived sessions, and continue improving the memory MCP.

**What was completed this session:**
- Old `cortex-mcp` moved to `/home/geanatz/Repos/other/cortex-mcp-old` (worker executed the `mv`).
- Full repo rename: directory, package metadata, source tree, tests, benchmark, opencode config, env, tsconfig, gitignore.
- `.cortex/` storage migrated to `.curion/` preserving 45 KB of real memories.
- `dist/` rebuilt clean (`tsc`, 2455-byte `dist/index.js`, fresh mtime).
- 16 high-signal memory records written to the curion DB via direct JSON-RPC.

**Workspace state at session start:**
- Repo at `/home/geanatz/Repos/cortex-mcp-v2`, `main` at `fcd1c9f`, `v0.1.0` tag.
- Storage at `/home/geanatz/Repos/cortex-mcp-v2/.cortex/cortex.sqlite`.
- 8 archived session transcripts in `.archive/sessions/`.
- 1315 pass / 0 fail / 12 skipped tests, all clean.

**Workspace state at session end:**
- Repo at `/home/geanatz/Repos/curion`, `main` still at `fcd1c9f`, `v0.1.0` tag still attached.
- Storage at `/home/geanatz/Repos/curion/.curion/curion.sqlite` with 16 handover records + 5 pre-existing exploratory records.
- `dist/` rebuilt clean, no production wiring of dense/vector/hybrid retrieval (unchanged from session 8).
- ~100 uncommitted modifications spanning the rename; nothing committed yet.
- `docs/` still present (deletion deferred until memory is confirmed working).

---

## 2. Project Identity (post-rename)

**Stack:**
- TypeScript
- Node 22
- MCP SDK 1.29.x
- zod 3.25.x
- better-sqlite3 12.x

**Public API (frozen):**
- Exactly two tools: `remember(text)` and `recall(text)`
- Each tool takes a single `text` parameter
- 5-status structuredContent returned per tool (no `message` field)
- No `memoryId` / `sourceIds` / `memoryIds` on the wire (field-level, not content-level: no id-bearing field exists on any status variant; `weak_match.summaries` is `string[]`, `weak_match.coverage` has no id fields; curator summary prose is not sanitized — if a future curator wrote `#N` into a summary, it would surface on both `answered` and `weak_match`, same write-path source)
- The `answered.answer` field is content-sanitized to remove any memory-id references the synthesis LLM may echo from its prompt format (e.g. "Memory #N", "entry #N", bare "#N"). The `weak_match.summaries` field is NOT sanitized — it carries curator-voice prose verbatim, by design.
- No `Note:` prefix in public text
- Plain string notes only
- Strict Zod input rejects unknown keys

**Metaphor:** The hidden librarian. Curion is a quiet, project-local memory layer for AI agents — it remembers things you ask it to and recalls them on demand, but otherwise stays out of the way.

**Path:** `/home/geanatz/Repos/curion`

**Project-local storage:** `/home/geanatz/Repos/curion/.curion/curion.sqlite`
> NOTE: This is the project-local store. The global store at
> `~/.config/opencode/.cortex/` is **orphan** (legacy from before the rename)
> and should not be confused with the active storage.

---

## 3. Background: What Happened Before This Session

**Archive:** 8 session transcripts totalling ~73,879 lines, located at
`/home/geanatz/Repos/curion/.archive/sessions/session_1.md` through
`session_8.md`. Span: 2026-06-11 to 2026-06-16.

**Session-by-session summary (one line each):**

| # | Date | One-line summary |
|---|------|------------------|
| 1 | 2026-06-11 | Initial build of cortex-mcp-v2: schema, tools, safety, basic store. |
| 2 | 2026-06-11 | Hardening pass: input validation, error envelopes, log structure. |
| 3 | 2026-06-12 | Branch-per-experiment discipline introduced; recall pipeline split. |
| 4 | 2026-06-13 | Phase F: resolved-history semantics; safety classes formalized (8 classes). |
| 5 | 2026-06-13 | Conflict / currentness metadata; composition rule. |
| 6 | 2026-06-14 | Test suite scaling: e2e + contract suites; 1315 tests passing. |
| 7 | 2026-06-15 | Embeddings prototype work (research-only path). |
| 8 | 2026-06-16 | v0.1.0 tag, final cleanup, ~70-80% production readiness declared. |

**Final state at end of session 8:**
- `main` at commit `fcd1c9f`
- `v0.1.0` tag (real and immutable)
- 1315 pass / 0 fail / 12 skipped tests
- No production wiring of dense / vector / hybrid retrieval — those paths
  remain research-only

---

## 4. Session Goals (verbatim from the user)

The user's four goals for this session:

1. **Rename** `cortex-mcp-v2` to `Curion` (the `cortex` name is taken, drop the `v2`).
2. **Move** the old `cortex-mcp` to `/home/geanatz/Repos/other/cortex-mcp-old`.
3. **Populate memory** with useful information from all 8 sessions, one session at a time, with confirmation after each.
4. **Continue improving** the memory MCP: more reliable, more efficient, normalize and consolidate.

**User decisions on scope (early session):**
- Full rename: `package.json`, `bin`, all docs, internal references, AND move `.cortex/` to `.curion/`.
- Name chosen by user: **Curion**.
- Old project moved via `mv` (Worker executed the move).
- One session at a time for memory population, with confirmation after each.

**User decisions on rename details (from clarifying questions):**
- **MCP server key stays `memory`** in `opencode.json` — no tool name changes.
- **Repo directory renamed to `curion`** (not kept as `cortex-mcp-v2`).
- **Migrate `.cortex/` to `.curion/`**, preserving the 45 KB of real memories (do not start fresh).
- **DELETE the `docs/` folder entirely** — user said docs are not needed; everything useful goes to memory.
- **Skip the docs rename phase**; delete instead.

---

## 5. Phases Completed in This Session

### Phase 0 — Pre-work (old project move)
- Worker executed `mv /home/geanatz/Repos/cortex-mcp /home/geanatz/Repos/other/cortex-mcp-old`.
- Verified the old path no longer exists.
- Verified `other/` contains only `cortex-mcp-old/` afterwards.

### Phase A — Filesystem moves
- Repo directory: `cortex-mcp-v2` → `curion`.
- Storage directory: `.cortex` → `.curion`.
- SQLite file: `cortex.sqlite` → `curion.sqlite`.
- WAL / SHM files renamed alongside the main DB file.

### Phase B — `package.json` update
- `name`: `cortex-mcp-v2` → `curion`.
- `bin.curion` (single binary entry).
- `description`: "Curion — project-local memory layer for AI agents".
- Verified `npm run` scripts still resolve correctly.

### Phase C — `src/` rename
- 13 files touched: 95 insertions / 95 deletions.
- All `CORTEX_*` environment variables → `CURION_*`.
- Log tags updated.
- Storage constants updated.
- Server name updated.
- Safety regex retrained to match `Curion` only (no legacy `cortex` alias).
- Prototype fixtures and runner updated.
- `src/benchmark/` left for Phase G (separate rename pass).

### Phase D — `tests/` rename
- 42 files touched: 281 insertions / 281 deletions.
- `mkdtempSync` prefixes updated.
- Env var expectations updated.
- Log assertions updated.
- Safety fixture strings updated.
- MCP client identity updated.

### Phase E — `opencode.json` update
- `mcp.memory.command` path → `/home/geanatz/Repos/curion/dist/index.js`.
- Env var `CORTEX_LOG_LEVEL` → `CURION_LOG_LEVEL`.
- Server key stayed `memory` (per user decision).
- Verified the curion MCP server is reachable at PID 892856 via the `memory` MCP key.

### Phase F — Env / gitignore / tsconfig
- 4 files touched.
- `.env` and `.env.example`: env var prefixes updated to `CURION_*`.
- `.gitignore`: `.cortex` → `.curion`.
- `tsconfig.json`: exclude `**/.cortex` → `**/.curion`.

### Phase G — `src/benchmark/` rename
- 31 files touched: 128 insertions / 128 deletions.
- Report headers updated.
- CLI banners updated.
- `outDir` paths updated.
- Corpus / queries fixture text updated.
- Log tags updated.
- Env vars updated.
- Package name `@cortex-mcp/sdk` → `@curion/sdk` in benchmark corpus.
- Tag references in record 4 of benchmark output updated.

### Phase H — `dist/` rebuild
- Clean `tsc` build.
- 2455-byte `dist/index.js`, fresh mtime 2026-06-16 18:35.
- Runtime data at `.curion/` untouched during build.

### Residual risks after these phases
- Full test suite not re-run after the rename (verification deferred).
- Independent review of the rename diff not yet done.
- ~100 uncommitted modifications accumulating across all phases.

---

## 6. The Blocker That Hit During Docs Deletion

The plan was straightforward: delete `docs/` and save the useful content into
curion memory.

**Blocker:** The `memory_remember` tool was **not** in the assistant's tool
list for this session. Curion was the thing being renamed, and opencode had
not yet re-registered the renamed server.

**Workaround used:**
- Direct JSON-RPC over stdio to the curion MCP server (verified working
  before any writes).
- A parallel agent was launched to manage the 16 memory writes out-of-band,
  since the main session could not invoke `memory_remember` directly.

**Outcome:**
- 16 high-signal records written successfully to the curion DB.
- 5 pre-existing exploratory records (from session exploration earlier) remain
  in the DB and are now joined by the 16 curated handover records.
- 2 stray probe rows (from path-testing during the JSON-RPC bring-up) are
  also present — known noise, not removed.

---

## 7. The 16 Memory Records

Saved to the curion memory store this session. Topic index — use
`memory_recall` to retrieve any one of them by topic.

1. **Project identity post-rename** — stack, path, storage location, public API summary.
2. **Active branch and uncommitted state** — current branch, status, scope of pending changes.
3. **Public API contract (frozen)** — exact tool signatures, response shape, validation behavior.
4. **OpenCode MCP integration (CRITICAL — read before calling `memory_remember`)** — server key, command path, env vars, known gotchas.
5. **Phase A–J conflict / currentness status** — which phases are merged, which are research-only, currentness across experiments.
6. **Composition rule and 8 safety classes** — how records compose and which safety classes govern each.
7. **Branch-per-experiment discipline** — the working agreement for branching.
8. **Source-tree import-guard pattern** — convention for guarding internal imports.
9. **Production recall = lexical-only; vector / hybrid research-only** — explicit split.
10. **v0.1.0 tag and 70–80% production readiness** — milestone and current readiness.
11. **Workspace conventions** — paths, naming, workdir expectations, etc.
12. **Test counts and current pipeline state** — 1315 / 0 / 12 breakdown, where each suite runs.
13. **Archive of past sessions (deep reference)** — pointers into the 8 transcripts.
14. **Orphaned cortex-mcp-v2 processes (cleanup needed)** — PIDs 128718 and 185965 holding stale WAL.
15. **Deferred / open questions** — items pushed forward to a future session.
16. **How to use curion memory + session handoff procedure** — operational guide.

---

## 8. Decisions Made (with reasoning)

| Decision | Reasoning |
|----------|-----------|
| Name: **Curion** | Curator + intelligent system. Hidden librarian metaphor fits a quiet project-local memory layer. User chose it. |
| MCP server key stays `memory` | User decision. Avoids breaking opencode tool bindings; no caller needs updating. |
| Repo dir renamed to `curion` | User decision. Avoids the `v2` suffix and matches the new identity. |
| `.cortex/` migrated to `.curion/` (not fresh start) | User decision. Preserves 45 KB of real memories; safer than rebuilding. |
| Full rename scope (storage path included) | User decision. Avoids the dual-identity hazard of renaming code but leaving storage under the old name. |
| Safety regex retrained to `Curion` only (no legacy `cortex` alias) | Avoids false matches against the orphan project name. The legacy alias would create confusion. |
| Package name `@cortex-mcp/sdk` → `@curion/sdk` in benchmark corpus | Consistency with the rest of the rename. Benchmark fixture text is the only place that name appears. |
| **DELETE `docs/` entirely** | User directive. User said docs are not needed; everything useful goes to memory. |
| Skip the docs rename phase; delete later | User decision. Avoids spending cycles renaming files that will be deleted anyway. |
| Use direct JSON-RPC for memory writes when `memory_remember` is unavailable | The fallback path. Curion cannot depend on itself for setup. |
| Save **16 high-signal records** (not 8 sessions verbatim) | 73K lines of session transcript is low-signal noise; the curated handover captures the decisions and durable facts. |
| The 5 pre-existing memory records stay | They are exploratory but accurate; removing them would be scope creep. |
| The 2 stray probe rows stay | Known noise from JSON-RPC path testing; not worth a separate write to remove. |

---

## 9. Risks and Open Items

- **~100 uncommitted modifications on `main`** — spans the entire rename plus the 4 deleted docs. This is a large diff and should be reviewed before commit.
- **2 orphan `cortex-mcp-v2` processes** (PIDs 128718, 185965) are still alive and holding stale WAL. Cleanup is user-owned: `kill` them when convenient. Verify with `pgrep -fa cortex-mcp-v2` first.
- **OpenCode config changes uncommitted** — the `command` path and the env var rename in `opencode.json` are part of the pending diff.
- **`docs/` folder not yet deleted** — deferred until the memory store is confirmed working. 4 files to delete: `architecture.md`, `conflict-currentness-metadata.md`, `env.md`, `resolved-history-semantics-phase-f.md`.
- **Tests not yet run after the rename** — Phases D, G, and H changed behavior-affecting strings and rebuilt the artifact, but the full suite has not been re-run. Verification deferred.
- **Independent review of the rename commit not yet done** — Reviewer agent has not yet seen the diff.
- **Branch consolidation not done** — no new branch has been cut for the rename work; everything is still on `main` as uncommitted modifications.
- **Push to `origin` not done** — and should not be done without explicit user approval.
- **LICENSE file still missing** — was not in scope this session; optionally create later.
- **`v0.1.0` tag is real and immutable** — any hotfix would need `v0.1.1`.

---

## 10. What's Next

Ordered remaining work for the next session:

1. **(User-parallel, first)** Confirm the 16 memory records were written successfully. The parallel agent that wrote them should verify each by recalling its topic.
2. **Run the test suite from `/home/geanatz/Repos/curion`:**
   - `npm test`
   - `npm run test:e2e`
   - `npm run test:contracts`
   Verify the rename did not break anything. If anything fails, isolate whether it is rename-related or pre-existing.
3. **If tests pass: dispatch Reviewer** to independently verify the uncommitted rename diff. The diff is large (~100 files) and warrants a second pair of eyes.
4. **If Reviewer accepts: commit on a new branch** `experiment/rename-curion` from `main`. Do **not** push, do **not** retag `v0.1.0`.
5. **Delete the `docs/` folder** — 4 files: `architecture.md`, `conflict-currentness-metadata.md`, `env.md`, `resolved-history-semantics-phase-f.md`.
6. **Clean orphan doc-comment cross-references** in `src/` (8 sites), `tests/_helpers/resolved-history-validation-scenarios.ts` (1 site), and `README.md` (3 sites). These point to paths that will not exist after `docs/` deletion.
7. **Update `README.md`** (the public-facing one):
   - Drop the `docs/` tree entry.
   - Drop the `CORTEX_LOG_LEVEL` references.
   - Update the env var table.
   - Update the project name headline.
8. **Populate memory from the 8 archived sessions**, one session at a time, with user confirmation after each (the original plan). The 16 records saved the high-signal decisions; the 8 session sweeps will save per-session detail.
9. **Continue improving Curion** — reliability, efficiency, normalize, consolidate (the user's third goal).
10. **Branch consolidation** when the time comes (eventually fold `experiment/rename-curion` back into `main` after the user signs off).
11. **(Optional)** Push to `origin` after user explicitly approves.
12. **(Optional)** Create `LICENSE` file.

---

## 11. Hard-Won Lessons / Conventions (carry forward)

- **Always use absolute paths** or `workdir=/home/geanatz` in `bash` after renaming a repo. Relative paths break silently when the working directory changes.
- **Sequential shell commands only.** The user's PC crashes on parallel shell invocations. Chain with `&&` or run them in separate tool calls but never in parallel within a single `bash` call.
- **`set -a && source .env && set +a`** before invoking the curion MCP via stdio. The provider needs API keys and they are not in the shell environment by default.
- **Direct JSON-RPC is the fallback** when `memory_remember` is missing from the tool list. Curion cannot depend on itself for setup.
- **The 5 base memory records in the DB are exploratory; the 16 handover records are the curated base.** Treat the curated set as authoritative; the exploratory set is context.
- **Permission denies in `opencode.json` are not enforced for the explorer role.** Plan around that.
- **The curion MCP server (PID 892856) is alive and reachable** via the `memory` MCP key. After a rename that touches `opencode.json`, restart the opencode client to pick up the new command path.
- **Use `workdir`, not `cd`.** The `bash` tool notes this explicitly. `cd /foo && cmd` is a smell.
- **Read before edit.** The `edit` tool requires a prior `read` on the file in the same session.
- **Never write to a file outside the approved scope.** This session wrote only to `/home/geanatz/Repos/curion/.curion/HANDOVER.md`.

---

## 12. Pointers to the Deep Reference

- **8 session transcripts** — `/home/geanatz/Repos/curion/.archive/sessions/session_1.md` through `session_8.md` (~73,879 lines total).
- **16 memory records** — call `memory_recall` with the topic from section 7 above.
- **Curion source** — `/home/geanatz/Repos/curion/src/` (production code) and `/home/geanatz/Repos/curion/src/benchmark/` (benchmark + research path).
- **Test suite** — `/home/geanatz/Repos/curion/tests/`.
- **Original v1 project** (historical, untouched) — `/home/geanatz/Repos/other/cortex-mcp-old/`.
- **Build artifact** — `/home/geanatz/Repos/curion/dist/index.js` (2455 bytes, fresh mtime 2026-06-16 18:35).
- **Project-local storage** — `/home/geanatz/Repos/curion/.curion/curion.sqlite` (+ `-shm`, `-wal`).
- **Orphan global storage** — `~/.config/opencode/.cortex/` (do not use; legacy from before the rename).
- **OpenCode config** — `~/.config/opencode/opencode.json` (path + env var changed this session, uncommitted).

---

## End of Handover

If the next session needs only one thing from this document, it is the
ordered list in **Section 10**. If it needs only one durable fact, it is the
project identity summary in **Section 2**. If it needs the rationale behind
a decision, **Section 8** has it.
