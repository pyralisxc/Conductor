# MCP runtime deployment

Conductor exposes its typed runtime through a stateless Streamable HTTP MCP endpoint at `/mcp`. The transport is deliberately thin: it registers `capabilities` and `preflight_project`, calls `ConductorToolRuntime`, and returns the runtime receipt unchanged as structured content.

## Security boundary

All MCP requests require an OAuth 2.1 bearer token. The server validates the token signature, issuer, exact `/mcp` audience, expiry, stable client identity, and `conductor.read` scope. Conductor includes a deliberately small single-owner authorization server, adapted from the proven Development Intelligence deployment pattern. It supports owner sign-in, dynamic public-client registration, authorization code with PKCE S256, signed refresh tokens, and short-lived signed access tokens. It publishes protected-resource metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

Authorization-server discovery is published at `/.well-known/oauth-authorization-server`. The issuer is the exact stable Conductor origin and the resource audience is the exact stable `<origin>/mcp` URL.

Dynamic client registrations, access tokens, and refresh tokens are signed and stateless. Authorization codes remain five-minute, single-use records. A single-process deployment may keep those records in memory. Horizontally scaled hosts such as Vercel must configure Redis so authorization and token exchange can land on different instances without weakening one-time code consumption.

The `/health` endpoint is public and returns only runtime health and contract version. It exposes no project or provider details.

## Project allowlist

`CONDUCTOR_PROJECTS_JSON` is the complete project allowlist. A request may supply an expected repository or workspace, but it cannot replace configured identity. Mismatches fail with `CONFLICT`; unknown project IDs fail with `NOT_FOUND`.

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

The GitHub adapter verifies repository access and project-specific push permission through GitHub's repository API. Write capability remains unverified in the global capability report until project preflight proves it.

The workspace adapter verifies readable/writable access, bounded Node process execution, and the presence of a package test script. Preflight does not execute the project's test suite.

Development Intelligence remains read-only. Until a real deployed adapter exists, both capability and preflight results explicitly report it as `TOOL_UNAVAILABLE`.

## Required configuration

| Variable | Meaning |
|---|---|
| `CONDUCTOR_PUBLIC_URL` | Stable public HTTPS origin for this runtime |
| `CONDUCTOR_OWNER_PASSWORD` | Private password used only for the single-owner authorization screen |
| `CONDUCTOR_SESSION_SECRET` | Random secret of at least 32 characters used through purpose-separated signing keys |
| `CONDUCTOR_OAUTH_ALLOWED_REDIRECT_ORIGINS` | Comma-separated redirect origins; defaults to `https://chatgpt.com` |
| `CONDUCTOR_PROJECTS_JSON` | Allowlisted project identities and targets |
| `GITHUB_TOKEN` | GitHub App installation token or other least-privilege token |
| `PORT` | HTTP port; defaults to `3000` |

On Vercel or another horizontally scaled deployment, also set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. `KV_REST_API_URL` and `KV_REST_API_TOKEN` are accepted compatibility aliases. `CONDUCTOR_REQUIRE_SHARED_OAUTH_STATE=1` can enforce the same fail-closed rule on any host.

## Run and inspect

```bash
npm ci
npm run verify
npm start
```

Deploy behind HTTPS or build the included container. Confirm `/health`, both discovery documents, and the unauthenticated `/mcp` challenge before connecting ChatGPT. Then enable ChatGPT developer mode, add the public URL including `/mcp`, choose OAuth, complete owner sign-in and consent, review the two discovered tools, and run `capabilities` followed by `preflight_project` in a fresh conversation.

## Deliberate limits

- No anonymous or static shared-secret mode.
- No arbitrary shell or provider dispatch tool.
- No mutation tools are exposed, so the in-memory idempotency store is not used by this service.
- Before any mutation operation is exposed, deployment must supply a durable atomic idempotency store.
- No multi-agent, handoff, scheduler, or session subsystem is added here.
