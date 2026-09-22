# MCP runtime deployment

Conductor exposes its typed runtime through a stateless Streamable HTTP MCP endpoint at `/mcp`. The transport is deliberately thin: it registers the operations enabled by `ConductorToolRuntime` and returns each runtime receipt unchanged as structured content.

## Security boundary

All MCP requests require an OAuth 2.1 bearer token. The server validates the token signature, issuer, exact `/mcp` audience, expiry, stable client identity, and `conductor.read` scope. Mutation tools additionally require `conductor.write`. Conductor includes a deliberately small single-owner authorization server, adapted from the proven Development Intelligence deployment pattern. It supports owner sign-in, dynamic public-client registration, authorization code with PKCE S256, signed refresh tokens, and short-lived signed access tokens. It publishes protected-resource metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

Authorization-server discovery is published at `/.well-known/oauth-authorization-server`. The issuer is the exact stable Conductor origin and the resource audience is the exact stable `<origin>/mcp` URL.

Dynamic client registrations, access tokens, and refresh tokens are signed and stateless. Authorization codes remain five-minute, single-use records. A single-process deployment may keep those records in memory. Horizontally scaled hosts such as Vercel must configure Redis so authorization and token exchange can land on different instances without weakening one-time code consumption.

The `/health` endpoint is public and returns only runtime health and contract version. It exposes no project or provider details.

## Project authorization

`CONDUCTOR_GITHUB_ALLOWED_OWNERS` authorizes repositories under one or more GitHub owners without per-repository environment edits. Projects may be addressed as `owner/repository`; when exactly one owner is authorized, a bare repository name is also accepted. Cross-owner requests fail closed.

`CONDUCTOR_PROJECTS_JSON` supplies explicit aliases, workspace bindings, or per-project write policy. An explicit repository cannot be replaced by request input; mismatches fail with `CONFLICT`. Set `githubWrite` to `false` to deny mutations for an otherwise readable project.

Example:

```json
[
  {
    "id": "conductor",
    "repository": "pyralisxc/Conductor",
    "workspace": "/workspace/conductor"
  }
]
```

The preferred GitHub adapter identity is a private GitHub App. For each repository, Conductor discovers the covering installation, mints a short-lived token restricted to that repository, and verifies the effective permissions required by each operation. App-backed Develop readiness requires `contents:write`, `pull_requests:write`, and `issues:write`. Pull-request status additionally requires `checks:read` and `actions:read`; label updates require `issues:write`; merges require `contents:write`.

`GITHUB_TOKEN` remains a migration fallback. Repository-level `permissions.push` is not proof that a fine-grained token can perform every advertised Git Data, pull-request, or issue-comment mutation, so static-token write preflight is intentionally degraded rather than operation-verified.

The workspace adapter verifies readable/writable access, bounded Node process execution, and the presence of a package test script. Preflight does not execute the project's test suite. `inspect` requires repository read plus Development Intelligence, `develop` adds GitHub write, and `execute` adds workspace, shell, and tests.

Development Intelligence remains read-only. `DEVINT_MCP_URL` and `DEVINT_AGENT_TOKEN` connect Conductor to its authenticated MCP `project_status` operation. If they are absent, capability and preflight results explicitly report the adapter as unavailable.

## Required configuration

| Variable | Meaning |
|---|---|
| `CONDUCTOR_PUBLIC_URL` | Stable public HTTPS origin for this runtime |
| `CONDUCTOR_OWNER_PASSWORD` | Private password used only for the single-owner authorization screen |
| `CONDUCTOR_SESSION_SECRET` | Random secret of at least 32 characters used through purpose-separated signing keys |
| `CONDUCTOR_OAUTH_ALLOWED_REDIRECT_ORIGINS` | Comma-separated redirect origins; defaults to `https://chatgpt.com` |
| `CONDUCTOR_GITHUB_ALLOWED_OWNERS` | Comma-separated GitHub owner namespaces Conductor may resolve dynamically |
| `CONDUCTOR_PROJECTS_JSON` | Optional aliases, workspace bindings, and per-project overrides |
| `CONDUCTOR_GITHUB_APP_ID` | Numeric ID of the private Conductor GitHub App |
| `CONDUCTOR_GITHUB_APP_PRIVATE_KEY` | GitHub App PEM private key; multiline or `\\n`-escaped |
| `GITHUB_TOKEN` | Transitional least-privilege static token; ignored when App credentials are configured |
| `DEVINT_MCP_URL` | Development Intelligence MCP endpoint |
| `DEVINT_AGENT_TOKEN` | Separate machine bearer token for read-only DI access |
| `CONDUCTOR_ENABLE_GITHUB_MUTATIONS` | Set to `1` to expose bounded GitHub write tools |
| `PORT` | HTTP port; defaults to `3000` |

On Vercel or another horizontally scaled deployment, also set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. `KV_REST_API_URL` and `KV_REST_API_TOKEN` are accepted compatibility aliases. `CONDUCTOR_REQUIRE_SHARED_OAUTH_STATE=1` can enforce the same fail-closed rule on any host. Mutation enablement fails closed unless durable Redis state and either complete GitHub App credentials or the transitional static token are configured. Supplying only one App credential variable is invalid.

## Run and inspect

```bash
npm ci
npm run verify
npm start
```

Deploy behind HTTPS or build the included container. Confirm `/health`, both discovery documents, and the unauthenticated `/mcp` challenge before connecting ChatGPT. Then enable ChatGPT developer mode, add the public URL including `/mcp`, choose OAuth, complete owner sign-in and consent, review the discovered tools, and run `capabilities` followed by `preflight_project` in a fresh conversation. Reauthorize with `conductor.write` before calling any mutation.

## Deliberate limits

- No anonymous or static shared-secret mode.
- No arbitrary shell, generic provider dispatch, force-push, or repository-admin tool.
- Merge is bounded to pull requests with exact head/base SHAs. Integration merge rejects `main`, `master`, and the repository default branch. Preview reconciliation accepts only repository-default-branch → `preview`/`vercel-preview` and always uses a merge commit. Default-branch promotion requires a caller-supplied owner approval reference and exact candidate identity; the runtime does not infer approval.
- Mutation operations are absent unless explicitly enabled with durable atomic idempotency state.
- No multi-agent, handoff, scheduler, or session subsystem is added here.

