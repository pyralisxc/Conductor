# Battle Test Plan

Use Conductor itself for the first dogfood pass, then a second repository such as Development Intelligence or CardForge for cross-project proof.

This document tests the **current bounded runtime**. Future automation experiments are listed separately and are not current commitments or backlog items.

## Current runtime — identity, publication, and preflight

1. GitHub App repository discovery resolves only allowed owners.
2. A fresh development client can establish one exact active repository with `work-scope.begin`; the returned context is client-bound and time-bounded.
3. Code or deployment writes outside the active repository fail closed unless an exact temporary owner grant exists.
4. Operation-aware preflight first rejects operations that are not exposed by the configured runtime.
5. GitHub App operation preflight proves the exact permissions used by execution; static-token fallback is reported as degraded where operation-specific proof is unavailable.
6. Development Intelligence outage is explicit and fails the required preflight lane closed.
7. OAuth read tokens cannot call mutation tools; write scope is explicit.
8. The connected MCP/client schema exposes the operations advertised by the deployed runtime. A stale connector/tool catalog is an acceptance failure, not proof that the runtime operation is absent.

## Current runtime — durable work and routing

9. A GitHub Issue is created as a provider-native Conductor work item.
10. Lifecycle status round-trips across backlog, ready, in-progress, blocked, review, and done.
11. Kind and origin classification preserve unrelated labels.
12. Missing or conflicting classification remains `unknown` rather than guessed.
13. Pull requests are excluded from issue-backed work-item lists.
14. An exact issue in a second provider-accessible repository can receive a routed comment, lifecycle update, and classification change without granting code-work authority there.
15. Replaying the same routed issue comment is idempotent, and issue-comment mutation refuses pull requests.
16. A confirmed duplicate can be linked to its canonical issue before closure; title similarity alone never authorizes closing work.

## Current runtime — bounded development

17. A work branch starts from an exact Preview SHA.
18. Automatic Vercel Git builds are ignored for ordinary work/repair/audit branches; GitHub verification remains the work-branch gate, while exact ad-hoc Vercel canaries are explicitly requested.
19. A bounded commit advances only the expected work-branch head.
20. A pull request may target the project's explicit integration branch.
21. PR status reports exact head/base identity plus checks and workflow runs.
22. Pending checks/workflows summarize as `external-gate-pending` with no agent action required.
23. Repeating the same head/state observation reports no meaningful transition.
24. A `seal-b` candidate can distinguish expected pre-seal `action-smoke` failure from source `verify` failure.
25. A bot-pushed sealed head with `action_required` reports exact-head verification required.
26. Settled technical gates report `promotion-ready` without inferring Main approval.
27. Integration merge rejects the repository default branch as target.
28. Integration merge rejects unapproved source branch classes.
29. Duplicate mutation attempts replay the durable idempotent receipt instead of repeating the side effect.

## Current runtime — Vercel provider boundary

30. A read-only request for an unbound repository may resolve exactly one Git-linked Vercel project through one unambiguous connected installation/team.
31. Ambiguous installation, project, team, pagination, or Git-link evidence fails closed rather than selecting a project heuristically.
32. `deployment.status` distinguishes currently served production from newer attempts and carries provider deployment identity plus source Git revision/ref where available.
33. `deployment.logs` returns bounded/redacted build or deployment-event evidence for one exact deployment.
34. `deployment.audit` returns bounded project/team identity, Git linkage, domains/aliases, custom environments, recent deployments, variable metadata, and only the account posture exposed by supported APIs.
35. `deployment.runtime-logs` proves endpoint access with one exact deployment. Permission denial remains explicit and operation preflight stays degraded rather than claiming readiness.
36. `deployment.redeploy` acts only on one exact bound deployment and idempotent replay does not create a second redeployment.
37. `deployment.git.create` requires an exact linked repository, ref, and full SHA. Preview creation omits a literal `target: "preview"`; production creation requires exact owner approval.
38. `deployment.promote` and `deployment.rollback` require one exact READY bound deployment, exact owner approval, and provider read-after-write reconciliation.
39. `deployment.env.list` returns variable metadata without values.
40. Environment upsert/update/remove operates on one exact bound project and exact key/ID/target; production-scoped changes require exact owner approval.
41. Environment values remain write-only: secret material never appears in receipts, diagnostics, audit output, or recoverable idempotency state.
42. Cross-project Vercel writes require an explicit exact repository/project/installation binding plus the active repository work scope; installation-wide provider reach alone never authorizes mutation.
43. `deployment.delete` removes only one exact terminal bound deployment: current production and active builds are refused, historical production artifacts require exact owner approval, and idempotent replay does not repeat deletion.

## Current runtime — release and reconciliation

44. Main promotion requires an exact head SHA, exact base SHA, repository-default target, and explicit owner approval reference.
45. Stale promotion identity fails closed.
46. Conductor cannot infer or bypass Main approval.
47. Normal promotion uses a merge commit, so the exact approved Preview head becomes Main ancestry without a return PR; squash/rebase promotion fails closed.
48. Preview reconciliation rejects non-default sources and non-Preview targets.
49. Preview reconciliation always uses a merge commit so accepted ancestry is preserved.
50. A subsequent work branch starts from Preview directly after normal promotion. Main-only changes use the exact reconciliation lane before ordinary Preview work resumes.

## Current runtime — reliability and security

51. Restarting the hosted runtime does not lose durable mutation idempotency when Redis is configured.
52. Expired GitHub App installation credentials are reminted through the credential provider.
53. GitHub/Vercel/provider failure leaves provider-native state authoritative.
54. Production-only secrets are not required by ordinary Preview development.
55. A self-hosted/local runner does not execute untrusted public code by default.
56. Every consequential merge or provider-mutation receipt retains the exact resulting provider identity plus relevant approval/reconciliation evidence.
57. Public `/health` exposes only runtime readiness/contract information and can be reconciled to the expected deployed Git revision through provider evidence.

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

The current canary succeeds when a human-directed development flow can be reconstructed and executed from durable provider truth across repository work, Preview verification, deployment diagnosis, bounded mutation, and explicit production gates without weakening authorization, idempotency, secret handling, or the Main human gate.
