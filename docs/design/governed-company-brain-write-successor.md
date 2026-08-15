# Governed Company Brain write successor

Date: August 14, 2026

Requested disposition-audit base:
`90c0c3e4cc11081df8ce0230d0f2c36b4b883bbb`

Compatibility-rebase base used for this implementation:
`66a2eabe0796fc7e5aeb13dc8c660df81da22a69`

## Stale pull-request disposition

The successor does not modify or revive either stale pull request.

### PR #1312 (`1fe6a21fdf2615cf98e8856a9284bc27543ef3e9`)

Retained concepts:

- immutable operation identity plus canonical input hashing;
- exact retry convergence and changed-input conflict;
- destination-specific adapters rather than a shared active writer;
- public receipts that expose audit/resource identity without authority tokens;
- destination-owned lifecycle and review semantics.

Rejected or superseded concepts:

- a generic durable-learning writer;
- organization authority inferred from workspace-owner membership;
- personal or organization routing in this workspace-local slice;
- direct active preference/policy mutation;
- old migrations and the former preference attempt-mutation model;
- router-owned rollback tokens.

The exact-head review on that PR also found organization writes admitted through
workspace membership rather than exact account authority. None of that authority
model is carried forward.

### PR #1257 (`3ef33534d8d53925a6edc866510be045c4d2dd9e`)

Retained concepts:

- explicit structured destination intent;
- host binding of tenant and exact attempt authority;
- deterministic routing with no classifier;
- concise receipts and hidden internal operation details;
- no direct model call to destination stores.

Rejected or superseded concepts:

- generic `remember` or Memory routing;
- caller-selected personal/company scopes or active authority;
- dependency on a stale predecessor branch;
- automatic undo or active writes.

## Implemented bounded successor

The evidence-backed successor accepts only existing canonical workspace
claim/evidence IDs. The rooted Task-note path separately admits exact immutable
note bytes and never accepts caller replacement content. Seven explicit
operations are supported:

1. propose a Knowledge claim;
2. propose a correction through an immutable `supersedes` relation;
3. propose an inactive workspace instruction charter/policy revision; and
4. propose an inactive workspace preference revision;
5. promote an active rooted Task note into proposed workspace Knowledge;
6. atomically promote one into an inactive instruction-policy draft; and
7. atomically promote one into an inactive workspace preference.

Admission locks the exact current session, turn, attempt, and execution
generation; derives the immutable initiating human; and rejects pending live
interruptions. A common append-only Knowledge review is the top-level durable
idempotency guard. All mutations occur under one outer transaction, and the
existing destination records remain the canonical audit history.

Instruction and preference proposals preserve the Knowledge change proposal
UUID as provenance and record a content-free service actor while retaining the
immutable causal human in the Knowledge audit chain. They cannot activate.
Instruction materialization also
requires an exact active-head baseline; migration 0255 verifies the Knowledge
proposal, workspace, target, status, and content hash at the database boundary.
Preference materialization is workspace-only and creates an untrusted inactive
proposal; its existing human lifecycle remains the only activation authority.
An immutable workspace-local destination receipt preserves operation/input and
preference/revision identities across later human lifecycle changes without
claiming permission-first selector or logical-turn context-receipt ownership.
Migration 0260 repairs the released Knowledge-backed adapter predicates without
changing authority: instruction targets use the canonical global/role shape,
and the preference security-definer function binds its service actor through an
unambiguous local variable.

## Explicit exclusions

- permission-first selector, accepted-boundary snapshot, recovery reuse, and
  logical-turn context-receipt ownership;
- automatic Task-note discovery or prompt injection;
- generic `memory_save`, generic durable learning, or Memory promotion;
- personal or cross-workspace organization activation;
- implicit policy/preference activation or correction;
- workspace-learning-policy routing decisions;
- API/UI/export surfaces;
- deployment, release, provider, cloud, or production mutation.

## Follow-on learning-policy decision seam

The successor's proposal writer is now wrapped by a transport-neutral policy
router for derived scoped-Knowledge evidence. It loads the immutable
accepted-attempt learning-policy snapshot, derives the only legal source key
from the exact evidence id, and then resolves `off | suggest | automatic`.
`off` cannot reach the proposal writer. `suggest` creates the existing inactive
proposal. `automatic` creates that proposal and reports an activation request
for the destination authority, while truthfully retaining `activated=false`;
it does not bypass the human-only instruction/preference lifecycle. The
source-specific receipt omits unrelated source overrides.

The workspace-local completion adds explicit first-party proposal tools and
version-one active rooted Task-note promotion into proposed Knowledge. Migration
0258 stores only exact value-free note evidence and retains the note text as the
proposed fact value; another root, archived/expired note, or stale attempt is
denied. Its resolver additionally requires the exact accepted-attempt
learning-policy snapshot to permit `suggest` or `automatic`, and issues a
one-transaction evidence/claim capability that the insert trigger consumes.
The same trigger follows the admitted claim to its fact and requires the exact
note text plus the version-one source identity, so direct runtime DML cannot
attach Task-note provenance to unrelated content.
The direct instruction/preference promotion tools then materialize the exact
fact bytes into the existing inactive destination in that same outer
transaction. Their inputs select bounded target/descriptor metadata but contain
no content field. Concurrent exact retries converge, archived-note replay uses
immutable Knowledge lineage, and another task tree or changed input is denied.
This still does not add personal/organization routing, generic Memory, or active
authority.
