# Conductor Tool Runtime v0

## Outcome

Give every development client one stable, truthful execution contract before Conductor expands into advanced orchestration, delegation, or session machinery.

## Public tools

v0 exposes exactly two non-mutating tools:

- `capabilities()` reports the runtime operations, configured provider capabilities, access level, authentication state, and health actually available now.
- `preflight_project(project)` verifies repository access, GitHub read/write capability, workspace access, shell execution, test execution, and read-only Development Intelligence access.

No generic “do anything” tool exists.

## Contract

Every call returns a versioned execution receipt with:

- operation ID and operation name
- explicit target
- success or normalized failure
- start and finish timestamps
- diagnostics
- commit, branch, pull request, issue, comment, or workflow identifiers when relevant
- idempotency metadata for mutations

Normalized failures are:

- `AUTH_REQUIRED`
- `PERMISSION_DENIED`
- `TRANSIENT`
- `NOT_FOUND`
- `CONFLICT`
- `TOOL_UNAVAILABLE`
- `COMMAND_FAILED`

Provider exceptions do not escape as ambiguous client failures.

## Architecture

`ConductorToolRuntime` owns the stable facade and receipt boundary.

Provider adapters report real capability and preflight evidence. They do not change the runtime contract. Development Intelligence may implement only read/query capabilities.

The idempotency executor is internal infrastructure for future explicitly typed mutation tools. A mutation must claim an idempotency key and payload fingerprint before performing external work. A matching retry replays the original receipt; a different payload using the same key fails with `CONFLICT`.

The included in-memory idempotency store is suitable for tests and one-process development only. A deployed mutation runtime must supply a durable atomic store before exposing mutation tools.

## Intentionally absent

- generic shell or arbitrary provider dispatch
- branch, commit, push, PR, or comment mutation tools
- multi-agent workers or handoffs
- scheduling and durable waits
- session management
- a required MCP, HTTP, Vercel, or other transport
- a second source of project intelligence

Transports adapt this contract. They do not own it.

## Acceptance

- A fresh runtime instance can enumerate its exact public tools and configured environment capabilities.
- Project preflight always returns all required checks, including explicit unavailable or blocked results.
- Provider failures are normalized and visible.
- Receipts are stable and carry provider identifiers.
- Retrying the same mutation cannot repeat its side effect through the idempotency executor.
- Existing orchestration policy and tests remain intact.
