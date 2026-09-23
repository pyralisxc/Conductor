# Provider Matrix and Cost Posture

> Pricing changes. Verify current pricing before committing spend. The architecture intentionally avoids depending on pricing assumptions.

## Primary initial providers

### GitHub
Role: source, branches, PRs, issues/projects, checks, webhooks, releases, GitHub App identity, Actions.

### Vercel
Role: web Preview/production deployments and initial durable Conductor workflow runtime. Conductor now has a bounded read-only deployment adapter for project/deployment status, source revision reconciliation, domains, and exact deployment-event logs. Vercel remains deployment authority; deploy/promote/rollback mutation is not part of the initial adapter.

### Development Intelligence
Role: technical project reality, graph/query evidence, overlap/blast-radius support, main↔Preview analysis.

### ChatGPT
Role: preferred interactive development surface.

### ChatGPT Work / Codex
Role: authenticated browser/admin work, computer use, software/environment operations, long mechanical delegation.

### GitHub self-hosted runner
Role: Unity, Windows, GPU, local/hardware execution.

## Optional adapters

- OpenAI Agents API
- GitHub Copilot
- Inngest
- Trigger.dev
- Cloudflare Workers / Durable Objects
- local model/worker

## Symphony

Use Symphony as a reference/specification for tracker-driven dispatch, isolated workspaces, retries, reconciliation, lifecycle hooks, and observability.

Do not make the experimental reference implementation a runtime dependency.

## Provider-selection rule

Use existing/native capability until a provider becomes a demonstrated limiter.

Conductor adapters are grouped by the semantic execution family they actually implement. GitHub implements source-control and durable-work families. Vercel implements the initial deployment-read family. Future database, artifact, deployment-mutation, or local-execution adapters should receive their own bounded families instead of implementing a generic project mutation interface.

Avoid provider sprawl.

## Initial fixed-cost goal

Aim for near-zero additional fixed infrastructure cost during the first CardForge canary when existing accounts already cover GitHub, ChatGPT, and Vercel.
