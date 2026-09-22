# Conductor Tool Runtime v0

## Outcome

Give every development client one stable, truthful execution contract before Conductor expands into advanced orchestration, delegation, or session machinery.

## Public tools

v0 always exposes the core non-mutating runtime tools:

- `capabilities()` reports the runtime operations, configured provider capabilities, access level, authentication state, and health actually available now.
- `preflight_project(project, intent)` verifies only the surfaces required for `inspect`, `develop` (default), or `execute`.
- `project.status(project, limit?)` reconstructs compact inspect-time preflight plus ready/in-progress/blocked/review work. Each active work item includes same-repository PR candidates discovered through native issue timeline cross-references and reuses exact PR check/workflow truth. It never ranks or selects work.
- `pull-request.status(project, pullRequestNumber)` is exposed when a GitHub PR provider is configured and returns exact head/base identity plus labels, check runs, and workflow runs.
- `work-item.status(project, issueNumber)` reads one durable work item with normalized lifecycle status, kind, and origin.
- `work-item.list(project, ...)` lists issue-backed work and can filter by normalized status, kind, and origin. Pull requests are excluded.

When explicitly enabled with durable Redis idempotency state, it exposes bounded GitHub mutations:

- `git.branch.create` creates only `work/*` branches from an exact SHA.
- `git.commit.create` creates a bounded file commit, supports tracked-path deletion with null content, and advances a `work/*` branch only from an expected head SHA.
- `pull-request.create` opens `work/*` pull requests against an explicit target branch. Opening a proposal does not authorize or perform merge/promotion; consequential acceptance remains a separate operation and gate.
- `pull-request.comment.create` adds an idempotent pull-request comment.
- `pull-request.labels.update` adds/removes labels while preserving unrelated labels.
- `pull-request.merge.integration` merges only an exact head/base candidate from a bounded work/repair/audit/release source into a non-accepted integration branch.
- `pull-request.merge.reconcile-preview` merges only an exact repository-default-branch candidate into `preview` or `vercel-preview`, always using a merge commit so accepted ancestry is preserved after promotion.
- `pull-request.merge.promote` merges only an exact head/base candidate into the repository default branch and requires a non-empty owner approval reference.
- `work-item.create` creates durable issue-backed work with optional normalized status, kind, and origin.
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

Provider adapters report real capability and preflight evidence. They do not change the runtime contract. Development Intelligence may implement only read/query capabilities.

The compact project-status projection is rebuilt on demand from provider-native work, native issue↔PR cross-references, PR/check state, and inspect preflight. It is not persisted as another project ledger.

Every mutation claims an idempotency key and payload fingerprint before performing external work. A matching retry replays the original receipt; a different payload using the same key fails with `CONFLICT`.

The included in-memory idempotency store is suitable for tests and one-process development only. A deployed mutation runtime must supply a durable atomic store before exposing mutation tools.

## Intentionally absent

- generic shell or arbitrary provider dispatch
- arbitrary push, force-push, unbounded merge, or repository-admin tools
- inferred or unattended default-branch promotion; promotion requires an exact candidate plus explicit owner approval context
- arbitrary branch reconciliation or force-updating Preview; post-promotion reconciliation is limited to exact default-branch → Preview ancestry
- multi-agent workers or handoffs
- scheduling and durable waits
- session management
- a provider-specific orchestration transport beyond the thin authenticated MCP adapter
- a second source of project intelligence

Transports adapt this contract. They do not own it.

The first transport is documented in `docs/MCP_RUNTIME.md`. It exposes the configured runtime tools over authenticated Streamable HTTP without adding runtime semantics.

## Acceptance

- A fresh runtime instance can enumerate its exact public tools and configured environment capabilities.
- Project status groups active durable work without choosing it, and carries native PR/check evidence when a candidate exists.
- Project preflight returns every check required by the selected intent, including explicit unavailable or blocked results.
- Provider failures are normalized and visible.
- Receipts are stable and carry provider identifiers, including merge commit SHA when a merge succeeds.
- Post-promotion reconciliation accepts only the exact default branch → Preview lane and preserves ancestry with a merge commit.
- Retrying the same mutation cannot repeat its side effect through the idempotency executor.
- Existing orchestration policy and tests remain intact.
