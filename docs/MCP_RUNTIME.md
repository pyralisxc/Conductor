# MCP runtime deployment

Conductor exposes its typed runtime through a stateless Streamable HTTP MCP endpoint at `/mcp`. The transport is deliberately thin: it registers `capabilities` and `preflight_project`, calls `ConductorToolRuntime`, and returns the runtime receipt unchanged as structured content.

## Security boundary

All MCP requests require an OAuth 2.1 bearer token. The server validates the token signature, issuer, exact `/mcp` audience, expiry, stable client identity, and `conductor.read` scope. It publishes protected-resource metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

The configured authorization server must support the MCP OAuth requirements used by ChatGPT, including authorization code with PKCE and an appropriate ChatGPT client registration mode. Conductor is the resource server; it does not implement or embed an identity provider.

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
| `CONDUCTOR_OAUTH_ISSUER` | Exact JWT issuer and OAuth authorization-server base URL |
| `CONDUCTOR_OAUTH_JWKS_URL` | JWKS endpoint used to verify access tokens |
| `CONDUCTOR_PROJECTS_JSON` | Allowlisted project identities and targets |
| `GITHUB_TOKEN` | GitHub App installation token or other least-privilege token |
| `PORT` | HTTP port; defaults to `3000` |

## Run and inspect

```bash
npm ci
npm run verify
npm start
```

Deploy behind HTTPS or build the included container. Test `/mcp` with MCP Inspector using a valid OAuth access token. Then enable ChatGPT developer mode, add the public URL including `/mcp`, review the two discovered tools, and run `capabilities` followed by `preflight_project` in a fresh conversation.

## Deliberate limits

- No anonymous or static shared-secret mode.
- No arbitrary shell or provider dispatch tool.
- No mutation tools are exposed, so the in-memory idempotency store is not used by this service.
- Before any mutation operation is exposed, deployment must supply a durable atomic idempotency store.
- No multi-agent, handoff, scheduler, or session subsystem is added here.
