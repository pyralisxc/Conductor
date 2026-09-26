# GitHub Authorization and Workflow Acceleration

## Objective

Make ordinary owner-directed GitHub development fast across the authorized portfolio without confusing broad provider reach with development authorization.

The system does not create product objectives or infer consequential approval.

## Ownership

- **Development OS** owns objective, constraints, Ambition, stage/mode, Evidence Appetite, standing authorization, frontier, reversal, and handoff.
- **Development Intelligence** owns read-only technical reality and evidence-backed analysis.
- **Conductor** owns provider identity, capability, durable work routing, source-control mutation, idempotency, receipts, and Preview/Main execution boundaries. GitHub is the current adapter for that source-control family.
- **Owner-facing UI/control surfaces**, if introduced later, consume these systems without becoming another semantic authority.

## Three independent decisions

1. **Provider capability** — can the configured identity technically perform the operation?
2. **Session authorization** — is that action class authorized for the current objective and referent?
3. **Consequential gate** — does this exact operation still require owner approval?

Provider capability never grants session authorization.

## Work Envelope

The Work Envelope is an ephemeral projection that carries project, objective, Ambition, constraints, stage, mode, Evidence Appetite, frontier, authorization, development state, reality, capabilities, gates, last effect, and resume condition.

Authorization grants, invalidations, exact consequential approvals, and execution receipts are durable records. The envelope is reconstructable from those records and current provider reality; it is not a second source of product truth.

Effective authorization is computed:

```text
valid grant
+ matching project and referent
+ compatible Dev OS stage
+ action class included and not excluded
+ exact consequential approval when required
= effective authorization
```

Returning from Build to Explore suspends mutation immediately without deleting the underlying grant. Re-entry into Build remains owner-directed.

## GitHub identities

### Conductor App

The preferred runtime identity is a private GitHub App installed across the allowed owner portfolio. Conductor discovers the repository installation and mints a short-lived installation token scoped to the requested repository.

Initial permission ceiling:

- Metadata: read
- Contents: read/write
- Pull requests: read/write
- Issues: read/write
- Checks: read
- Actions: read
- Commit statuses: read
- Deployments: read/write only when Preview integration requires it

Administration, secrets, organization administration, destructive repository administration, and workflow-file mutation remain absent without a separate concrete need and owner gate.

`CONDUCTOR_GITHUB_ALLOWED_OWNERS` remains authoritative above installation reach. An installed App cannot make another owner addressable unless Conductor policy also allows that owner.

### Development Intelligence App

Development Intelligence should use a separate read-only GitHub App. Its identity must be physically unable to mutate inspected repositories.

## Permission-aware preflight

`preflight_operation` proves the permission lane for one exact exposed GitHub operation and uses the same permission requirements as execution. `preflight_project` remains the broader repository-development readiness view.

For GitHub App credentials, Develop readiness requires the permissions needed by every exposed bounded mutation:

- branch/commit: `contents:write`
- pull-request creation: `pull_requests:write`
- pull-request conversation comment: `issues:write`
- work-item create/status/classification: `issues:write`

Preflight emits App, installation, account, repository coverage, repository-selection, and effective-permission evidence. A legacy static token may remain during migration, but repository role evidence can only produce degraded—not operation-verified—read/write readiness for exact operations.

Provider permission, repository policy/rulesets, and successful execution remain distinct proof levels. Exact-head checks and immutable receipts protect execution-time truth.

## Consequential operations

Preview integration may be covered by standing authorization when explicitly included. Main promotion and Admin/Elevate remain exact owner gates.

A promotion approval binds to the exact Preview candidate SHA. The promotion receipt records both the approved candidate and resulting main SHA because repository merge policy may create a different merge commit.

## Provider truth

GitHub remains authoritative for issue, PR, branch, check, and repository state. Conductor queries and normalizes that state rather than copying it into a second durable ledger.

If webhook/event ingestion is introduced later, events are wake/reconciliation signals rather than repository authority.

## Pull-request execution kernel

The GitHub provider exposes bounded PR concerns instead of one generic mutation power:

- **status** — read exact PR head/base identity, labels, check/workflow truth, and derived orchestration state; prior observations may be supplied ephemerally to detect meaningful transitions without persisting PR state;
- **labels** — add/remove PR labels while preserving unrelated labels;
- **lifecycle** — close an exact unmerged PR or mark an exact draft ready for review, with head-SHA guards and provider read-back;
- **verification rerun** — rerun one exact `verify` workflow run only when GitHub proves it belongs to the expected PR head; this requires GitHub App `actions:write`;
- **integration merge** — merge an exact candidate into a non-accepted integration branch;
- **Preview reconciliation** — merge an exact repository default-branch change into `preview` or `vercel-preview` when Main contains content absent from Preview;
- **promotion merge** — merge an exact explicitly approved Preview candidate into the repository default branch, preserving Preview ancestry.

State-aware PR status preserves all observed check/workflow runs but marks superseded same-name evidence as historical; orchestration is derived only from the latest relevant exact-head evidence. State-aware PR status never authorizes its own next action. `promotion-ready` means observed technical gates are settled; Development OS/owner approval still governs consequential promotion. An `external-gate-pending` result with `shouldAct=false` is a signal to stop identical polling and wait for provider/user/event-driven re-entry.

For self-sealing repositories, Conductor treats `seal-b` + successful source `verify` + failed `action-smoke` + active/successful `self-seal` as an expected pre-seal checkpoint mismatch rather than a source failure. If the seal changes the candidate SHA and GitHub reports `action_required`, status explicitly requests exact sealed-head verification before promotion.

Opening a PR remains a proposal and does not authorize its merge. Integration merge rejects `main`, `master`, and the repository default branch. Preview reconciliation accepts only the repository default branch as source and `preview`/`vercel-preview` as target, requires exact head/base SHAs, and always uses a merge commit. Promotion accepts only `preview`/`vercel-preview`, requires exact head/base SHAs plus an owner approval reference, and uses a merge commit; stale identity fails closed.

The current approval reference is an audit field supplied by the authorized interactive caller. It is not a cryptographic proof of human intent. The shared authorization/Work Envelope layer remains responsible for ensuring the caller invokes promotion only after current explicit owner approval.

## Current delivery direction

The GitHub identity, bounded mutation, PR execution, post-promotion Preview reconciliation, and durable work-item kernels are established.

Next improvements should compress human-directed workflow around native artifacts: compact project/work/PR projections, stronger reconstruction, and measured workflow simplification. Event-driven automation, scheduling, and unattended worker orchestration remain deferred until repeated real usage proves a deterministic need.

Every contract remains portfolio-native.
