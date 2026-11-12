# Decision retrieval and provenance

## Current status

No accepted architecture decision records are indexed in the `main`
baseline at the time of this consolidation. This page is a retrieval guide,
**not** an invented list of historical approvals.

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
