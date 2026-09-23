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
