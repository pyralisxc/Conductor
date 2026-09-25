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

`preflight_operation` is narrower and preferred before one exact effect. It first proves that the operation is actually exposed by the current runtime, then aggregates operation-specific evidence from responsible providers. It does not discover project architecture or choose an operation.

Development Intelligence remains read-only. `DEVINT_MCP_URL` and `DEVINT_AGENT_TOKEN` connect Conductor to its authenticated MCP `project_status` operation. If they are absent, capability and preflight results explicitly report the adapter as unavailable.

An owner may connect a Vercel integration at `/connections/vercel` after Conductor owner sign-in. The connection stores a separate encrypted credential for each Vercel installation in Redis. A configured connection can inspect an unbound Vercel project when the request supplies an exact Git repository, the connected installation and its team (if present) are unambiguous, and exactly one provider project has matching GitHub linkage verified against project detail. Discovery stops after ten pages (up to 1,000 projects) and fails closed on incomplete or ambiguous results. This read path never creates a write binding or falls back to a server token. For writes, bind the repository to an exact Vercel project ID, the displayed installation ID, and its team ID (if a team installation). These may live in the existing `CONDUCTOR_PROJECTS_JSON` or the additive `CONDUCTOR_VERCEL_BINDINGS_JSON`, so a new project can be connected without replacing the existing runtime configuration. The additive variable accepts only `id`, `repository`, `vercelProject` (`prj_...`), `vercelConnectionId` (`icfg_...`), and optional `vercelTeamId` (`team_...`). Its repository must agree with an existing alias, if one exists; a conflicting Vercel or repository binding fails startup. A bound project's live GitHub linkage is checked before use. Conductor checks that the installation belongs to that team. Local disconnect deletes Conductor's credential immediately; uninstall in Vercel as well to revoke provider access. Rotating `CONDUCTOR_SESSION_SECRET` makes encrypted connections unreadable and requires reconnecting.

For a bound or uniquely linked read project, `deployment.status` reads the provider-native project, current production deployment, latest production attempt, recent deployments, source Git SHA/ref when available, and domains. `deployment.logs` reads bounded/redacted deployment-event output for one exact deployment. `deployment.audit` and `deployment.env.list` return bounded configuration and variable metadata without secret values. Exact redeploy, Git-source deploy, promote, rollback, deployment deletion, and environment-variable writes require an explicit project binding, durable mutation state, client write scope, active repository work scope, exact project/deployment or variable identity, and explicit production approval when applicable. Deployment deletion is limited to exact terminal deployments, refuses current production and active builds, and requires owner approval before removing a historical production rollback artifact. Environment values are write-only; receipts and idempotency state do not return or store recoverable secret values. Vercel remains authoritative for deployment state; Conductor does not persist a deployment ledger.

Runtime logs use Vercel's documented `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs` endpoint. Vercel's published Integration API scope mapping does not list this endpoint under any installable integration scope, and the connected installation returns `PERMISSION_DENIED` while ordinary deployment/environment reads succeed. Conductor therefore treats runtime logs as unavailable for installation-token bindings and does not repeatedly probe that known boundary. An explicitly configured direct Vercel access-token binding may use `deployment.runtime-logs`; its preflight remains degraded until one exact deployment read succeeds. `deployment.logs` continues to cover build/deployment events and is not presented as runtime output. Account usage/spend/budget data remain unavailable on this Hobby team; the audit returns the available plan and explicit partial coverage.

## Required configuration

| Variable | Meaning |
|---|---|
| `CONDUCTOR_PUBLIC_URL` | Stable public HTTPS origin for this runtime |
| `CONDUCTOR_OWNER_PASSWORD` | Private password used only for the single-owner authorization screen |
| `CONDUCTOR_SESSION_SECRET` | Random secret of at least 32 characters used through purpose-separated signing keys |
| `CONDUCTOR_OAUTH_ALLOWED_REDIRECT_ORIGINS` | Comma-separated redirect origins; defaults to `https://chatgpt.com` |
| `CONDUCTOR_GITHUB_ALLOWED_OWNERS` | Comma-separated GitHub owner namespaces Conductor may resolve dynamically |
| `CONDUCTOR_PROJECTS_JSON` | Compatibility name for optional runtime aliases, workspace bindings, and execution-policy overrides; not project metadata |
| `CONDUCTOR_VERCEL_BINDINGS_JSON` | Optional additive, exact Vercel project/repository/installation bindings for writes; never contains access tokens |
| `CONDUCTOR_GITHUB_APP_ID` | Numeric ID of the private Conductor GitHub App |
| `CONDUCTOR_GITHUB_APP_PRIVATE_KEY` | GitHub App PEM private key; multiline or `\\n`-escaped |
| `GITHUB_TOKEN` | Transitional least-privilege static token; ignored when App credentials are configured |
| `DEVINT_MCP_URL` | Development Intelligence MCP endpoint |
| `DEVINT_AGENT_TOKEN` | Separate machine bearer token for read-only DI access |
| `CONDUCTOR_VERCEL_TOKEN` | Optional server-side fallback Vercel token for bound provider operations; `VERCEL_TOKEN` is accepted as a fallback. Prefer an owner-connected installation |
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
- No arbitrary shell, generic provider dispatch, force-push, or repository-admin tool.
- Vercel writes are exact-project, idempotent, and gated; production traffic, production-variable changes, and historical-production deployment deletion require exact owner approval. Deployment cleanup is one exact terminal deployment at a time, never current production and never an active build. There is no bulk cleanup, delete-by-URL, alias mutation, or secret-value read tool.
- Vercel Integration API installation tokens do not expose the runtime-log endpoint in the published integration scope map. Report that lane as unavailable for connected installations; only an explicit direct Vercel access-token binding may attempt it, and direct-token preflight is not permission proof until an exact read succeeds.
- Merge is bounded to pull requests with exact head/base SHAs. Integration merge rejects `main`, `master`, and the repository default branch. Preview reconciliation accepts only repository-default-branch → `preview`/`vercel-preview` for Main-only changes. Default-branch promotion accepts only an exact `preview`/`vercel-preview` candidate, requires a caller-supplied owner approval reference, and uses a merge commit; the runtime does not infer approval.
- Mutation operations are absent unless explicitly enabled with durable atomic idempotency state.
- No multi-agent, handoff, scheduler, or session subsystem is added here.
