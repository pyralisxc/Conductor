# Conductor Agent Guide

This repository owns bounded development execution and durable work routing. It does not own project product truth, Development Intelligence semantics, Development OS methodology, Git hosting, or worker-model implementations.

## Non-negotiable boundaries

- Preserve provider-neutral domain contracts.
- GitHub is the initial durable work/source-control plane, not an irreplaceable architectural primitive.
- Development OS governs reasoning, stage validity, and authorization. Do not reimplement Development OS stages inside Conductor.
- Development Intelligence supplies technical project reality. Do not turn Conductor into another code-intelligence engine.
- Conversational sessions are useful working context but are not authoritative project truth.
- Durable unresolved obligations belong in provider-native work items, initially GitHub Issues.
- PRs describe implementation candidates; accepted source and living documentation describe what became true.
- Crystallization is a reasoning result, not a required `CRYSTAL.md` artifact. Reconcile durable meaning into the canonical living owner.
- Do not create status files, handoff ledgers, Markdown task lists, or parallel project-memory stores by default.
- `main` promotion always requires explicit owner approval of an exact candidate.
- Do not introduce a custom database merely for convenience.
- Do not make ordinary ChatGPT UI automation a hard dependency.
- Do not grant broad production credentials to ordinary development clients.
- Future automation must remain explainable and should be earned from repeated deterministic workflows rather than designed as a prerequisite.

## Source-control contract

Default:

```text
main
└── preview
    ├── work/<id>-<slug>
    ├── audit/<id>-<slug>
    └── repair/<id>-<slug>
```

Work originates from current `preview` and targets `preview`.

Promotion:

```text
preview @ exact SHA
└── work/promote-<candidate>
    └── PR -> main
```

`main` is never automatically promoted.

After promotion, reconcile accepted Main ancestry back into `preview` with the bounded exact-SHA reconciliation operation. Do not force-update Preview or use another squash for ancestry repair.

## Project integration

Each connected project may contain an `ORCHESTRATION.md` describing project-local branches, preview provider, audit policy, and human gates when those details are genuinely project-specific.

Project policy may specialize Conductor behavior but may not silently manufacture founder intent.

## Documentation discipline

Every durable fact should have one natural owner.

- Product identity belongs in product documentation.
- Work lifecycle belongs in `docs/STATE_MODEL.md`.
- Runtime API behavior belongs in `docs/TOOL_RUNTIME_V0.md`.
- Security and consequential gates belong in `docs/SECURITY_AND_GATES.md`.
- GitHub identity/permission behavior belongs in `docs/GITHUB_AUTHORIZATION.md`.
- Concrete future work belongs in the work-item system.
- Strategic direction may live in `docs/ROADMAP.md`, but it must not duplicate the issue backlog.

When exploration or Crystallization produces durable meaning, update the owning document/source/test and remove the temporary synthesis. Git history is the archive.

## Code discipline

- Prefer pure domain logic in `src/domain`; runtime/provider orchestration belongs behind typed runtime and provider contracts.
- Provider-specific APIs live behind interfaces in `src/providers`.
- UI projections, if any, consume domain/read models rather than raw provider payloads.
- Keep idempotency explicit for mutations.
- Prefer immutable event/result records over hidden mutable global state.
- Add tests for durable orchestration guarantees, not incidental implementation detail.

## Versioning philosophy

This repository is a provider-neutral execution core, not a commitment to every future orchestration idea.

Use real development evidence to evolve it. Prefer consolidation over new infrastructure whenever better reasoning over native artifacts can solve the problem.
