# Durable Learning Confirmed-Write Router

The durable-learning router is the single domain boundary for a confirmed agent
attempt to write one of the governed durable authorities it supports. It does
not decide whether evidence deserves a change. A caller must first produce an
explicit, bounded request with `confirmation.state = "confirmed"`; the router
then validates the exact running attempt, chooses one authority from the typed
subject, records immutable input and outcome evidence, and applies the authority
mutation atomically with its receipt.

Migration `0205_durable_learning_router_ledger.sql` adds the immutable attempt
and receipt ledger. The public contracts live in
`packages/contracts/src/durable-learning.ts`, persistence and admission live in
`packages/db/src/durable-learning.ts`, and the canonical router plus authority
adapters live under `packages/core/src/domain/`.

## Accepted request authority

Every write and rollback request carries the exact:

- account and workspace;
- session and active turn;
- current execution-attempt UUID and execution generation;
- operation UUID;
- explicit confirmed state.

PostgreSQL admits the operation only while that session, turn, and execution
attempt are still the exact active accepted attempt, the turn remains in an
admissible nonterminal state, the execution attempt is claimed or running, and
no pending, delivered, or acknowledged interruption exists. It derives the
immutable initiating human from the turn and locks that human's current
workspace membership. Session creation metadata, a caller-supplied actor, an
agent identity, or provenance text is never substituted for initiating-human
authority.

The authority requirements are:

| Destination | Resolved scope | Required initiating-human authority |
| --- | --- | --- |
| Company profile, including `company_goal` | Organization | Exact workspace membership role `owner` |
| Workspace instruction policy | Workspace | `workspace:admin` |
| Preference Registry | Organization | Exact workspace membership role `owner` |
| Preference Registry | Workspace | `workspace:admin` |
| Preference Registry | User | The initiating human's own membership and derived personal scope |

The surrounding transaction retains the execution-attempt and membership locks
until the destination authority mutation and immutable receipt commit together.
A stale generation, replaced attempt, interrupted attempt, missing initiating
human, mismatched tenant, or insufficient authority fails closed before any
destination write.

Preference Registry writes retain `agent_attempt` as their execution principal;
they never spoof `human_session`. Its canonical lifecycle admits that principal
only while the exact transaction-local operation ID and input hash identify the
confirmed, unreceipted router attempt for the same tenant, initiating human,
surface, resolved scope, and write/rollback operation. Direct HTTP agent and
service governance remains denied, while lifecycle revision and event actor
provenance remains the immutable initiating human.

## Deterministic routing

`createDurableLearningRouter` parses the canonical contract and derives the
route; callers cannot select an arbitrary destination:

| Subject | Destination authority | Scope |
| --- | --- | --- |
| Company identity, mission, product, customer, goal, or constraint | Company profile | Organization |
| `workspace_instruction` with an exact charter/policy target | Workspace instruction policy | Workspace |
| Preference create or correct | Preference Registry | Requested organization, workspace, or user scope |

Repeatable company-profile entries, including company goals, require their
normalized stable key. Company goals remain profile entries and never create or
modify session goals. Preference correction is always an active lifecycle
mutation; it cannot be represented as a proposal.

`activation = "proposal"` creates only an inactive authority revision where the
destination supports proposals. `activation = "active"` uses the destination's
existing lifecycle operation and conflict/CAS checks. The router does not write
authority tables directly and does not create a parallel profile, instruction,
or preference store.

## Immutable input, idempotency, and atomicity

The complete operation ID, execution authority, routed request, and route
decision are recursively key-sorted into canonical JSON. Arrays retain their
semantic order, `undefined` object members are absent, the input is bounded to
524,288 UTF-8 bytes, and SHA-256 binds the stored canonical bytes. PostgreSQL
recomputes the digest and the canonical JSON shape independently.

`durable_learning_attempts` and `durable_learning_attempt_receipts` are
append-only, `FORCE ROW LEVEL SECURITY` tables. Runtime SQL receives `SELECT`
only; mutation triggers reject updates and deletes. The target-schema-local
`SECURITY DEFINER` begin and complete functions are the only runtime ledger
writers.

An exact retry of the same operation and canonical input returns the existing
receipt without another authority mutation. Reusing an operation UUID for any
changed tenant, execution authority, subject, route, or other input is rejected.
Concurrent identical attempts serialize on the exact execution attempt and
converge on one authority mutation and one receipt.

The begin function marks only its surrounding transaction as admitted. Receipt
completion requires that transaction-local marker plus the exact operation and
input hash, so a standalone or later completion call cannot manufacture a
receipt. The authority callback and receipt insert run in the same database
transaction: an authority failure rolls back the attempt row, destination
mutation, and receipt together. A deferred constraint also rejects commit of a
new attempt without its exact immutable receipt, so even a lower-level caller
cannot commit an admitted destination mutation while skipping completion.

## Receipts, visibility, and effective boundary

Every successful attempt returns one immutable receipt containing:

- attempt UUID and input hash;
- `write` or `rollback` operation;
- `applied`, `proposed`, or `rolled_back` outcome;
- destination resource identity, version, and status when applicable;
- `effectiveBoundary = "next_accepted_attempt"`;
- opaque rollback support and token metadata;
- transaction timestamp.

Ledger reads remain account/workspace RLS-scoped. Rollback first reads the exact
target receipt, verifies its destination and opaque token, preserves the target
attempt's immutable initiating-human provenance, and delegates to that same
authority's rollback lifecycle. Rollback never edits the target attempt,
receipt, authority revision, or activation event. It creates a new immutable
router attempt and a new authority lifecycle event. Proposal receipts and
first-activation instruction-policy writes without a prior head may correctly
report rollback as unsupported.

Writes become prompt-effective only at the next accepted-attempt snapshot. A
running or recovering attempt never changes its already-frozen company profile,
instruction policy, or preference descriptor context.

## Deliberate exclusions

This slice does not implement:

- evidence evaluation, confidence scoring, or an automatic learning controller;
- automatic enforcement of workspace learning-policy mode;
- a session command, model tool, MCP tool, HTTP route, SDK method, or UI;
- Memory writes, Documents/RAG ingestion, scoped-knowledge mutation, or session
  goal mutation;
- source connectors, Slack notifications, or background learning;
- a new prompt composer or destination lifecycle.

Workspace learning policy remains the immutable policy input for a separately
authorized evaluator/controller. Such a controller must resolve the accepted
policy snapshot and destination scope before it invokes this router; neither the
policy domain nor source evidence can bypass the router or a destination
authority's existing lifecycle.
