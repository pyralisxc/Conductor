# GitHub Authorization and Workflow Acceleration

## Objective

Make ordinary owner-directed GitHub development fast across the authorized portfolio without confusing broad provider reach with development authorization.

The system does not create product objectives or infer consequential approval.

## Ownership

- **Development OS** owns objective, constraints, Ambition, stage/mode, Evidence Appetite, standing authorization, frontier, reversal, and handoff.
- **Development Intelligence** owns read-only technical reality and evidence-backed analysis.
- **Conductor** owns provider identity, capability, GitHub mutation, idempotency, receipts, Preview integration, event ingestion, and structured escalation.
- **AI Systems Control** owns the combined owner-facing projection without absorbing the other systems' semantics.

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

For GitHub App credentials, Develop readiness requires the permissions needed by every exposed bounded mutation:

- branch/commit: `contents:write`
- pull-request creation: `pull_requests:write`
- pull-request conversation comment: `issues:write`

Preflight emits App, installation, account, repository coverage, repository-selection, and effective-permission evidence. A legacy static token may remain during migration, but repository `permissions.push` can only produce degraded—not operation-verified—write readiness.

Provider permission, repository policy/rulesets, and successful execution remain distinct proof levels. Exact-head checks and immutable receipts protect execution-time truth.

## Consequential operations

Preview integration may be covered by standing authorization when explicitly included. Main promotion and Admin/Elevate remain exact owner gates.

A promotion approval binds to the exact Preview candidate SHA. The promotion receipt records both the approved candidate and resulting main SHA because repository merge policy may create a different merge commit.

## Event truth

GitHub webhooks keep projections current but are not repository authority. Conductor verifies signatures, deduplicates delivery IDs, processes asynchronously, tolerates repetition and reordering, and reconciles against current GitHub state.

## Delivery order

1. GitHub App identity and operation-aware preflight.
2. Webhook kernel and reconciled event projections.
3. Development Intelligence consolidation and impact analysis.
4. Shared Work Envelope and authorization records.
5. Project-open projection and measured workflow compression.

CardForge is the first canary; every contract remains portfolio-native.
