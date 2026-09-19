# Conductor

Conductor is the orchestration and owner-control layer for an AI-assisted development environment.

It does **not** replace the developer, DevOS, Development Intelligence, GitHub, or specialized workers. It connects them.

> **Keep intelligence warm, work durable, execution replaceable, Preview integrated, evidence explicit, and production human-controlled.**

## Core architecture

- **Developer / Founder** — decides what deserves to exist.
- **DevOS 4.x** — development cognition: Objective, Ambition, stage, authorization, Evidence Appetite, proof.
- **Development Intelligence** — compact, evidence-backed project reality.
- **GitHub** — durable repositories, issues, projects, PRs, checks, branches, releases.
- **Conductor** — observes state and decides what should happen next, who/what should do it, where it should run, and when intelligence should wake again.
- **Conversational developer** — preferred primary owner for ambiguous/deep development work.
- **Delegated workers** — bounded execution, browser/computer work, migrations, audits, local/Unity tasks.
- **Owner Console** — unified visibility and control across the system.

## Design principles

1. Preserve productive conversational context; resume before replacing.
2. A response ending is a **turn boundary**, not a work handoff.
3. Delegation does not automatically transfer intellectual ownership.
4. Deterministic waiting and polling should leave the model loop.
5. `main` is accepted product truth and is always human-promoted.
6. `preview` is the long-lived integrated next-product candidate.
7. Work branches start from and target `preview`.
8. A release candidate is an immutable snapshot of `preview`.
9. Automation may create work, but creating work does not authorize execution.
10. Owner control must remain visible, explainable, interruptible, and overridable.
11. Provider integrations are adapters; no provider should become the architecture.
12. No custom database in v0.1 unless real requirements force one.

## Recommended first stack

- GitHub + private GitHub App
- GitHub Actions
- Vercel Workflow / Vercel Preview for current web projects
- Development Intelligence
- DevOS 4.x
- ChatGPT interactive development
- Work/Codex for browser/computer/environment-heavy operations
- Self-hosted GitHub Actions runner later for Unity/local execution

See `docs/PROVIDERS.md` for alternatives and cost posture.

## Initial repository map

```text
.
├── AGENTS.md
├── ORCHESTRATION.example.md
├── docs/
│   ├── CRYSTAL.md
│   ├── TOOL_RUNTIME_V0.md
│   ├── OWNER_CONSOLE.md
│   ├── PROVIDERS.md
│   ├── STATE_MODEL.md
│   ├── SECURITY_AND_GATES.md
│   ├── BATTLE_TEST_PLAN.md
│   ├── ROADMAP.md
│   └── INITIAL_ISSUES.md
├── src/
│   ├── domain/
│   │   ├── types.ts
│   │   └── policy.ts
│   ├── providers/
│   │   ├── contracts.ts
│   │   └── runtime.ts
│   ├── runtime/
│   │   ├── types.ts
│   │   ├── errors.ts
│   │   ├── idempotency.ts
│   │   └── runtime.ts
│   ├── workflow/
│   │   └── decide-next.ts
│   ├── owner-console/
│   │   └── view-model.ts
│   └── index.ts
├── tests/
│   ├── policy.test.ts
│   └── decide-next.test.ts
└── .github/workflows/verify.yml
```

## Quick start

```bash
npm install
npm run verify
```

The initial code is intentionally a small provider-neutral core. It should be expanded only after the CardForge canary proves the first real integration needs.

## Tool runtime

The v0 runtime includes an authenticated Streamable HTTP MCP adapter, owner-scoped GitHub discovery with explicit project overrides, intent-aware preflight, a read-only Development Intelligence MCP adapter, and optionally enabled bounded GitHub mutations backed by durable idempotency state.

See `docs/TOOL_RUNTIME_V0.md` for the stable contract and `docs/MCP_RUNTIME.md` for deployment, OAuth, and ChatGPT connection requirements.

## Important current experimental boundary

Automatic creation/resumption of ordinary consumer ChatGPT conversations is **not** treated as a guaranteed API contract.

Conductor may later use an experimental browser/operator bridge, but the system must remain useful and safe when that bridge falls back to a small human resume action.

## Build order

Read:

1. `docs/CRYSTAL.md`
2. `docs/STATE_MODEL.md`
3. `docs/SECURITY_AND_GATES.md`
4. `docs/OWNER_CONSOLE.md`
5. `docs/INITIAL_ISSUES.md`

before expanding implementation.
