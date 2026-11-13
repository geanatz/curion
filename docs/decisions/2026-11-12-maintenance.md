# Curion maintenance and consolidation decisions — 2026-11-12

**Status:** Accepted for the maintenance/consolidation scope.
**Authority:** Explicit project-owner decisions in the 2026-11-12 Curion
planning and execution conversation. The original conversation is the
approval source; this note is a repository-level summary, not an ADR
authorizing unrelated feature or release changes.

## Decisions

1. Focus on **maintenance and consolidation**, not new product features.
2. Integrate only valuable and verified changes from existing branches;
   do not merge the experimental adaptive-recall PR wholesale.
3. Audit tests comprehensively but optimize **pragmatically**: address
   meaningful gaps, flakiness, duplication, and execution cost.
4. Reduce redundant worktrees only after preserving uncommitted work,
   distinct commits, and relevant agent reports.
5. Target a stable, tested, documented `main`; **do not publish npm**.
6. Prefer deterministic tests and isolated MCP end-to-end checks. A limited
   real-provider smoke test may be useful **only with separate explicit
   approval for credentials and cost**, using synthetic data and temporary
   stores.
7. Justified breaking changes may be considered where benefits outweigh
   compatibility costs; they are not automatically approved per change.
8. If a change requires a SQLite schema migration, preserve existing data
   with a **tested automatic migration**, without touching live stores.

## Execution boundaries

The owner separately authorized specific local commits, local `main`
reconciliation, four verified worktree removals, and a push of two
maintenance commits. These authorizations were specific to their stated
operations and must not be treated as standing permission for future
pushes, merges, deletions, deployments, or migrations.

## Not authorized by these decisions

- Activating the Memory Decision Engine, adaptive recall experiments,
  or other experimental functionality.
- Merging PR #1, releasing a new npm version, applying migrations to
  actual `.curion/` data, or incurring real-provider API costs.

This is a **historical, scope-limited** decision. The 2026-11-13 owner
authorizations for the 0.3.7 release superseded its earlier "no npm publish"
boundary for that specific release; see
[2026-11-13 release decisions](2026-11-13-release.md). The full dated
maintenance evidence is preserved in the prior ChatGPT Library Session Report
(`curion_2026-11-12_maintenance_session_report.md`).
