# Conductor

Conductor is the provider-neutral bounded execution and durable work-routing layer for a human-directed AI-assisted development environment.

It does **not** own product meaning, technical truth, development methodology, Git hosting, or the user's active reasoning context. It receives execution intent/referents from upstream reasoning and gives development clients a stable way to inspect capability, route durable work, perform bounded provider actions, and preserve exact execution receipts.

> **Keep work native, effects bounded, evidence explicit, and production human-controlled.**

## Core architecture

- **Developer / Founder** — decides what deserves to exist and approves consequential boundaries.
- **Development OS** — owns the active objective, product-development stage, authorization referent, reasoning continuity, and handoff boundary.
- **Development Intelligence** — owns read-only technical evidence and project understanding.
- **GitHub** — initial durable home for repositories, issues, PRs, checks, branches, releases, and history.
- **Conductor** — normalizes execution capability, durable work routing, bounded mutation, Preview integration, and execution receipts without inventing project architecture.
- **Chat / development clients** — primary human interaction surface; they reason over durable project artifacts instead of requiring a separate Conductor memory system.
- **Future control surfaces** — optional consumers of Conductor state when real automation or portfolio-operation needs justify them; they are not a prerequisite for the core system.

## Design principles

1. Prefer native durable provider artifacts before inventing another state store.
2. GitHub Issues hold durable unresolved work; PRs hold implementation candidates; source and living docs hold accepted product truth.
3. Conductor normalizes work lifecycle, kind, and origin without replacing the provider-native artifact.
4. Creating or classifying work does not authorize executing it.
5. `preview` is the long-lived integrated candidate; `main` is accepted truth and requires explicit owner promotion.
6. Provider capability, session authorization, and consequential approval are separate facts.
7. Provider integrations are adapters; no provider should become the architecture.
8. No custom database merely for convenience. Add infrastructure only when native artifacts plus reasoning cannot represent something important.
9. Automation is deferred until repeated real usage identifies deterministic, low-consequence lanes. Automation eligibility is derived, not a work-item field humans maintain.
10. Crystallization is a reasoning outcome, not a mandatory repository artifact. Reconcile durable meaning into its canonical living document and discard temporary synthesis.
11. Concrete future obligations belong in the work-item system, not Markdown task lists.
12. Git history preserves prior documentation states; do not keep superseded meta-documents as parallel truth.

## Current stack

- GitHub + private GitHub App
- GitHub Actions
- Vercel for the hosted MCP runtime
- Development Intelligence
- Development OS
- ChatGPT / compatible development clients

See `docs/PROVIDERS.md` for provider alternatives and cost posture.

## Documentation ownership

Use the smallest living owner for each kind of durable truth:

- `README.md` — product identity, current architecture, and repository entry point.
- `AGENTS.md` — project-local operating rules for development agents.
- `ORCHESTRATION.md` — Conductor repository-local branch, Preview-provider, reconciliation, and human-gate specialization.
- `docs/STATE_MODEL.md` — normalized durable work state and its boundary with Development OS stage.
- `docs/TOOL_RUNTIME_V0.md` — public Conductor runtime/tool contract.
- `docs/GITHUB_AUTHORIZATION.md` — GitHub identity, permissions, authorization boundaries, and exact promotion semantics.
- `docs/SECURITY_AND_GATES.md` — security invariants and consequential human gates.
- `docs/MCP_RUNTIME.md` — hosted MCP/OAuth deployment contract.
- `docs/PROVIDERS.md` — replaceable provider choices.
- `docs/BATTLE_TEST_PLAN.md` — bounded canary/verification strategy.
- `docs/ROADMAP.md` — strategic product direction only; concrete tasks belong in work items.

Do not create `CRYSTAL.md`, status diaries, handoff ledgers, or Markdown backlogs by default. A temporary crystallized contract may live in the active conversation, issue body, or PR description until its durable parts are reconciled into the owners above.

## Durable work routing

GitHub Issues are the initial backing store for provider-neutral Conductor work items.

Lifecycle status:

- `backlog`
- `ready`
- `in-progress`
- `blocked`
- `review`
- `done`

Kind:

- `bug`
- `feature`
- `investigation`
- `improvement`
- `maintenance`
- `operations`

Origin:

- `human`
- `agent-audit`
- `di-finding`
- `ci`
- `runtime`
- `dependency`
- `user-feedback`

Missing or conflicting classification is reported as `unknown`; Conductor does not guess.

An issue may begin as a sparse observation and mature through research. When known, a useful issue body can capture Problem, Desired outcome, Evidence, Constraints, and Acceptance. Those sections are guidance, not a required schema.

## Source-control flow

Default development topology:

```text
main
└── preview
    ├── work/*
    ├── audit/*
    └── repair/*
```

Work starts from current `preview` and targets `preview`.

Main promotion is a separate exact-candidate operation. A release/promotion proposal never implies approval.

After a successful squash-style Main promotion, accepted Main ancestry is reconciled back into `preview` with an exact-SHA merge commit. Reconciliation never targets production and never substitutes for Main approval.

## Quick start

```bash
npm install
npm run verify
```

## Tool runtime

The v0 runtime includes an authenticated Streamable HTTP MCP adapter, owner-scoped GitHub discovery, intent-aware preflight, compact query-time development/work status reconstruction, a read-only Development Intelligence adapter, durable issue-backed work routing, and bounded GitHub mutations backed by durable idempotency state.

The preferred GitHub identity is a private GitHub App that mints repository-scoped installation tokens and proves operation-specific permissions. Static tokens remain an explicitly degraded migration path.

See `docs/TOOL_RUNTIME_V0.md`, `docs/GITHUB_AUTHORIZATION.md`, and `docs/MCP_RUNTIME.md` for the current contracts.

## Current boundary

Conductor does not schedule development, automatically assign agents, generate product objectives, or autonomously continue ordinary consumer ChatGPT sessions.

Those capabilities may be considered later only where real usage demonstrates that the underlying work is deterministic, reconstructable, and safe enough to justify automation.
