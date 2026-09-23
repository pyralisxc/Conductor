---
project: conductor
repository: pyralisxc/Conductor

branches:
  main: main
  preview: preview
  release_prefix: release/

preview:
  provider: vercel

main:
  human_approval_required: true

reconciliation:
  source: main
  targets: [preview]
  exact_sha_required: true
  merge_method: merge

audit:
  enabled: true
  default_evidence_appetite: representative
---

# Conductor orchestration policy

This file declares repository-local execution policy for Conductor. It must not become an inventory of project architecture, provider topology, or technical meaning.

It does not own product direction, current work, Development OS stage or authorization, technical truth, project/provider topology, or current provider state. Those remain with their canonical systems and provider/Development Intelligence evidence.

## Repository flow

- Ordinary development branches start from current `preview` and propose changes back to `preview`.
- `preview` is the integrated, deployable next-product candidate and is hosted on Vercel.
- `main` is accepted truth. Promotion requires explicit owner approval bound to the exact candidate.
- Promote the exact approved `preview` head to `main` with a merge commit, preserving Preview ancestry. Routine promotion needs no Main-to-Preview PR.
- Reconcile Main-only content changes into `preview` through `pull-request.merge.reconcile-preview` before continuing ordinary work. Reconciliation uses exact head/base identity and a merge commit. Do not force-update Preview.
- Current candidates, checks, deployments, and work status are queried from provider-native state rather than recorded here.

## Human gates

Conductor uses the global consequential gates in `docs/SECURITY_AND_GATES.md`. This repository adds no weaker local override.

Main promotion remains an exact owner gate even when the candidate has already passed Preview verification.
