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
  Closed, unmerged candidates return terminal `closed-unmerged` with `shouldAct=false`, even when retained checks failed or remain pending. History is preserved; closure does not complete the owning issue. Reopening restores ordinary exact-head gates.
- `operation.status(project, idempotencyKey)` is exposed when scoped commit recovery is configured. It looks up only this authenticated OAuth client's `git.commit.create` claim in the exact canonical repository using the caller-known original key, including while the original call is pending. It reports retained outcome and last durable phase, not process liveness, and may reconcile an exact known candidate using provider reads only.
- `source.artifact.read(project, sha, path, maxBytes?)` is the narrow DI-first bridge from semantic narrowing to mutation: it requires an exact immutable 40-character Git SHA plus one repository-relative path and returns one complete bounded UTF-8 file or an explicit binary/too-large/unsupported result. It does not browse, search, index, infer architecture, or replace Development Intelligence.
- `ci.run.read(project, pullRequestNumber, expectedHeadSha, workflowRunId, jobId?, logTailBytes?)` is a failure drill-down after `pull-request.status`: it re-verifies the exact PR head and workflow-run SHA, returns bounded job/step metadata, and includes redacted tail logs only for an exact requested job or up to three failed jobs. It never reruns, cancels, approves, or otherwise mutates CI.
- `deployment.status(project, limit?)` is exposed when a deployment read provider is configured and returns provider-native current production, latest production attempt, recent deployments, source revision/ref where available, and deployment domains.
- `deployment.logs(project, deploymentId, limit?)` reads one exact deployment's bounded/redacted build/deployment event output. Provider event retention/coverage remains explicit and is not treated as a complete runtime archive.
- `deployment.audit(project)` reads bounded project/team posture, Git linkage, domains/aliases, custom environments, recent deployments, environment-variable metadata, and supported account posture without copying provider state into Conductor.
- `deployment.runtime-logs(project, deploymentId, limit?)` reads bounded/redacted runtime output only when the exact project is eligible for direct-token runtime-log access. Vercel's published Integration API scope mapping does not grant installation tokens access to the runtime-log endpoint, so ordinary connected-installation preflight reports this operation as unavailable instead of repeatedly probing a known provider boundary. An exact runtime-log opt-in preserves installation-backed project/deployment identity checks and routes only the runtime-log request through the server-side direct token; preflight stays degraded until one exact read proves access.
- `deployment.env.list(project)` lists environment-variable metadata for one exact project and never returns values.
- `deployment.vcr.get(project, name)` reads one exact project-scoped Vercel Container Registry repository by validated name and returns only bounded repository metadata.
- `deployment.vcr.create(project, name, idempotencyKey)` creates one exact project-scoped VCR repository when absent, then reads the same name back from Vercel before reporting verified success. Existing exact repositories are returned without a duplicate create effect.
- `work-item.status(project, issueNumber)` reads one durable work item with normalized lifecycle status, kind, and origin.
- `work-item.list(project, ...)` lists issue-backed work and can filter by normalized status, kind, and origin. Pull requests are excluded.

When explicitly enabled with durable Redis idempotency state, the current source-control mutation family exposes bounded GitHub mutations:

- `git.branch.create` creates only `work/*` branches from an exact SHA.
- `git.integration.bootstrap` creates exactly `preview` or `vercel-preview` from the current provider-native default-branch SHA after exact owner approval. It reconciles an already-existing same-SHA branch idempotently, refuses stale/default/conflicting/sibling integration state, never changes the default branch, and does not weaken ordinary `work/*` branch creation.
- `git.branch.delete` removes one exact integrated `work/*`, `repair/*`, or `audit/*` branch only after refetching the expected head, refusing open-PR/protected branches, and proving the exact head is already contained in Preview or the repository default branch. It is destructive but idempotent; no bulk or age-based cleanup exists.
- `git.commit.create` creates a bounded file commit through GitHub's native tree-content request rather than per-file blob uploads, supports tracked-path deletion with null content, and re-reads the exact expected `work/*` head before requesting non-force advancement. GitHub REST `force: false` protects fast-forward ancestry; it is not an atomic expected-old-ref compare-and-swap.
- `pull-request.create` opens `work/*` pull requests against an explicit target branch and may also open the single bounded promotion-proposal lane from `preview`/`vercel-preview` to the provider-native repository default branch. The default branch is re-read from GitHub before that proposal is created. Opening a proposal does not authorize or perform merge/promotion; consequential acceptance remains a separate operation and gate.
- `pull-request.comment.create` adds an idempotent pull-request comment.
- `pull-request.labels.update` adds/removes labels while preserving unrelated labels.
- `pull-request.merge.integration` merges only an exact head/base candidate from a bounded work/repair/audit/release source into a non-accepted integration branch.
- `pull-request.merge.reconcile-preview` merges only an exact repository-default-branch candidate into `preview` or `vercel-preview`, always using a merge commit for exceptional Main-only content changes.
- `pull-request.merge.promote` merges only an exact `preview`/`vercel-preview` head/base candidate into the repository default branch with a merge commit, requires a non-empty owner approval reference, and fails closed while any open `production-blocking` work item exists unless every current blocker is explicitly named in the override. The durable receipt records the exact overridden blocker numbers. Normal promotion preserves Preview ancestry without a return PR.
- `deployment.redeploy` redeploys one exact bound deployment; production-source redeploys require exact owner approval.
- `deployment.git.create` creates a deployment from an exact linked Git repository/ref/full SHA. Preview lets Vercel infer the Preview target; production requires exact owner approval.
- `deployment.promote` and `deployment.rollback` move production traffic only to one exact READY bound deployment with explicit owner approval and read-after-write reconciliation.
- `deployment.delete` removes one exact terminal bound deployment. It refuses current production and active builds; deleting a historical production rollback artifact requires explicit owner approval.
- `deployment.env.upsert`, `deployment.env.update`, and `deployment.env.remove` mutate one exact bound project's variable configuration. Values are write-only, and production-scoped changes require explicit owner approval.
- `work-item.create` creates durable issue-backed work with optional normalized status, kind, and origin.
- `work-item.comment.create` adds idempotent evidence or a consolidation link to an existing issue. It refuses pull requests.
- `work-scope.identity` identifies the connected OAuth client and owner-granted exceptions for the work-scope page. `work-scope.begin` declares a conversation's active exact owner/repository and returns a 12-hour, client-bound `workContext`. Supply it on code and deployment mutations and on their `preflight_operation` checks. Issue creation and maintenance route separately without a work context. The declaration is agent supplied; the server does not verify the chat's workspace.
- `work-item.update-status` changes only lifecycle status; `done` closes the backing issue and active statuses reopen it. Link a confirmed duplicate to its canonical issue before closing it.
- `work-item.classification.update` changes kind and/or origin without changing lifecycle status. `unknown` clears that classification. Issue maintenance uses `route-work`, including for an exact issue in another repository.
- `work-item.triage.update` changes severity, priority, and/or the explicit `production-blocking` release gate while preserving lifecycle status, kind, origin, and unrelated labels. `unknown` clears severity/priority and `false` clears the release gate.

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

Provider adapters report real capability and preflight evidence. They do not change the runtime contract. Provider-neutrality is organized by semantic capability family rather than a generic provider read/write/execute interface: source-control mutation, work-item mutation, intelligence/preflight, deployment read/mutation, and future database/artifact/local-execution families may evolve independently. Vercel is the first deployment-operations implementation; it does not implement source-control mutation semantics. Development Intelligence may implement only read/query capabilities. Project/repository identifiers entering the runtime are execution-routing referents supplied by callers; Conductor does not expand them into a project model.

Operation preflight is evidence aggregation, not planning. An operation must first be exposed by the configured runtime. Responsible providers then prove or qualify the exact capability/permission lane they own. GitHub App evidence is operation-specific; static-token repository-role evidence remains degraded because it cannot prove fine-grained operation permissions.

The compact development-status projection is rebuilt on demand from provider-native work, native issue↔PR cross-references, PR/check state, and inspect preflight. Pull-request orchestration state is likewise derived on demand from exact provider truth. Waiting states explicitly distinguish `shouldAct=false` external gates from caller-action states, and optional prior observations make unchanged polling detectable without a Conductor PR-state database. These projections are not persisted as another project ledger and do not claim to describe product or technical architecture.

Every mutation claims an idempotency key and payload fingerprint before performing external work. A matching completed retry replays the original receipt; a different payload using the same retained key fails with `CONFLICT`.

Release accounting has no fixed work-item-count ceiling. Canonical issue identity remains provider-derived, complete, positive and unique in a seal, and exact head/base drift still fails closed. Inline release identities/seals have a 16 KiB serialization budget; signed lifecycle continuations must fit their existing 4096-byte transport. These are explicit technical transport limits, not instructions to split an otherwise coherent release because of its issue count. Existing provider pagination and commit-inventory completeness bounds remain in force.

The included in-memory idempotency store is suitable for tests and one-process development only. A deployed mutation runtime must supply a durable atomic store before exposing mutation tools.

### Scoped commit checkpoints and recovery

For authenticated MCP `git.commit.create`, the claim identity is scoped to the OAuth client, resolved lowercase canonical `owner/repository`, and caller-known idempotency key. An alias resolving to that same repository addresses the same claim. Other clients, repositories, operation families, and legacy unscoped records are not exposed by `operation.status`; there is no list/search operation for claims.

The durable record stores a one-way payload fingerprint and metadata-only, monotonic checkpoints: `validated`, `tree-created`, `commit-created`, `ref-update-requested`, and `ref-confirmed`. Checkpoints contain only repository, branch, expected parent/head SHA, and known tree/candidate commit SHAs. The candidate identity and ref-update intent must be persisted before the mutable ref PATCH; the branch is re-read against the exact expected head before that request. Raw source content, commit messages, and credentials/secrets are not persisted in checkpoints or idempotency records.

A matching incomplete retry does not restart execution. Both it and `operation.status` may reconcile a persisted candidate by reading the exact repository branch ref and candidate commit. The candidate must have the recorded tree and exactly one parent equal to the expected original head. The live ref must equal the candidate SHA, or one exact candidate-to-observed-head GitHub comparison must report `ahead` with the candidate as its merge base. This bounded ancestry proof supports a later legitimate head without scanning history. An unchanged expected parent, diverged/deleted branch, or unavailable proof remains unknown. Recovery never creates another tree/commit, advances a ref, or resumes unfinished phases. A lost response, older record, or last phase is not evidence that the original process is running, stopped, or failed.

Status reports `not-retained`, `incomplete`, or `completed`, with outcome `unknown`, `succeeded`, or `failed` as supported by the retained receipt. An incomplete operation remains unknown when exact readback cannot prove success. Redis retention defaults to seven days after the last durable claim, checkpoint, or completion write; ordinary status reads and receipt replays do not refresh retention. `not-retained` is not proof that no provider effect happened and is not authority to repeat a mutation with a new key.

This contract is limited to `git.commit.create`. The dedicated `git.workflow.commit` permission/review lane is unchanged and gains no checkpoint recovery. The stateless serverless MCP call still awaits the original operation; checkpoints add response-loss visibility, not asynchronous execution, a scheduler, an operation ledger, or automatic resume.

## Intentionally absent

- generic shell or arbitrary provider dispatch
- arbitrary push, force-push, unbounded merge, or repository-admin tools
- inferred or unattended default-branch promotion; promotion requires an exact candidate plus explicit owner approval context
- arbitrary branch reconciliation or force-updating Preview; exceptional Main-only reconciliation is limited to exact default-branch → Preview ancestry
- multi-agent workers or handoffs
- scheduling and durable waits
- session management
- project-wide/bulk deployment cleanup, delete-by-URL, active-build cancellation through cleanup, alias/domain mutation, or secret-value reads; exact deployment deletion remains one-target, idempotent, and gated
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

- `lifecycle.advance(project, issueNumber, ...)` is a bounded composite over existing provider-native work/PR/deployment state. It may poll a small bounded number of times, integrate an already-verified work PR into Preview, prove the exact Preview deployment, and create/reuse a Preview-to-Main promotion PR. It stops on ambiguity, verification failure, external wait, completion, or a signed human gate. Every underlying mutation keeps its own durable idempotency key derived from the caller's lifecycle key.
- `lifecycle.resume(project, gate, approvalReference, ...)` accepts only a client/repository/project-bound signed human gate, re-reads the exact promotion PR head/base and `promotion-ready` state, and requires a new `owner-approved:` reference before calling the existing Main promotion mutation. `lifecycle.advance` never promotes Main.


- `evidence.bundle(items, concurrency)` is the first bounded parallel read surface. It accepts 1–12 explicit items and a concurrency ceiling of 1–4, supports only project preflight, deployment status, runtime logs, pull-request status, and repository audit, preserves input order, keeps every project's exact identity/error separate, performs no hidden retries, and returns compact operation-specific evidence rather than concatenating full standalone receipts. It is intentionally not a batch mutation or arbitrary tool-dispatch surface.


- `source.discover(project, sha, ...)` provides bounded provider-native source location evidence at one exact immutable revision. Without a query it returns a bounded recursive-tree manifest. With a query it scans only bounded likely-text blobs from that exact tree for literal line matches. It reports scan/file/byte/match limits, truncation reasons, skipped large/binary/unsupported files, and exact blob identities. Results are path evidence, not semantic relevance, architecture meaning, impact analysis, or mutation authority; use `source.artifact.read` to inspect a selected file exactly and Development Intelligence for semantic/project-wide reasoning.


## Scheduled VCR retention

Production may configure generic VCR cleanup targets in `CONDUCTOR_VCR_RETENTION_JSON`. Vercel Cron invokes `/internal/vcr-retention`, authenticated only by `CRON_SECRET`. The maintenance runner enumerates exact deployment and VCR image evidence, preserves current READY production, one distinct rollback SHA, latest READY Preview, configured retention windows and production aliases, and then calls the existing exact `deployment.vcr.image.delete` path for every planner-approved deletion. That means scheduled deletion retains the same exact image ID/digest check, protected-deployment re-read, durable idempotency and provider readback used by interactive mutations. Missing identities remain review items, and a provider failure stops the run without affecting serving deployments. VCR provider quota/headroom is not currently authoritative through the API, so the runner reports exact retained-image counts and known bytes rather than inventing capacity.

## Preview PR verification events

The HTTP endpoint uses SDK v2's native `2026-07-28` transport and retains stateless legacy tool compatibility. MCP Events is a draft extension registered with the SDK's custom-method API; event methods are exposed only on the modern transport when explicitly configured. Reference: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) and [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

A separate code path permits generic catalog discovery without delivery. The exact enabling boundary is `CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY=true` with `VERCEL_ENV=preview` and `CONDUCTOR_PR_EVENTS_JSON` entirely absent (even an empty live variable is rejected). No other discovery flag value is accepted; unset the flag to disable it. Outside Preview or with both modes present, startup fails closed. This is a deployment-time setting, not a tool parameter, and implementing the seam does not set it anywhere.

Discovery-only advertises `capabilities.events` on the authenticated modern `2026-07-28` transport. `events/list` returns the same pure static catalog used by live mode, plus standard SDK server-info metadata. It contains generic input/payload schemas only: no configured repository, PR, owner, callback, identity, private review data or grant metadata. A valid ordinary `conductor.read` principal is required, but catalog discovery does not itself consult event grants. Ordinary OAuth token verification still applies, including issuer/audience/expiry validation and existing generation-bound grant validation when such a token is supplied. Legacy OAuth tokens are not upgraded and no event grant is created by this mode.

`events/subscribe` and `events/unsubscribe` both return JSON-RPC error `-32000`, message `Event subscriptions are not enabled`, data `{ "reason": "events_not_enabled" }`, before delivery-parameter, URL or secret validation. Unsubscribe performs no state access. Invalid JSON-RPC envelopes and invalid list parameters remain protocol errors; unauthenticated calls remain HTTP 401. `/events/github` is not mounted (404). The mode returns before any live event configuration or event-service construction: no event Redis store/client, GitHub App reader, vault, callback verifier/sender, ingress or delivery object is initialized. Existing ordinary tool/work-scope/OAuth infrastructure and its own configuration requirements remain unchanged.

This mode enables a later, separately authorized installed-host schema probe. Local HTTP tests do not prove that ChatGPT advertises or consumes the catalog, supports callbacks, subscribes, wakes a chat or continues work. No installed-app refresh, environment edit or test event is part of the code change. Live mode still requires removing the discovery flag and satisfying all existing exact-resource configuration and authorization gates.

`pull_request.verification_changed` covers one configured repository, PR number, expected head SHA and expected base SHA on `preview`. `server/discover` advertises events; authenticated `events/list`, `events/subscribe` and `events/unsubscribe` use that same `/mcp` endpoint. There is one active callback slot per configured exact wait. Subscription identity includes issuer, subject, OAuth client, canonical arguments and callback URL; it never accepts a chat ID. Lifetimes are capped at one hour and the subscribing access token's expiry. Refresh rechecks access, verifies a changed signing secret and briefly dual-signs during rotation. `cursor` is always null: interruption recovery is fresh provider reconciliation, not replay.

The feature defaults off. `CONDUCTOR_PR_EVENTS_JSON` configures `{target: {repository, pullRequestNumber, headSha, baseSha}, owner: {issuer, subject, clientId}, installationId, callbackHostname}`. Configuration is accepted only with `VERCEL_ENV=preview`, existing Redis, existing GitHub App credentials, an approved `CONDUCTOR_GITHUB_WEBHOOK_SECRET`, and the existing credential vault. This source change does not provision any of those settings or authorize a live subscription. The owner tuple is an explicit resource grant; issuer and subject come from verified token claims, never from OAuth-client identity. Removing the configuration or changing that tuple stops routing through its storage namespace.

`POST /events/github` accepts at most 256 KiB of raw-body HMAC-verified hints with a valid delivery identity:

- `pull_request`: opened, reopened, synchronize, ready_for_review, converted_to_draft, closed.
- `check_run`: created, completed, rerequested; `check_suite`: completed, rerequested.
- `pull_request_review`: submitted, edited, dismissed.
- `pull_request_review_comment`: created, edited, deleted.

`pull_request_target`, unsupported actions, deployment outcomes, general issue transitions and project-chat completion are excluded. Installation/repository/PR/head filters precede fresh native installation attestation and `pull-request.status`; PR/review/comment hints must also match the expected base SHA. An authoritative exact-head/base mismatch or failed access/read stops the subscription. Signal bodies are routing hints, never review evidence or instructions. Source deduplication uses repository + installation + delivery ID across event categories; outbound identity remains subscription + scoped source + canonical current-state fingerprint. An old or out-of-order signal rereads current state rather than replaying its payload.

The configured publisher adds `reviews` to the existing `pull_request.verification_changed` payload. The GitHub App reader checks the current grant before and after each private request and validates PR number, repository, head and Preview base before and after pagination. It reads at most two 50-item pages of reviews and two of review comments through the existing provider/auth boundary, requiring only existing `pull_requests:read`. A short final page marks pagination exhausted. A full second page conservatively yields `complete:false`, `reason:"page-limit"`, null approval count and empty decision/comment lists; those empty lists do **not** imply deletion or no reviews. A bounded revision still reflects the observed subset. No completeness or change detection is claimed beyond that bound. Duplicate IDs during pagination fail closed. Provider list reads are not an atomic snapshot; concurrent changes without detectable identity drift can race observation, so the host must reread before any continuation.

For complete results, `latestActivity` holds the latest submitted review per reviewer (submitted time, then ID), including state, commit SHA, `currentHead`, reviewer ID/login and content version. Pending reviews are excluded. This replaces the ambiguous `latest` field while the capability remains unactivated. `effectiveDecisions` is separate: one reviewer-bound state (`APPROVED`, `CHANGES_REQUESTED`, `NONE`, or `UNKNOWN`) with the decision's review ID and commit SHA. COMMENTED changes activity only; it never erases an approval or unresolved request. A later current-head APPROVED review resolves that same reviewer's earlier requests. Other reviewers remain independent. Requests on older heads remain unresolved; an old-head approval cannot clear them or count as current approval. A stale approval without an established unresolved request is UNKNOWN.

Each provider-current DISMISSED row removes only that review's decision, not another review's unresolved request. Dismissal cannot revive an older approval: if a later dismissed decision leaves an older approval or unknown history, the result stays UNKNOWN because the original dismissed state is no longer available. A sole dismissed decision with no remaining earlier decision yields NONE. Deleted/unidentified reviewers yield UNKNOWN. Incomplete pagination yields `effectiveDecisions:null` and `currentHeadApprovals:null`, never an empty known decision set. With complete evidence, the count is also null if any reviewer is UNKNOWN; otherwise it counts effective current-head approvals. NONE and a count of zero are not clearance. These are conservative descriptive summaries, never GitHub branch-protection readiness or merge authority. `comments` holds current comment IDs, review IDs, author identity, commit SHA, current-head flag, update timestamp, version and a resource-derived GitHub URL. Deletion is recognized by disappearance from a complete fresh collection; edits change version even when timestamp precision is insufficient. No raw bodies, diff hunks, file paths, provider-supplied URLs, transcripts, tool inputs or private receipts are sent or logged by this path.

Versions are SHA-256 digests of body and relevant state/timestamp metadata; the canonical revision also includes bounded historical review metadata, so an edit to an older submitted review can change the wake hint. Digests disclose content equality and are not encryption or a confidentiality guarantee against guessing. Event time is observation time, not the webhook's historical event time. Existing callback size, total state byte cap, retention, retries, SSRF and grant/CAS revocation fences remain unchanged. This metadata expansion performs no continuation and introduces no scheduler, replay cursor or activation.

Provider contracts: [GitHub review listing](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) and [review comment listing](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request).

Redis stores one CAS-protected bounded record per configured wait: encrypted callback keys, subscription metadata, baseline fingerprint, up to 256 source identities and 128 delivery records. Source/delivery retention is 24 hours; the record expires after two idle days. Capacity exhaustion fails closed. A before/after provider read closes the subscription baseline race. Native source IDs are deduplicated, and an unchanged current fingerprint emits no event. Each outgoing event keeps its ID over at most three attempts with exponential backoff. An attempt is claimed durably before sending; a 30-second lease fences concurrent attempts. A restart can resume a pending attempt on source redelivery after that lease, but there is no autonomous retry scheduler. A changed current fingerprint suppresses stale retries.

Ingress reports `accepted` only for callback 2xx receipt, `pending` for contention/uncertain completion, `failed` for exhausted transient failures, `stopped` for permanent rejection, `inactive` for expiry/unsubscribe, and `blocked` for failed access/exact-state reconciliation. Unsubscribe fences subsequent attempts but cannot recall a request already in flight. Callback receipt never proves a host turn, continuation, Slack delivery, or exactly-once action. The receiving dot must re-read native state and use the existing guarded continuation and idempotency contracts; this publisher performs no continuation or Slack send itself.

Live acceptance still requires the approved provider signal, an actual host callback subscription, wake, authoritative reread, eligible continuation and deduplicated Slack permalink. Local transport tests and callback/store fakes establish none of those live outcomes. The broader workflow/review/deployment/issue categories tracked in #307 remain outside this narrow slice and are required before any Main proposal.
