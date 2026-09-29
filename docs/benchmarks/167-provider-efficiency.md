# Conductor Provider-Efficiency Acceptance Benchmark

Parent work: #167  
Benchmark work item: #206

## Immutable baseline

Pre-composite revision: `071dd47f824d296f4622cf13f9ae72e68afd2fb7`.

At that revision Conductor exposed `development.status` and individual provider/read/mutation tools, but did not expose `work.bootstrap`, `evidence.bundle`, `lifecycle.advance`, or `lifecycle.resume`. Baseline comparisons must therefore distinguish source-derived model-round-trip facts from metrics that were not instrumented at the time.

## Post-v9 fresh-agent bootstrap

Production/Main revision: `dd93bebd61f5ab3f73c6e4e2e058276b4578e545`.

Measured clean sample after rematerializing the exact-Main Development Intelligence graph:

| Metric | Result |
| --- | ---: |
| elapsed | 4,774 ms |
| GitHub calls | 26 |
| GitHub duplicate reads | 2 |
| Vercel calls | 4 |
| Vercel duplicate reads | 0 |
| Development Intelligence calls | 1 |
| Development Intelligence duplicate reads | 0 |
| inspect preflight | ready |

The sample was produced by one model-visible `work.bootstrap` call. The provider counters are operation-local deltas; no measurement-only network request is added.

## Lifecycle samples

This benchmark work item intentionally supplies the remaining two real workflows:

1. its exact work branch → Preview lifecycle will record the `lifecycle.advance` elapsed/providerUsage result;
2. after a fresh human Main approval, its signed Preview → Main continuation will record the `lifecycle.resume` elapsed/providerUsage result.

Those results are recorded on the durable issue receipts/comments after each transition rather than predicted in advance.

## Interpretation rules

- Never report unknown response bytes as zero traffic.
- Do not invent pre-v9 provider counters that did not exist.
- Compare model-visible round trips against the immutable pre-composite tool surface separately from measured v9 provider deltas.
- Human Main approval remains a separate authority boundary; instrumentation does not weaken it.
- ASC/provider sign-in authorization remains separate from the human Main gate.
