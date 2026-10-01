# MCP runtime deployment

Conductor exposes its typed runtime through a stateless Streamable HTTP MCP endpoint at `/mcp`. The transport is deliberately thin: it registers the operations enabled by `ConductorToolRuntime` and returns each runtime receipt unchanged as structured content.

## Security boundary

All MCP requests require an OAuth 2.1 bearer token. The server validates the token signature, issuer, exact `/mcp` audience, expiry, stable client identity, and `conductor.read` scope. Mutation tools additionally require `conductor.write`. Conductor includes a deliberately small single-owner authorization server, adapted from the proven Development Intelligence deployment pattern. It supports owner sign-in, dynamic public-client registration, authorization code with PKCE S256, signed refresh tokens, and short-lived signed access tokens. It publishes protected-resource metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

Authorization-server discovery is published at `/.well-known/oauth-authorization-server`. The issuer is the exact stable Conductor origin and the resource audience is the exact stable `<origin>/mcp` URL.

Dynamic client registrations, access tokens, and refresh tokens are signed and stateless. Authorization codes remain five-minute, single-use records. A single-process deployment may keep those records in memory. Horizontally scaled hosts such as Vercel must configure Redis so authorization and token exchange can land on different instances without weakening one-time code consumption.

The `/health` endpoint is public and returns only runtime health and contract version. It exposes no project or provider details.

## Execution binding and repository authorization

`CONDUCTOR_GITHUB_ALLOWED_OWNERS` authorizes repositories under one or more GitHub owners without per-repository environment edits. Projects may be addressed as `owner/repository`; when exactly one owner is authorized, a bare repository name is also accepted. Cross-owner requests fail closed.

`CONDUCTOR_PROJECTS_JSON` is retained as a compatibility environment variable, but its entries are runtime execution bindings: explicit aliases, repository/workspace routing expectations, per-binding GitHub write policy, and optional deployment-provider routing. They are not project metadata or architecture. An explicit repository cannot be replaced by request input; mismatches fail with `CONFLICT`. Set `githubWrite` to `false` to deny mutations for an otherwise readable binding. A Vercel-backed binding may add `vercelProject`, `vercelConnectionId`, and `vercelTeamId`; these identify provider resources and an owner-connected installation only. A team installation requires its exact team ID. The connection does not grant work on a repository outside the active development scope.

Example:

```json
[
  {
    "id": "conductor",
    "repository": "pyralisxc/Conductor",
    "workspace": "/workspace/conductor"
  },
  {
    "id": "Development-Intelligence",
    "repository": "pyralisxc/Development-Intelligence",
    "vercelProject": "development-intelligence"
  }
]
```

The preferred GitHub adapter identity is a private GitHub App. For each repository, Conductor discovers the covering installation, mints a short-lived token restricted to that repository, and verifies the effective permissions required by each operation. App-backed Develop readiness requires `contents:write`, `pull_requests:write`, and `issues:write`. Pull-request status additionally requires `checks:read` and `actions:read`; label updates require `issues:write`; merges require `contents:write`.

`GITHUB_TOKEN` remains a migration fallback. Repository-level `permissions.push` is not proof that a fine-grained token can perform every advertised Git Data, pull-request, or issue-comment mutation, so static-token write preflight is intentionally degraded rather than operation-verified.

The workspace adapter verifies readable/writable access, bounded Node process execution, and the presence of a package test script. Preflight does not execute the project's test suite. `preflight_project` remains repository-development oriented: `inspect` requires repository read plus Development Intelligence, `develop` adds GitHub write, and `execute` adds workspace, shell, and tests.

`preflight_operation` is narrower and preferred before one exact effect. It first proves that the operation is actually exposed by the current runtime, then aggregates operation-specific evidence from responsible providers. It does not discover project architecture or choose an operation. Repository acquisition is a deliberate specialized-preflight exception: generic `preflight_operation` cannot express upstream/ref/destination facts, so for `repository.acquire` it directs callers to the authoritative `repository.acquire.preflight` surface rather than reporting the acquisition provider as unavailable.

Repository acquisition is a separate bounded routing capability. `repository.acquire.preflight` resolves one exact public GitHub repository/ref to an immutable SHA and checks that an exact destination under an authorized owner already exists, is empty (or is an exact recoverable Conductor bootstrap), and grants Conductor contents write. When the resolved snapshot contains `.github/workflows/*`, preflight also requires GitHub App `workflows:write` before any destination mutation; static-token acquisition of workflow-bearing snapshots fails closed because that scope cannot be proven. `repository.acquire` then imports only that exact tree, preserves upstream repository/ref/SHA provenance in the import commit, reads the destination branch back, and explicitly returns `codeWorkGranted: false`. It never switches the conversation's work scope, never enables deployments/secrets/apps/workflows, refuses private sources, submodules, truncated trees, oversized snapshots, and non-empty destinations, and requires an explicit owner approval reference. GitHub's retired Source Import API is not used. With the current GitHub App installation model, personal-account repository creation is intentionally outside this v0 lane; create/authorize the destination through normal GitHub/ASC connection UX first. Repository deletion also remains an owner/provider cleanup action rather than adding repository-admin deletion authority to Conductor.

Pull-request transport preserves canonical work identity rather than creating a new development unit at each branch boundary. Ordinary `work/*` PRs target only `preview`/`vercel-preview`. `pull-request.create` may receive `workItemNumbers`; Conductor writes those issue references into the PR body so GitHub's native cross-reference timeline lets `development.status` reconstruct Preview integration and Main-promotion artifacts beneath the original work item. A successful work-head verify yields `integration-ready`, which means only that the exact head may integrate into Preview; it does not claim Preview deployment/proof. Only a verified `preview`/`vercel-preview` promotion candidate yields `promotion-ready`, and Main still requires the caller-owned approval gate.

Development Intelligence remains read-only. `DEVINT_MCP_URL` and `DEVINT_AGENT_TOKEN` connect Conductor to its authenticated MCP `project_status` operation. If they are absent, capability and preflight results explicitly report the adapter as unavailable.

An owner may connect a Vercel integration at `/connections/vercel` after Conductor owner sign-in. The connection stores a separate encrypted credential for each Vercel installation in Redis. A configured connection can inspect an unbound Vercel project when the request supplies an exact Git repository, the connected installation and its team (if present) are unambiguous, and exactly one provider project has matching GitHub linkage verified against project detail. Discovery stops after ten pages (up to 1,000 projects) and fails closed on incomplete or ambiguous results. This read path never creates a write binding or falls back to a server token. For writes, bind the repository to an exact Vercel project ID, the displayed installation ID, and its team ID (if a team installation). These may live in the existing `CONDUCTOR_PROJECTS_JSON` or the additive `CONDUCTOR_VERCEL_BINDINGS_JSON`, so a new project can be connected without replacing the existing runtime configuration. The additive variable accepts only `id`, `repository`, `vercelProject` (`prj_...`), `vercelConnectionId` (`icfg_...`), and optional `vercelTeamId` (`team_...`). Its repository must agree with an existing alias, if one exists; a conflicting Vercel or repository binding fails startup. A bound project's live GitHub linkage is checked before use. Conductor checks that the installation belongs to that team. Local disconnect deletes Conductor's credential immediately; uninstall in Vercel as well to revoke provider access.

Provider credentials now support a dedicated, versioned vault key through `CONDUCTOR_PROVIDER_CREDENTIAL_KEY`. When that key is configured, a successful read of a legacy session-secret-encrypted record is immediately rewritten under the dedicated key without persisting or logging plaintext. During vault-key rotation, `CONDUCTOR_PROVIDER_CREDENTIAL_PREVIOUS_KEYS_JSON` may temporarily list prior keys; successful reads are likewise rewritten under the current key. Keep `CONDUCTOR_SESSION_SECRET` available only as long as unmigrated legacy records may remain. After a record has migrated, owner-session secret rotation or retirement does not affect provider credential decryption. Missing/wrong vault keys fail closed rather than falling back to a different provider credential path.

For a bound or uniquely linked read project, `deployment.status` reads the provider-native project, current production deployment, latest production attempt, recent deployments, source Git SHA/ref when available, and domains. `deployment.logs` reads bounded/redacted deployment-event output for one exact deployment. `deployment.audit` and `deployment.env.list` return bounded configuration and variable metadata without secret values. `deployment.vcr.get` reads one exact project-scoped Vercel Container Registry repository by validated name. Project identity is still verified through the bound Vercel installation; when the shared owner Vercel credential is connected, VCR repository/image API requests use that credential because installation tokens may not authorize registry endpoints. If no shared owner credential exists, Conductor preserves the bound-installation path and reports the provider denial explicitly. `deployment.vcr.create` requires an explicit project binding, active repository work scope, write authorization, and durable idempotency; it creates only one validated repository name and verifies the result with an exact provider read. `deployment.vcr.image.delete` remains one-image-at-a-time and requires an exact image ID plus expected manifest digest. It deletes only images whose provider tags are immutable-looking Git SHA prefixes and only after live Vercel evidence proves those tags do not match current Production, the latest READY Preview, or any active build revision; untagged, mutable-tagged, ambiguous, or protected images fail closed. Successful deletion is verified by an exact provider readback. Exact redeploy, Git-source deploy, promote, rollback, deployment deletion, and environment-variable writes require an explicit project binding, durable mutation state, client write scope, active repository work scope, exact project/deployment or variable identity, and explicit production approval when applicable. Deployment deletion is limited to exact terminal deployments, refuses current production and active builds, and requires owner approval before removing a historical production rollback artifact. Environment values are write-only; receipts and idempotency state do not return or store recoverable secret values. Vercel remains authoritative for deployment state; Conductor does not persist a deployment ledger.

Runtime logs use Vercel's documented `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs` endpoint. Vercel's published Integration API scope mapping does not list this endpoint under any installable integration scope, and the connected installation returns `PERMISSION_DENIED` while ordinary deployment/environment reads succeed. Conductor therefore treats runtime logs as unavailable for installation-token bindings and does not repeatedly probe that known boundary. An exact project may opt into direct-token runtime-log reads through `CONDUCTOR_VERCEL_RUNTIME_LOG_BINDINGS_JSON`; this augments the existing installation binding rather than replacing it, so project/deployment identity checks still use the connected installation while only the runtime-log request uses `CONDUCTOR_VERCEL_TOKEN`. The opt-in contains no secret values and must exactly match the existing runtime id, repository, Vercel project ID, and team. Preflight remains degraded until one exact runtime-log read succeeds. `deployment.logs` continues to cover build/deployment events and is not presented as runtime output. Account usage/spend/budget data remain unavailable on this Hobby team; the audit returns the available plan and explicit partial coverage.

## Required configuration

| Variable | Meaning |
|---|---|
| `CONDUCTOR_PUBLIC_URL` | Stable public HTTPS origin for this runtime |
| `CONDUCTOR_OWNER_PASSWORD` | Private password used only for the single-owner authorization screen |
| `CONDUCTOR_SESSION_SECRET` | Random secret of at least 32 characters used for the legacy owner/session/OAuth cryptographic boundary and legacy credential migration |
| `CONDUCTOR_PROVIDER_CREDENTIAL_KEY` | Dedicated current provider-credential vault key; once records are migrated, credential custody no longer depends on the owner-session secret |
| `CONDUCTOR_PROVIDER_CREDENTIAL_PREVIOUS_KEYS_JSON` | Optional JSON array of up to four previous provider-vault keys used only during explicit key rotation/migration |
| `CONDUCTOR_OAUTH_ALLOWED_REDIRECT_ORIGINS` | Comma-separated redirect origins; defaults to `https://chatgpt.com` |
| `CONDUCTOR_GITHUB_ALLOWED_OWNERS` | Comma-separated GitHub owner namespaces Conductor may resolve dynamically |
| `CONDUCTOR_PROJECTS_JSON` | Compatibility name for optional runtime aliases, workspace bindings, and execution-policy overrides; not project metadata |
| `CONDUCTOR_VERCEL_BINDINGS_JSON` | Optional additive, exact Vercel project/repository/installation bindings for writes; never contains access tokens |
| `CONDUCTOR_VERCEL_RUNTIME_LOG_BINDINGS_JSON` | Optional exact opt-in list for projects whose runtime-log request may use the direct token; must match an existing Vercel binding and never contains access tokens |
| `CONDUCTOR_GITHUB_APP_ID` | Numeric ID of the private Conductor GitHub App |
| `CONDUCTOR_GITHUB_APP_PRIVATE_KEY` | GitHub App PEM private key; multiline or `\\n`-escaped |
| `GITHUB_TOKEN` | Transitional least-privilege static token; ignored when App credentials are configured |
| `DEVINT_MCP_URL` | Development Intelligence MCP endpoint |
| `DEVINT_AGENT_TOKEN` | Separate machine bearer token for read-only DI access |
| `CONDUCTOR_VERCEL_TOKEN` | Optional server-side direct Vercel token. Ordinary bound operations prefer the owner-connected installation; only an explicit runtime-log direct opt-in may use this token when that installation cannot authorize the endpoint. `VERCEL_TOKEN` is accepted as a fallback |
| `CONDUCTOR_VERCEL_INTEGRATION_SLUG` | Vercel integration slug for owner initiated installation |
| `CONDUCTOR_VERCEL_CLIENT_ID` / `CONDUCTOR_VERCEL_CLIENT_SECRET` | OAuth credentials for the Vercel integration connection |
| `CONDUCTOR_ENABLE_GITHUB_MUTATIONS` | Set to `1` to expose bounded GitHub write tools |
| `PORT` | HTTP port; defaults to `3000` |

On Vercel or another horizontally scaled deployment, also set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. `KV_REST_API_URL` and `KV_REST_API_TOKEN` are accepted compatibility aliases. `CONDUCTOR_REQUIRE_SHARED_OAUTH_STATE=1` can enforce the same fail-closed rule on any host. Mutation enablement fails closed unless durable Redis state and either complete GitHub App credentials or the transitional static token are configured. Supplying only one App credential variable is invalid. The Vercel connection flow always requires durable Redis. Register `<CONDUCTOR_PUBLIC_URL>/connections/vercel/callback` as the integration Redirect URL. Grant only the scopes used by the configured adapter: project/domain/deployment reads, team read for team audit, and deployment plus global project environment-variable write when those bounded mutations are enabled. Vercel's integration permissions apply to the installation's selected project reach; Conductor still requires an exact runtime binding and work scope for each write. Never place Vercel access tokens in runtime project bindings.

## Run and inspect

```bash
npm ci
npm run verify
npm start
```

Deploy behind HTTPS or build the included container. Confirm `/health`, both discovery documents, and the unauthenticated `/mcp` challenge before connecting ChatGPT. Then enable ChatGPT developer mode, add the public URL including `/mcp`, choose OAuth, complete owner sign-in and consent, review the discovered tools, and run `capabilities` followed by `preflight_project` for repository-development readiness or `preflight_operation` before an exact operation. Reauthorize with `conductor.write` before calling any mutation.

## Deliberate limits

- No anonymous or static shared-secret mode.
- No arbitrary shell, generic provider dispatch, force-push, or general repository-admin tool. Repository acquisition is limited to an exact public snapshot into an already-authorized empty destination and does not create/delete repositories or grant code-work scope. Exact branch cleanup is limited to already-integrated `work/*`, `repair/*`, or `audit/*` heads with an unchanged expected SHA, no open pull request, active repository work scope, and durable idempotency; protected/accepted branches and bulk cleanup are refused. `lifecycle.advance` now invokes that same exact cleanup proof after it integrates a work PR; cleanup failure is reported as deferred maintenance and does not invalidate a successful integration.
- Vercel writes are exact-project, idempotent, and gated; production traffic, production-variable changes, and historical-production deployment deletion require exact owner approval. Deployment cleanup is one exact terminal deployment at a time, never current production and never an active build. There is no bulk cleanup, delete-by-URL, alias mutation, or secret-value read tool.
- Vercel Integration API installation tokens do not expose the runtime-log endpoint in the published integration scope map. Report that lane as unavailable for connected installations; only an explicit direct Vercel access-token binding may attempt it, and direct-token preflight is not permission proof until an exact read succeeds.
- Pull-request creation remains bounded: ordinary proposals require `work/*` heads. The only accepted non-work proposal shapes are `preview`/`vercel-preview` → the provider-native repository default branch for promotion, and the exact provider-native default branch → `preview`/`vercel-preview` for ancestry reconciliation. Reconciliation preparation re-reads and records the exact current default/integration branch SHAs; merge still revalidates the live PR head/base before execution. Merge is separately bounded to pull requests with exact head/base SHAs. Integration merge rejects `main`, `master`, and the repository default branch. Preview reconciliation accepts only repository-default-branch → `preview`/`vercel-preview` for Main-only changes. Default-branch promotion accepts only an exact `preview`/`vercel-preview` candidate, requires a caller-supplied owner approval reference, and uses a merge commit; the runtime does not infer approval.
- Mutation operations are absent unless explicitly enabled with durable atomic idempotency state.
- No multi-agent, handoff, scheduler, or session subsystem is added here.

## DI-first source and CI evidence reads

Ordinary technical understanding remains in Development Intelligence. A development client should use DI to orient, search, inspect entities, understand dependencies, and narrow a change before requesting provider-native source bytes.

`source.artifact.read` exists only for the final exact handoff from DI evidence to a bounded edit. The caller supplies one exact immutable Git SHA and one repository-relative path. Conductor returns one complete UTF-8 artifact when it fits the configured bound; binary, non-file, incomplete, and too-large content are explicit results rather than partial source. This is not a repository browser, file search, code index, or architecture surface.

`ci.run.read` is the provider-native drill-down after `pull-request.status` reports an actionable workflow failure. The caller supplies the exact PR, expected head SHA, and workflow run ID. Conductor verifies those identities before returning jobs and steps. It returns bounded redacted tail logs for an exact job when requested, otherwise for at most three failed jobs. Logs are not archived by Conductor and no workflow mutation is exposed through this read.


## One-call development bootstrap

A fresh or resumed development conversation should prefer `work.bootstrap` over separately calling `work-scope.begin`, `capabilities`, and `development.status` when the tool is present. Additional repository code/deployment work should not be obtained by silently rebinding the active repository: `work-scope.request` creates a signed self-describing owner gate for an exact additional repository set, and `work-scope.approve` applies that grant only to the current signed work context after fresh `owner-approved:` approval. The `/work-scope` page remains a legacy/admin break-glass path. The bootstrap call establishes a new client-bound work context for the exact resolved repository and returns compact repository topology, workflow readiness, inspect preflight/work projection, Development Intelligence posture, bounded deployment posture, and the current runtime tool-catalog digest.

The workflow-readiness projection is intentionally provider-grounded. An existing `preview`/`vercel-preview` lane reports `ready`; a missing integration lane reports `setup-required` plus a self-describing `git.integration.bootstrap` owner gate tied to the exact current default-head SHA. A proven deployment binding reports `hosted-preview`; otherwise Conductor reports `repository-ci` as the currently available proof boundary without claiming the repository is intrinsically non-web or that hosted proof could never be required. Conductor never creates the integration branch automatically merely because provider write permission exists.

Clients should retain the returned `catalogDigest` only as ephemeral conversation context and echo it as `clientCatalogDigest` on a later bootstrap. A mismatch is reported as `stale-client-schema`; refresh or reconnect the client before concluding that a newly absent tool is not implemented. Exact `preflight_operation` remains authoritative for whether a visible operation can execute against one project.

Bootstrap also returns a short-lived HMAC-signed evidence handle bound to the authenticated client, exact repository, project referent, catalog digest, and observation time. When a Vercel project was proven during bootstrap, the handle also carries only non-secret project/team/repository identity plus the observed production target. `deployment.status`, `deployment.logs`, `deployment.runtime-logs`, and `deployment.env.list` may accept this handle to skip only the repeated Vercel project-identity lookup. Deployment lists/details, domains, runtime logs, environment metadata, credentials, and all mutation preconditions remain live provider reads. A stale local binding causes fresh authoritative project resolution instead of trusting the proof; invalid/expired/client-mismatched handles fail closed.


The runtime publishes both `catalogVersion` and `catalogDigest`. The digest includes the explicit catalog revision as well as exposed operation identities. Any MCP input/output schema change that matters to callers must bump `TOOL_CATALOG_VERSION`; this is deliberate so changing an existing tool schema cannot remain invisible merely because its operation name is unchanged.


## Repository audit and Wait Stewardship baseline

`repository.audit` is the read-only provider-facts audit surface commonly useful during optional Wait Stewardship and no-DI baseline development. It composes bounded GitHub topology, sampled active PR/check/workflow state, durable-work classification hygiene, inspect preflight, and configured Vercel posture in one model-visible call. Independent read lanes are executed concurrently where safe and partial provider gaps stay explicit.

Development Intelligence `audit_repository` is attached only as a separate semantic evidence plane when available. Conductor never converts DI findings into provider facts, rankings, mutation authority, or automatic implementation. Without DI, `repository.audit` still succeeds with the provider/source-control baseline when GitHub/work evidence is available.

The audit operation is strictly read-only. It does not create issues, mutate source, select work, or change the active Development OS referent. Routing a warranted audit finding remains a separate `route-work` mutation.


## ASC delegated-authority canary

The normal MCP path continues to use Conductor's existing OAuth authorization server. ASC authority is introduced in parallel rather than replacing that path in one step.

Set `CONDUCTOR_ENABLE_ASC_AUTHORITY_CANARY=1` only after configuring `CONDUCTOR_ASC_CONTROL_URL` and the existing `CONDUCTOR_ASC_BRIDGE_SECRET` to match ASC's service-bridge credential. When disabled, the delegated-authority routes return unavailable and the legacy MCP/OAuth workflow is unchanged.

The initial canary exposes only two internal service operations:
- `POST /internal/asc/authority/source-artifact-read`, which consumes an ASC delegation for `source.read` / `read`;
- `POST /internal/asc/authority/pull-request-comment`, which consumes an ASC delegation for `pull_request.write` / `mutate`, requires approval provenance, and still runs through Conductor work-scope and idempotent mutation execution.

The caller cannot provide a repository or select a capability/effect. Conductor obtains the exact GitHub repository from ASC's consumed delegation receipt and maps each fixed endpoint to one fixed capability/effect pair. A rejected, expired, replayed, or stale ASC delegation stops before provider execution and is never retried through Conductor's legacy OAuth authority. Returned authority receipts identify `source: asc` without echoing the opaque delegation handle or provider credentials.

This canary deliberately does not expose branch creation, commits, PR creation, merges, Preview reconciliation, Main promotion, deployment mutation, environment mutation, or generic operation dispatch.


## Preview completion, release batching, and Wait Stewardship

`lifecycle.advance` treats issue completion in Preview and release preparation as separate mechanics. Ordinary advancement integrates the exact work PR, attempts safe merged-head cleanup, and proves the exact Preview deployment. When Preview is READY it returns `stage: preview-ready` by default and does not create a Main PR. This lets multiple canonical issues accumulate into one coherent Preview release candidate.

Main preparation is explicit with `preparePromotion: true`. The caller may provide `promotionWorkItemNumbers` so the one Preview-to-Main promotion PR carries the exact canonical issue batch. Main remains a separate signed human gate; preparation never implies acceptance.

Every `external-wait` lifecycle gate includes the exact resume condition plus optional Wait Stewardship guidance. The primary referent remains active. Secondary stewardship is optional, bounded, non-conflicting, and separately authorized; Conductor does not select or execute secondary work itself.


### Sealed release candidates

Preparing Main now seals the release candidate in GitHub-native PR metadata. The promotion PR body records the exact Preview SHA, exact default-branch base SHA, and exact canonical work-item batch. The GitHub adapter can find the unique open Preview-to-Main candidate repository-wide and compares the live PR head/base to that seal.

While a sealed release candidate is open, ordinary lifecycle advancement does not integrate additional work into Preview. Complete or close the release first, or explicitly prepare a new release after the old candidate is closed. If Preview/Main move out of band and the live PR no longer matches the seal, lifecycle reports the candidate as stale and will not present a Main owner gate. This prevents a moving Preview branch from silently expanding a declared release batch.


### Iterative canonical work

One canonical issue may legitimately require multiple successive work-to-Preview pull requests as acceptance testing reveals follow-up gaps. `lifecycle.advance` treats multiple **merged** integration PRs as historical transport evidence for that durable work identity and continues to prove the current repository Preview head/deployment. Multiple **open** integration PRs remain a conflict because the next mutation target would be ambiguous. Merged transport never implies semantic issue completion.
