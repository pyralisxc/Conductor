# State Model

## Work state
Proposed / Shaping / Ready / Working / Preview / Needs Founder / Promotion Ready / Done

## DevOS stage
Explore / Resolve / Crystallize / Build / Accept-Deliver

## Owner class
Interactive Session / Autonomous Worker / Deterministic Automation / Human / Waiting on Event

## Session state
Warm / Waiting / Human Gate / Rotation Candidate / Superseded / Retired

## Evidence appetite
Representative / Targeted / Exhaustive

## Automation mode
Observe / Assisted / Preview Autonomous / Hold

## Gate type
Founder Semantics / Consequence / Experiential Acceptance / Integration Conflict / Main Promotion

## Invariants

- Work state never substitutes for DevOS stage.
- Worker state never silently changes product authorization.
- Preview means integrated next-product candidate, not production acceptance.
- Promotion Ready still requires human approval.
- A delegated worker may finish while the parent conversational session remains the intellectual owner.
- Waiting is not an active reasoning state.
- Provider capability never substitutes for Dev OS authorization.
- Returning to Explore/Resolve/Crystallize suspends Develop and Preview-integration mutations for the affected referent.
- Standing authorization survives ordinary tool calls and status reports until expiry, revocation, completion, referent change, stage invalidation, or a consequential gate.
- Main promotion approval is bound to an exact candidate SHA.

## Shared Work Envelope

The typed Work Envelope is the reconstructable current projection shared across Dev OS, Conductor, and ASC. Its effective authorization is derived from a durable grant plus project/referent match, stage compatibility, exclusions, expiry, and any exact consequential approval.

The envelope is working state, not durable product truth. Durable authorization records and execution receipts remain independently auditable.
