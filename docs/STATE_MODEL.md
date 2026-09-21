# State Model

Conductor owns durable work-routing state and execution observations. Development OS owns development-process stage and active reasoning state. These are separate axes.

## Durable work item

The initial backing store is a GitHub Issue. Conductor normalizes three small dimensions.

### Lifecycle status

`backlog / ready / in-progress / blocked / review / done`

- **backlog** — durable work exists but is not selected for execution.
- **ready** — sufficiently understood to be selected into a work front.
- **in-progress** — implementation, investigation, or other active work is underway.
- **blocked** — progress currently depends on unavailable evidence, capability, approval, or another external condition.
- **review** — a candidate result exists and is awaiting verification, review, or acceptance.
- **done** — the durable obligation is closed.

GitHub encodes lifecycle with reserved `status:*` labels. A closed issue without a status label is read as `done`. Conflicting native state is reported as `unknown`; Conductor does not guess.

### Kind

`bug / feature / investigation / improvement / maintenance / operations / unknown`

Kind answers **what sort of durable work this is**.

GitHub encodes known kinds with reserved `kind:*` labels. Absence is `unknown`.

### Origin

`human / agent-audit / di-finding / ci / runtime / dependency / user-feedback / unknown`

Origin answers **what produced the durable signal**.

GitHub encodes known origins with reserved `origin:*` labels. Absence is `unknown`.

## Work item versus implementation candidate

A work item explains why durable work exists.

A branch/PR is an implementation or research candidate that may realize one or more work items. PR state, exact head/base SHAs, checks, reviews, and deployments are queried from GitHub; they are not copied into a second Conductor ledger.

Closing an issue records that the obligation is done. Accepted source, tests, provider state, and living documentation remain the authoritative result.

## Development OS stage

Development OS stage is not a work-item field:

`Explore / Resolve / Crystallize / Ready / Build / Accept-Deliver`

A work item may remain `backlog` while a conversation explores it, or become `ready` after Crystallization. Moving a work item to `in-progress` does not itself authorize Build. Provider capability and work status never substitute for Development OS authorization.

Returning an active referent from Build to Explore/Resolve/Crystallize suspends mutation for that referent even if its durable work item remains `in-progress`.

## Durable versus reconstructable state

Durable:

- provider-native issues and their normalized classification;
- branches, commits, PRs, reviews, checks, and releases;
- accepted source and living project documentation;
- authorization/approval records when the surrounding system persists them;
- Conductor execution receipts.

Reconstructable and normally **not** stored as another authority:

- the active conversational objective and frontier;
- temporary work fronts or issue groupings;
- a combined Work Envelope;
- automation suitability;
- current technical interpretation already available from Development Intelligence/provider state.

## Invariants

- Work status never substitutes for Development OS stage.
- Creating, classifying, or selecting work does not authorize execution.
- Provider capability never substitutes for authorization.
- `preview` is an integrated candidate, not production acceptance.
- Main promotion approval is bound to an exact candidate SHA.
- Unknown or conflicting classification remains explicit rather than being inferred from names or prose.
- Concrete task tracking belongs in the work-item system, not Markdown backlog files.
