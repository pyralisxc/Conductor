# Build Roadmap

## Phase 0 — Repository spine
Domain types, policy engine, provider contracts, deterministic next-action logic, verification workflow, Crystal/docs.

## Priority foundation — Tool Runtime v0
Stable capability discovery, project preflight, normalized tool failures, execution receipts, and mutation idempotency. Establish this execution boundary before adding advanced orchestration, delegation, or session machinery.

## Phase 1 — GitHub kernel
Private GitHub App, webhook receiver, issue/PR adapter, branch manager, idempotent event ingestion, project policy.

## Phase 2 — Preview integrator
`ORCHESTRATION.md`, `preview` branch, work branches from Preview, Preview PRs, manifest generation, safe repair/revert.

CardForge becomes first canary.

## Phase 3 — Durable runtime
Vercel Workflow adapter, suspend on CI/deployment/review, event wakeups, retry/recovery, workflow history.

## Phase 4 — Owner Console read model
Mission Control, Project Cockpit, Founder Control Center, Preview Cockpit, Work Detail, Provider/Worker health.

Build real UI only after the read model has live data.

## Phase 5 — Development Intelligence
Project mapping, main/Preview diff, overlap/blast-radius hooks, degraded mode.

## Phase 6 — Worker adapters
Start with interactive-session representation, Work/Codex delegated operator, and deterministic GitHub Actions/local runner.

## Phase 7 — Experimental Chat bridge
Test resume/send-continue/create-successor behavior only after safe fallback exists.

## Phase 8 — Release flow
Immutable release branch, exact deployment, changelog, review package, explicit main promotion, main→Preview reconciliation.

## Phase 9 — Unity/local
Controlled Windows runner, Unity build/test/artifact integration, local safety boundaries.

## Phase 10 — Inspector economics
Tool/model/DI/CI/deployment telemetry, founder-rescue classification, orchestration bottleneck analysis.
