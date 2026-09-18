# Battle Test Plan

Use CardForge as the first complete canary.

## Core flow

1. Create work from conversational development.
2. Work branch starts from latest Preview.
3. Successful work PR integrates to Preview.
4. Stable Preview deployment updates.
5. Preview manifest explains the delta from main.

## Concurrency / integration

6. Two unrelated workers integrate safely.
7. Meaningful overlap is detected.
8. Technical merge conflict is repaired without founder interruption.
9. Semantic conflict becomes Needs Founder.
10. Main hotfix reconciles back into Preview.

## Audit

11. Proven audit defect creates repair work automatically.
12. Proven repair reaches Preview after appropriate proof.
13. Product-semantic audit finding does not auto-mutate.
14. Insufficient evidence remains Proposed.
15. Consequential finding creates a human gate.

## Sessions

16. Warm conversational session receives repeated continuation turns.
17. Delegated worker returns evidence to the correct parent session.
18. CI waiting consumes no active model reasoning.
19. Deployment waiting consumes no active model reasoning.
20. Chat continuation failure falls back without losing work.
21. Session rotation preserves Objective, Ambition, accepted meaning, authorization, and frontier.
22. Fresh-eyes request deliberately creates independent context.

## Preview / release

23. Broken Preview integration is repaired or reverted.
24. Release candidate freezes exact SHA while Preview keeps advancing.
25. Owner rejects one candidate component without losing unrelated work.
26. Exact approved release SHA reaches main.
27. Conductor cannot bypass main approval.
28. Preview reconciles to new main after release.

## Reliability

29. Duplicate webhook creates no duplicate work.
30. Expired GitHub App installation token recovers.
31. Workflow runtime restart does not lose work.
32. Provider outage preserves GitHub work authority.
33. DI outage produces explicit degraded mode.
34. Offline Unity runner queues work rather than rerouting incorrectly.

## Owner control

35. Pause Project Automation reaches safe suspension.
36. Pause All Automation prevents new mutating work.
37. Owner can change Evidence Appetite while work is active.
38. Owner can hold Preview integration while allowing development to continue.
39. Owner can reassign work from autonomous worker back to conversational session.
40. Every automated integration can explain why it occurred and what authorized it.

## Secrets

41. Preview worker cannot read production-only secrets.
42. Local runner does not accept untrusted public code by default.

## Acceptance

The canary succeeds when developer coordination burden decreases without increasing founder-rescue, hidden-quality failures, or unexplainable automation.
