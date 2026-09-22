# Product Direction

This document owns strategic direction only. It is not a backlog.

Concrete obligations, bugs, investigations, and implementation tasks belong in Conductor work items backed by provider-native issues.

## Current foundation

Conductor is a headless, provider-neutral execution and durable work-routing layer.

The current foundation includes:

- private GitHub App identity and repository-scoped permission evidence;
- capability discovery, repository-development preflight, and exact operation-scoped preflight;
- bounded branch/commit/PR operations with idempotent receipts;
- exact-SHA Preview integration and explicit Main promotion;
- read-only Development Intelligence preflight;
- GitHub Issue-backed work items with normalized status, kind, and origin;
- hosted MCP/OAuth access.

This foundation should remain useful without scheduling, autonomous task selection, or a separate control-plane database.

## Near-term direction — context compression

Make ordinary human-directed development require less restatement and less provider-payload interpretation.

High-value areas include:

- the initial `development.status` query-time projection for inspect readiness, active work, and native candidate evidence;
- further compression of PR/check/deployment summaries;
- useful work-item querying across status, kind, and origin;
- natural issue ↔ PR relationships without duplicating their state;
- better reconstruction of “what can I work on now?” from native artifacts.

Prefer query-time reconstruction over another persistent state layer.

## Native work first

Use real work items for future Conductor development instead of maintaining a Markdown issue set.

Repeated usage should teach us:

- which issue kinds commonly belong together;
- which origins produce reliable deterministic repairs;
- which acceptance patterns are stable;
- where humans still supply product meaning or consequential approval.

That evidence, not an up-front automation taxonomy, should shape later workflow compression.

## Selective automation later

Do not build schedulers, automatic assignment, autonomous backlog selection, or unattended development loops merely because the provider APIs permit them.

Automation becomes justified only when a repeated lane is:

- sufficiently deterministic;
- reconstructable from durable evidence;
- bounded in consequence;
- easy to interrupt and explain;
- proven useful through human-directed operation first.

Automation eligibility should be derived from work/evidence history rather than stored as a manually maintained work-item field.

## Control surfaces are consumers

Chat remains the primary human interaction surface for now.

A future owner/control UI may become valuable for many simultaneous workers, approval queues, scheduled processes, drift alerts, or portfolio operations. If that need emerges, the UI should consume Conductor/DI/provider truth rather than become another source of truth.

## Provider and environment portability

Keep the execution domain independent of GitHub, Vercel, ChatGPT, or a particular worker implementation. Provider-neutral execution must not become a duplicate model of product/project architecture.

Add provider/runtime adapters only where an external system owns real technical state or execution capability. New adapters should integrate through exact operation capability/preflight contracts and the narrow semantic family they actually implement (for example source-control, database, deployment, or artifact execution), rather than a generic provider interface or persistent project-topology model.

Local/Unity execution can be added when a concrete workflow requires it; it should not expand the core state model in advance.

## Governing direction

> **Grow capability while shrinking the amount of architecture humans and agents must understand. Prefer native integration plus stronger reasoning over additional persistent infrastructure.**
