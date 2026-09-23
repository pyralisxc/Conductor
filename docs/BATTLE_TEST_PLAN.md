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
15. Pending checks/workflows summarize as `external-gate-pending` with no agent action required.
16. Repeating the same head/state observation reports no meaningful transition.
17. A `seal-b` candidate can distinguish expected pre-seal `action-smoke` failure from source `verify` failure.
18. A bot-pushed sealed head with `action_required` reports exact-head verification required.
19. Settled technical gates report `promotion-ready` without inferring Main approval.
20. Integration merge rejects the repository default branch as target.
21. Integration merge rejects unapproved source branch classes.
22. Duplicate mutation attempts replay the durable idempotent receipt instead of repeating the side effect.

## Current runtime — release and reconciliation

23. Main promotion requires an exact head SHA, exact base SHA, repository-default target, and explicit owner approval reference.
24. Stale promotion identity fails closed.
25. Conductor cannot infer or bypass Main approval.
26. Normal promotion uses a merge commit, so the exact approved Preview head becomes Main ancestry without a return PR; squash/rebase promotion fails closed.
27. Preview reconciliation rejects non-default sources and non-Preview targets.
28. Preview reconciliation always uses a merge commit so accepted ancestry is preserved.
29. A subsequent work branch starts from Preview directly after normal promotion. Main-only changes use the exact reconciliation lane before ordinary Preview work resumes.

## Current runtime — reliability and security

30. Restarting the hosted runtime does not lose durable mutation idempotency when Redis is configured.
31. Expired GitHub App installation credentials are reminted through the credential provider.
32. GitHub/provider failure leaves provider-native repository state authoritative.
33. Production-only secrets are not required by ordinary Preview development.
34. A self-hosted/local runner does not execute untrusted public code by default.
35. Every consequential merge receipt retains the resulting merge commit SHA and relevant approval/reconciliation evidence.

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
