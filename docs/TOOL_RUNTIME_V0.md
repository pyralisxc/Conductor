# Conductor Tool Runtime v0

## Outcome

Give every development client one stable, truthful execution contract before Conductor expands into advanced orchestration, delegation, or session machinery.

## Public tools

v0 always exposes the core non-mutating runtime tools:

- `capabilities()` reports the runtime operations, configured provider capabilities, access level, authentication state, and health actually available now.
- `preflight_project(project, intent)` remains a repository-development convenience that verifies the surfaces required for `inspect`, `develop` (default), or `execute`.
- `preflight_operation(project, operation)` is exposed when at least one configured provider can supply operation-level evidence. It verifies whether one exact exposed Conductor operation can execute against the supplied routing referent, aggregates only responsible providers, and never infers which operation the project needs.
- `development.status(project, limit?)` reconstructs compact inspect-time preflight plus ready/in-progress/blocked/review work. Each active work item includes same-repository PR candidates discovered through native issue timeline cross-references and reuses exact PR check/workflow truth. It never ranks or selects work.
- `pull-request.status(project, pullRequestNumber, previous?)` is exposed when a GitHub PR provider is configured and returns exact head/base identity plus labels, check/workflow truth and a derived orchestration state. A caller may supply its prior head/state observation to detect meaningful transitions without Conductor storing PR history.
- `deployment.status(project, limit?)` is exposed when a deployment read provider is configured and returns provider-native current production, latest production attempt, recent deployments, source revision/ref where available, and deployment domains.
- `deployment.logs(project, deploymentId, limit?)` reads one exact deployment's bounded/redacted event output. Provider event retention/coverage remains explicit and is not treated as a complete runtime archive.
- `work-item.status(project, issueNumber)` reads one durable work item with normalized lifecycle status, kind, and origin.
- `work-item.list(project, ...)` lists issue-backed work and can filter by normalized status, kind, and origin. Pull requests are excluded.

When explicitly enabled with durable Redis idempotency state, the current source-control mutation family exposes bounded GitHub mutations:

- `git.branch.create` creates only `work/*` branches from an exact SHA.
- `git.commit.create` creates a bounded file commit, supports tracked-path deletion with null content, and advances a `work/*` branch only from an expected head SHA.
- `pull-request.create` opens `work/*` pull requests against an explicit target branch. Opening a proposal does not authorize or perform merge/promotion; consequential acceptance remains a separate operation and gate.
- `pull-request.comment.create` adds an idempotent pull-request comment.
- `pull-request.labels.update` adds/removes labels while preserving unrelated labels.
- `pull-request.merge.integration` merges only an exact head/base candidate from a bounded work/repair/audit/release source into a non-accepted integration branch.
- `pull-request.merge.reconcile-preview` merges only an exact repository-default-branch candidate into `preview` or `vercel-preview`, always using a merge commit for exceptional Main-only content changes.
- `pull-request.merge.promote` merges only an exact `preview`/`vercel-preview` head/base candidate into the repository default branch with a merge commit and requires a non-empty owner approval reference. Normal promotion preserves Preview ancestry without a return PR.
- `work-item.create` creates durable issue-backed work with optional normalized status, kind, and origin.
- `work-scope.identity` identifies the connected OAuth client for the owner-managed work-scope page when server enforcement is configured. It does not mutate scope.
- `work-item.update-status` changes only lifecycle status; `done` closes the backing issue and active statuses reopen it.
- `work-item.classification.update` changes kind and/or origin without changing lifecycle status. `unknown` clears that classification.

The initial work-item vocabulary is deliberately small:

- status: `backlog`, `ready`, `in-progress`, `blocked`, `review`, `done`;
- kind: `bug`, `feature`, `investigation`, `improvement`, `maintenance`, `operations`;
- origin: `human`, `agent-audit`, `di-finding`, `ci`, `runtime`, `dependency`, `user-feedback`.

Missing or conflicting classification is reported as `unknown`; Conductor does not guess. GitHub encodes these dimensions as reserved `status:*`, `kind:*`, and `origin:*` labels while preserving unrelated native labels. Automation eligibility is intentionally not a work-item field.

No generic “do anything” tool exists.

## Contract

Every call returns a versioned execution receipt with:

- operation ID and operation name
- explicit target
- success or normalized failure
- start and finish timestamps
- diagnostics
- commit, branch, pull request, issue, comment, or workflow identifiers when relevant
- idempotency metadata for mutations

Normalized failures are:

- `AUTH_REQUIRED`
- `PERMISSION_DENIED`
- `TRANSIENT`
- `NOT_FOUND`
- `CONFLICT`
- `TOOL_UNAVAILABLE`
- `COMMAND_FAILED`

Provider exceptions do not escape as ambiguous client failures.

## Architecture

`ConductorToolRuntime` owns the stable facade and receipt boundary.

Provider adapters report real capability and preflight evidence. They do not change the runtime contract. Provider-neutrality is organized by semantic capability family rather than a generic provider read/write/execute interface: source-control mutation, work-item mutation, intelligence/preflight, deployment read, and future database/artifact/local-execution families may evolve independently. Vercel is the first deployment-read implementation; it does not implement source-control mutation semantics. Development Intelligence may implement only read/query capabilities. Project/repository identifiers entering the runtime are execution-routing referents supplied by callers; Conductor does not expand them into a project model.

Operation preflight is evidence aggregation, not planning. An operation must first be exposed by the configured runtime. Responsible providers then prove or qualify the exact capability/permission lane they own. GitHub App evidence is operation-specific; static-token repository-role evidence remains degraded because it cannot prove fine-grained operation permissions.

The compact development-status projection is rebuilt on demand from provider-native work, native issue↔PR cross-references, PR/check state, and inspect preflight. Pull-request orchestration state is likewise derived on demand from exact provider truth. Waiting states explicitly distinguish `shouldAct=false` external gates from caller-action states, and optional prior observations make unchanged polling detectable without a Conductor PR-state database. These projections are not persisted as another project ledger and do not claim to describe product or technical architecture.

Every mutation claims an idempotency key and payload fingerprint before performing external work. A matching retry replays the original receipt; a different payload using the same key fails with `CONFLICT`.

The included in-memory idempotency store is suitable for tests and one-process development only. A deployed mutation runtime must supply a durable atomic store before exposing mutation tools.

## Intentionally absent

- generic shell or arbitrary provider dispatch
- arbitrary push, force-push, unbounded merge, or repository-admin tools
- inferred or unattended default-branch promotion; promotion requires an exact candidate plus explicit owner approval context
- arbitrary branch reconciliation or force-updating Preview; exceptional Main-only reconciliation is limited to exact default-branch → Preview ancestry
- multi-agent workers or handoffs
- scheduling and durable waits
- session management
- arbitrary deployment mutation (`deploy`, `retry`, `promote`, `rollback`) in the read-only Vercel tranche
- a provider-specific orchestration transport beyond the thin authenticated MCP adapter
- a second source of project intelligence

Transports adapt this contract. They do not own it.

The first transport is documented in `docs/MCP_RUNTIME.md`. It exposes the configured runtime tools over authenticated Streamable HTTP without adding runtime semantics.

## Acceptance

- A fresh runtime instance can enumerate its exact public tools and configured environment capabilities.
- Development status groups active durable work without choosing it, and carries native PR/check evidence when a candidate exists.
- Project preflight returns every check required by the selected repository-development intent, including explicit unavailable or blocked results.
- Operation preflight fails closed for unexposed operations and reports exact provider-specific readiness/degradation for exposed operations.
- Pull-request status distinguishes external-gate waiting, expected pre-seal checkpoint mismatch, sealed-head verification requirements, real verification failure, and technical promotion readiness without inferring authorization.
- Repeating a prior observation with the same head and orchestration state reports no meaningful transition.
- Provider failures are normalized and visible.
- A configured deployment provider can distinguish the currently served production deployment from a newer failed production attempt and can return bounded/redacted exact-deployment logs without persisting provider state.
- Receipts are stable and carry provider identifiers, including merge commit SHA when a merge succeeds.
- Exceptional Main-only reconciliation accepts only the exact default branch → Preview lane and preserves ancestry with a merge commit.
- Retrying the same mutation cannot repeat its side effect through the idempotency executor.
- Existing orchestration policy and tests remain intact.
