# Decision retrieval and provenance

## Accepted scope-limited decisions

- [2026-11-12: maintenance and consolidation](2026-11-12-maintenance.md)
  — historical maintenance-only approval, superseded for the specific 0.3.7
  release where stated in the later record.
- [2026-11-13: release, Windows privacy and manual publishing](2026-11-13-release.md)
  — verified 0.3.7 decisions, evidence and remaining approval boundaries.

These records describe **owner-approved scope**, not permission to activate
experimental work, change existing user data, spend provider API credits, or
publish another version without specific approval. Current source and CI still
need independent verification.

## When reviewing a technical decision

1. Start with [project direction](../direction.md) and the linked product
   reference documentation.
2. Look for a specific, verifiable decision and its approval source before
   asserting that a behavior or change has been accepted.
3. Separate the intended contract, observed implementation, and test evidence.
   A passing benchmark does not authorize activation or deployment.
4. If approval is not recorded or cannot be verified, identify the decision as
   unresolved; do not silently promote a proposal to an accepted decision.
5. When an owner explicitly approves a new consequential choice, record its
   scope, rationale, evidence/source, date when known, and any superseded choice.

Experiments, drafts, historical handoffs, uncommitted documents, and pull
requests should remain clearly labeled as such. No formal record is required
merely to continue safe maintenance work.
