# Security and Human Gates

## Main rule

`main` is human-promoted accepted truth.

Conductor must not have a bypass path that allows it to infer production approval.

## GitHub App

Use least privilege.

Typical initial permissions may include metadata read, contents read/write where needed, PR read/write, issues read/write, checks/actions read, deployments read/write if used, and Projects read/write only when needed.

Avoid Administration and workflow-file mutation unless specifically justified.

Conductor mints installation tokens per repository instead of distributing the App private key or a portfolio-wide installation token to development clients. Development Intelligence uses a separate read-only identity.

Repository reach, operation permission, Development OS authorization, and consequential approval are separate checks. Passing one never implies the others.

Durable issue routing and maintenance use the distinct `route-work` action class. Development OS grants retain the active referent and can name exact routing destinations without authorizing code changes. Revocation, expiry, exclusions, and referent changes block this semantic decision. Provider access and visibility of the destination still need separate verification. Search for a canonical issue before creating another; append evidence there, and link confirmed duplicates before closing them. Do not close an issue solely because its title resembles another.

The MCP server requires an authenticated write-scoped client for mutations. Issue creation, comments, classification, and lifecycle updates use an exact repository name and provider Issues write permission. Development OS must establish the current routing intent, destination ownership, and suitable visibility; issue maintenance does not authorize implementation in the destination. At the start of a conversation, the agent establishes the active repository from the user or workspace and calls `work-scope.begin` with its exact owner/repository. The resulting signed, client-bound, 12-hour `workContext` is required on code and deployment writes (and on their operation preflight). It is separate for concurrent conversations even when they share an OAuth client. A code or deployment write to another repository is blocked unless the owner grants that exact repository temporarily at `/work-scope` using the fingerprint reported by `work-scope.identity`. Owner grants expire within 24 hours and can be revoked immediately; expiration leaves only the declared active repository. The server resolves repository aliases before checking code-work scope and fails closed on storage errors. The active repository declaration comes from the agent and is not independent proof of its chat/workspace; an agent could call `work-scope.begin` again for another repository. Development OS must keep this choice bound to the active work referent and obtain a bounded owner exception for additional code work. Do not send sensitive findings to a destination with broader visibility.

## Repository acquisition

External repository acquisition is routing/setup, not development authorization. The caller names the exact public upstream, ref, expected immutable SHA, destination owner/repository, and owner approval reference. The GitHub provider must prove that the destination owner is allowlisted and that the already-created destination repository is empty and writable before importing. The final destination tree is verified against the resolved upstream tree and the import commit records upstream repository/ref/SHA provenance.

Acquisition never changes the active `workContext`, never grants `develop` authority for the new repository, and never enables deployments, secrets, workflows, or other provider bindings. Private sources, submodules, truncated trees, and oversized snapshots fail closed. Repository creation/deletion remain outside this v0 lane so Conductor does not acquire broad account administration merely to benchmark or inspect code.

## Secrets

Separate Preview credentials, Production credentials, GitHub App credentials, model/API credentials, and local hardware credentials.

Ordinary Preview execution identities must not receive production secrets.

## Consequential gates

Require explicit owner action before main promotion, destructive migration, irreversible provider mutation, material billing/payment change, operations affecting real customer data beyond an accepted runbook, material security/permission semantics, or other project-declared consequential boundaries.

Mechanical execution may follow that approval. `pull-request.merge.promote` is therefore not autonomous release authority: it requires the exact PR head SHA, exact base SHA, repository-default target, and an owner approval reference. Conductor refuses stale candidates and preserves the merge commit SHA in its receipt.

Promotion accepts only an exact `preview`/`vercel-preview` candidate and uses a merge commit. This keeps the promoted Preview head in Main ancestry; no routine reverse PR is needed. Preview reconciliation is a separate non-production operation for Main-only changes. It requires exact head/base identity, accepts only the repository default branch as source and `preview`/`vercel-preview` as target, and always uses a merge commit. It never grants or infers Main approval.

## Self-hosted runner

Do not execute arbitrary untrusted public PR code on a personal/local runner.

## Idempotency

Every externally retried mutation must tolerate duplicate delivery.

Use stable work, integration, reconciliation, release-candidate, and provider-event IDs.

## Explainability

Every meaningful mutation retains triggering request, governing policy, evidence/reason, resulting state, and owner override path.

Authorization grants, invalidations, exact consequential approvals, and execution receipts are durable. The combined Work Envelope remains an ephemeral, reconstructable projection.


## Vercel operations

The Vercel adapter scopes writes to an explicitly configured project, repository, and connection, including additive Vercel-only bindings. Unbound reads can discover a project through one unambiguous configured installation and team only after an exact GitHub repository linkage match, with complete bounded pagination and project-detail verification. A discovered read project cannot be mutated. Bound project detail must still prove its configured Git linkage before use. Exact deployment IDs are checked against the resolved project before redeploy, promotion, rollback, deletion, or runtime log reads. Deployment deletion refuses the deployment currently serving production and any active/non-terminal build; deletion of a historical production deployment requires an exact owner approval reference because it removes a rollback artifact. Deployment creation requires an exact linked Git repository, ref, and full SHA. Production traffic and production variable changes require a caller-supplied exact owner approval reference that Development OS must bind to the current user instruction and target; Preview readiness does not imply production approval. Mutations require the connected client's code-work scope and durable idempotency. After a traffic mutation, receipts report the observed production target and whether it matches; an unverified receipt is not proof of traffic movement.

Environment values are write-only. Variable list and audit responses project metadata fields only; mutation receipts, errors and durable idempotency records never include the value. The one-way fingerprint includes the submitted value without storing it. Broad project audit reads report the bounded team plan when supported and explicitly identify unavailable spend/usage/budget information instead of scraping private dashboards.
