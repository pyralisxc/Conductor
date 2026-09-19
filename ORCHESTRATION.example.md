---
project: example-project

branches:
  main: main
  preview: preview
  release_prefix: release/

preview:
  provider: vercel
  automatic_integration: true

main:
  human_approval_required: true

audit:
  enabled: true
  default_evidence_appetite: representative
  proven_repairs_to_preview: true

workers:
  interactive_chat: true
  work_operator: true
  api_agent: false
  github_copilot: false

local_runners:
  - labels: [self-hosted, windows, unity]
---

# Project orchestration policy

This file specializes Conductor for one project.

It does not replace DevOS, project product truth, repository instructions, or Development Intelligence.

## Owner policy

- Proven ordinary repairs may integrate into Preview after appropriate proof.
- Product-semantic findings must stop at Shaping / Needs Founder.
- Main promotion always requires explicit owner approval.
- Production secrets are unavailable to ordinary Preview workers.

## Preview

Preview is the integrated next-product candidate and should remain deployable/inspectable.

## Human gates

Project-specific consequential operations should be listed here when they exceed the global defaults.
