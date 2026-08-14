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

The successor accepts only existing canonical workspace claim/evidence IDs. It
does not ingest free-form text or register a model-facing tool. Four explicit
operations are supported:

1. propose a Knowledge claim;
2. propose a correction through an immutable `supersedes` relation;
3. propose an inactive workspace instruction charter/policy revision; and
4. propose an inactive workspace preference revision.

Admission locks the exact current session, turn, attempt, and execution
generation; derives the immutable initiating human; and rejects pending live
interruptions. A common append-only Knowledge review is the top-level durable
idempotency guard. All mutations occur under one outer transaction, and the
existing destination records remain the canonical audit history.

Instruction and preference proposals preserve the Knowledge change proposal
UUID as provenance and record a content-free service actor while retaining the
immutable causal human in the Knowledge audit chain. They cannot activate.
Instruction materialization also
requires an exact active-head baseline; migration 0247 verifies the Knowledge
proposal, workspace, target, status, and content hash at the database boundary.
Preference materialization is workspace-only and creates an untrusted inactive
proposal; its existing human lifecycle remains the only activation authority.
An immutable workspace-local destination receipt preserves operation/input and
preference/revision identities across later human lifecycle changes without
claiming permission-first selector or logical-turn context-receipt ownership.

## Explicit exclusions

- permission-first selector, accepted-boundary snapshot, recovery reuse, and
  logical-turn context-receipt ownership;
- Task-note storage or retrieval;
- generic `memory_save`, generic durable learning, or Memory promotion;
- personal or cross-workspace organization activation;
- implicit policy/preference activation or correction;
- workspace-learning-policy routing decisions;
- MCP/API/UI/export surfaces;
- deployment, release, provider, cloud, or production mutation.