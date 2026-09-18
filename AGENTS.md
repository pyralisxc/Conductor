# Jarvis Conductor Agent Guide

This repository owns development orchestration and owner control. It does not own project product truth, Development Intelligence semantics, DevOS methodology, Git hosting, or worker-model implementations.

## Non-negotiable boundaries

- Preserve provider-neutral domain contracts.
- GitHub is the initial durable work/source control plane, not an irreplaceable architectural primitive.
- DevOS governs reasoning and authorization. Do not reimplement DevOS stages inside Conductor.
- Development Intelligence supplies project reality. Do not turn Conductor into another code intelligence engine.
- Conversational sessions are valuable hot reasoning caches but are not authoritative project truth.
- Resume a productive conversational session before rotating it.
- Delegated workers must carry a parent/return address when they are not the intellectual owner.
- Deterministic waiting should not consume model reasoning.
- `main` promotion always requires explicit owner approval.
- Preview automation may be broad; production automation may not infer approval.
- Do not introduce a custom database in v0.1 merely for convenience.
- Do not make ordinary ChatGPT UI automation a hard dependency.
- Do not grant broad production credentials to ordinary workers.
- Owner actions and automation decisions must remain explainable.

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
└── release/<candidate>
    └── PR -> main
```

`main` is never automatically promoted.

## Project integration

Each connected project may contain an `ORCHESTRATION.md` describing project-local branches, preview provider, worker capabilities, audit policy, and human gates.

Project policy may specialize Conductor behavior but may not silently manufacture founder intent.

## Code discipline

- Prefer pure domain logic in `src/domain` and `src/workflow`.
- Provider-specific APIs live behind interfaces in `src/providers`.
- UI projections consume domain/read models rather than provider payloads.
- Keep idempotency explicit for webhook-triggered mutations.
- Prefer immutable event/result records over hidden mutable global state.
- Add tests for durable orchestration guarantees, not incidental implementation detail.

## Versioning philosophy

This initial repository is the product skeleton, not a commitment to every provider decision in perpetuity.

Use real CardForge canary evidence to evolve the system.
