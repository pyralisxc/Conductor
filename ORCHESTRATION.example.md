---
project: example-project

branches:
  main: main
  preview: preview
  release_prefix: release/

preview:
  provider: vercel

main:
  human_approval_required: true

audit:
  enabled: true
  default_evidence_appetite: representative

local_runners:
  - labels: [self-hosted, windows, unity]
---

# Project orchestration policy

This file specializes Conductor for one project.

It does not replace Development OS, project product truth, repository instructions, or Development Intelligence.

## Owner policy

- Ordinary development targets Preview through explicit bounded work.
- Product-semantic findings require human reasoning before mutation.
- Main promotion always requires explicit owner approval of an exact candidate.
- After accepted promotion, Main ancestry is reconciled back into Preview with the bounded reconciliation operation.
- Production secrets are unavailable to ordinary Preview execution identities.

## Preview

Preview is the integrated next-product candidate and should remain deployable and inspectable.

## Human gates

Project-specific consequential operations should be listed here when they exceed the global defaults.
