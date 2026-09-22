# Battle Test Plan

Use Conductor itself for the first dogfood pass, then CardForge as the first cross-project canary.

This document tests the **current bounded runtime**. Future automation experiments are listed separately and are not current commitments or backlog items.

## Current runtime — identity and preflight

1. GitHub App repository discovery resolves only allowed owners.
2. Operation-aware preflight first rejects operations that are not exposed by the configured runtime.
3. GitHub App operation preflight proves the exact permissions used by execution; static-token fallback is reported as degraded where operation-specific proof is unavailable.
4. Development Intelligence outage is explicit and fails the required preflight lane closed.
5. OAuth read tokens cannot call mutation tools; write scope is explicit.

## Current runtime — durable work

6. A GitHub Issue is created as a provider-native Conductor work item.
7. Lifecycle status round-trips across backlog, ready, in-progress, blocked, review, and done.
8. Kind and origin classification preserve unrelated labels.
9. Missing or conflicting classification remains `unknown` rather than guessed.
10. Pull requests are excluded from issue-backed work-item lists.

## Current runtime — bounded development

11. A work branch starts from an exact Preview SHA.
12. A bounded commit advances only the expected work-branch head.
13. A pull request may target the project's explicit integration branch.
14. PR status reports exact head/base identity plus checks and workflow runs.
15. Integration merge rejects the repository default branch as target.
16. Integration merge rejects unapproved source branch classes.
17. Duplicate mutation attempts replay the durable idempotent receipt instead of repeating the side effect.

## Current runtime — release and reconciliation

18. Main promotion requires an exact head SHA, exact base SHA, repository-default target, and explicit owner approval reference.
19. Stale promotion identity fails closed.
20. Conductor cannot infer or bypass Main approval.
21. After accepted promotion, the repository default branch can reconcile into `preview`/`vercel-preview` only through the exact reconciliation lane.
22. Preview reconciliation rejects non-default sources and non-Preview targets.
23. Preview reconciliation always uses a merge commit so accepted ancestry is preserved.
24. A subsequent work branch can start from the reconciled Preview lineage.

## Current runtime — reliability and security

25. Restarting the hosted runtime does not lose durable mutation idempotency when Redis is configured.
26. Expired GitHub App installation credentials are reminted through the credential provider.
27. GitHub/provider failure leaves provider-native repository state authoritative.
28. Production-only secrets are not required by ordinary Preview development.
29. A self-hosted/local runner does not execute untrusted public code by default.
30. Every consequential merge receipt retains the resulting merge commit SHA and relevant approval/reconciliation evidence.

## Deferred experiments — not current product commitments

Do **not** treat the following as required Conductor behavior until repeated human-directed use demonstrates a deterministic need:

- automatic task selection or backlog scheduling;
- autonomous worker assignment or reassignment;
- warm-session continuation machinery;
- unattended repair loops;
- webhook-driven mutation;
- pause-all-automation control planes;
- owner dashboards for fleets of simultaneous workers;
- local/offline worker queues.

When one of these becomes justified, create a real work item with current evidence and acceptance criteria before changing the architecture.

## Acceptance

The current canary succeeds when human-directed development becomes easier to reconstruct and execute without weakening exact authorization, provider truth, idempotency, or the Main human gate.
