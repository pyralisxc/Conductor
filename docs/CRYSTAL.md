# Jarvis Conductor — Full Product / Technical Crystal

## Outcome

Create a development orchestration system that allows one developer to operate like the lead of a larger AI-assisted engineering team without becoming the coordination layer.

The system should preserve high-value conversational development context, automate continuation when no human input is needed, delegate bounded work to specialized workers, return delegated results to the correct warm owner, continuously integrate safe work into Preview, autonomously repair proven defects into Preview where authorized, stop for genuine founder/product/consequence gates, expose one coherent Owner Console, promote only an exact human-reviewed release candidate to `main`, and remain portable across web, Unity, local, cloud, and future agent providers.

## Ambition

An excellent realization should feel like an **intelligent development organization under explicit owner control**, not an issue tracker covered in AI buttons.

The owner should experience high autonomy without opacity, low interruption frequency but high intervention power, project composition rather than agent babysitting, durable continuity without giant permanent conversation context, provider flexibility, clear cost/usage visibility, explainable automated action, and easy movement between interactive reasoning and autonomous execution.

## Ownership boundaries

Conductor owns work lifecycle observation, owner/session affinity, continuation/wake decisions, delegated-worker routing, deterministic wait/event handling, Preview integration coordination, founder gate routing, release-candidate snapshot creation, owner-control projections, and orchestration telemetry.

It does **not** own product meaning, technical truth, source control, CI runtime, web deployment, or model internals.

## Stable conceptual contracts

- Project
- Work
- Session
- Worker
- Delegation
- Evidence
- Preview
- Gate
- Release
- Owner Policy
- Project Reality

Providers are replaceable implementations.

## Work ownership

The default owner of substantial ambiguous development work is a conversational session.

Delegation does not automatically transfer intellectual ownership.

A work item may be temporarily owned by Interactive Session, Autonomous Worker, Deterministic Automation, Human, or Waiting on Event.

## Turn vs session vs work

A turn is one model response.
A session is a warm conversational developer context spanning many turns and delegations.
A work item is durable project work and may outlive multiple sessions.

The end of a turn does not imply work completion or session replacement.

## Session affinity

Resume the current productive conversational session while a material frontier remains, no human judgment is needed, authorization still covers the work, and current context remains useful.

Rotate only for genuine saturation, context contamination, supersession, deliberate fresh eyes, objective separation, or a platform/session boundary.

## Source-control topology

```text
main
└── preview
    ├── work/*
    ├── repair/*
    └── audit/*
```

Work branches start from current `preview`, target `preview`, and integrate only after the appropriate change-level proof.

Preview is the integrated next-product reality.

`main` represents accepted product truth and never advances without explicit owner review.

## Release snapshot

```text
preview @ SHA
└── release/<candidate>
    └── reviewed PR -> main
```

Preview may continue evolving while the immutable release candidate is reviewed.

## Audit lane

Classify findings into Proven Repair, Product-Semantic Finding, Consequential Finding, or Insufficient Evidence.

Only Proven Repair may autonomously change Preview, and only when standing project policy permits it.

## Work creation

Work may originate from the founder, conversational development, audit, CI/runtime failure, autonomous workers, Development Intelligence findings, or Inspector/R&D.

Creating work does not authorize executing it.

## Operational state

Proposed → Shaping → Ready → Working → Preview → Promotion Ready → Done

`Needs Founder` is a gate state that may interrupt the flow.

DevOS Stage remains separate: Explore / Resolve / Crystallize / Build / Accept-Deliver.

## Human gates

- Founder semantics
- Consequential operation
- Experiential acceptance
- Integration conflict
- Main promotion

Routine engineering decisions should continue automatically.

## Preview manifest

Preview must answer: **What is different from main right now?**

Generate it from integrated work and PR metadata rather than asking every worker to edit one shared changelog file.

## Deterministic waiting

Do not pay model reasoning to wait for CI, deployments, review, scheduled retry, or worker availability.

The durable workflow runtime suspends and wakes intelligence when the world changes.

## Owner control

Top-level automation modes:

- Observe
- Assisted
- Preview Autonomous
- Hold

Owner may override at project, work-item, or action scope.

Emergency controls: Pause Project Automation and Pause All Automation.

## Provider architecture

Recommended initial stack:

- GitHub + GitHub App
- GitHub Actions
- Vercel Workflow / Vercel Preview
- DevOS 4.x
- Development Intelligence
- ChatGPT interactive development
- Work/Codex specialized operator
- self-hosted GitHub Actions runner later for Unity/local

## Experimental boundary

Automatic ordinary-consumer ChatGPT session resume/create is not treated as a guaranteed public API. A browser/operator bridge may be tested, but its failure must degrade to a small human resume action without losing development state.

## Battle-tested acceptance

Do not trust broad autonomy until `docs/BATTLE_TEST_PLAN.md` passes against the CardForge canary.

## Governing maxim

> **Automation should reduce the number of decisions the owner must make without reducing the owner's ability to see, understand, interrupt, redirect, or overrule the system at any moment.**
