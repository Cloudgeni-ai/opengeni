# Canonical durable-learning router

The durable-learning router is the single decision and execution boundary for
all new durable learning writes. Explicit user-directed writes and autonomous
learning use the same contract and service. The router is **not** another
knowledge store, prompt authority, natural-language classifier, command parser,
or learning-policy engine.

Canonical implementation:

- wire contracts: `packages/contracts/src/durable-learning.ts`;
- deterministic planner and single-authority execution service:
  `packages/core/src/domain/durable-learning-router.ts`;
- append-only Postgres attempt/receipt ledger and exact live-attempt authority
  resolver: `packages/db/src/durable-learning-router.ts`;
- ledger schema and rolling migration:
  `packages/db/src/durable-learning-schema.ts` and
  `packages/db/drizzle/0193_durable_learning_router.sql`;
- current Workspace Memory authority adapter and legacy write integration:
  `packages/core/src/domain/durable-learning-memory-adapter.ts`.

Persistence and authority adapters implement the service ports. They may not
bypass or reinterpret the planner contract.

## One router, existing authorities

The caller supplies an explicit origin, requested scope, requested authority,
target surface, structured subject, immutable evidence references, and frozen
authority context. The router invokes at most one canonical authority adapter:

| Subject | Canonical surface |
| --- | --- |
| facts, decisions, observations, history | hierarchical Memory |
| preferences, procedures, working methods, skill guidance | Preference Registry |
| workspace charter, mandatory workspace context, workspace goals | workspace instruction-policy authority |
| organization identity, mission, products, customers, goals, constraints | company-profile authority |
| documents, connector content, transcripts | Documents/RAG evidence |

Documents and connector content remain evidence. They cannot become active
Memory, preference, charter, policy, or company-profile content merely because
they were ingested. Scoped-knowledge proposals remain inactive provenance, not
a competing mutation path.

The router rejects a subject/surface mismatch rather than silently moving the
write. `unspecified` scope, authority, or surface produces a deterministic
`clarification_required` receipt with an ordered field list. Natural-language
interpretation and command wiring are separately owned; this service never
guesses.

## Scope and initiating-human authority

Every non-migration attempt retains exact account, workspace, actor, immutable
initiating human, and optional session identity. An agent or service actor does
not become human authority. User scope must equal the immutable initiating
human; workspace, organization, role, session, and ephemeral scopes require an
exact frozen grant. Labels, collections, source ids, service identity, session
creator metadata, and provenance cannot widen scope.

The planner supports only scopes already owned by each canonical authority:

- Memory: workspace, initiating user, role, session, or ephemeral;
- Preference Registry: organization, workspace, or initiating user;
- instruction policy: workspace-global or exact role;
- company profile: organization only;
- Documents/RAG evidence: organization, workspace, or initiating user.

An unavailable authority fails closed with `SURFACE_NOT_AVAILABLE`. In
particular, company-profile storage and prompt composition remain separately
owned; until that adapter is installed, company-profile requests are auditable
rejections, not policy drafts or Memory fallbacks.

## Learning policy seam

The router consumes an already-resolved immutable learning-policy snapshot; it
does not implement policy storage or resolution. Autonomous learning:

- rejects when no snapshot exists or the mode is `off`;
- routes to proposal authority in `suggest` mode, even if active authority was
  requested;
- may retain active authority in `automatic` mode only when the frozen context
  also grants activation.

The separately owned autonomous evaluator/controller supplies confidence,
conflict analysis, the resolved snapshot, and evidence. It must call this
router rather than Memory, preference, policy, profile, or Documents mutation
services directly.

## Immutable attempts, receipts, and retries

`attemptId` is the durable operation identity. The input hash covers the exact
request plus frozen authority context. Reusing an attempt id with different
input is rejected. An exact replay returns the original immutable receipt and
does not invoke an authority adapter again.

The router records the immutable attempt before invoking the selected adapter.
A separate renewable execution claim excludes concurrent invocation for the
same pending attempt; it is coordination state, not learning authority or audit
history. A crashed executor's expired claim can be replaced, and the successor
retries the same attempt id. Every adapter receives that attempt id as its
operation identity and must converge a crash-gap retry without duplicating
authority state. A concurrent caller receives typed `ATTEMPT_IN_PROGRESS`
rather than invoking a second adapter. The terminal receipt records:

- deterministic route/rejection/clarification code and reasons;
- destination, resolved scope and authority, and learning-policy snapshot id;
- outcome and exact resource identity/version/status when a write occurred;
- effective boundary (`immediate`, `next_accepted_attempt`, or not applicable);
- rollback support and an opaque authority-owned rollback token.

Adapter/provider diagnostics do not become the public receipt. A failed write
receives `AUTHORITY_WRITE_FAILED`; canonical authority audit data remains in its
own ledger.

## Rollback

Rollback is a new immutable router attempt that references the original
completed attempt. The router retrieves the original receipt, uses only its
destination and opaque rollback token, and invokes the same authority adapter.
It never translates rollback into a write on another surface. Missing,
cross-scope, terminally unsupported, or adapter-less targets receive a
deterministic rejection.

Authority adapters preserve their native history semantics: Memory correction
or archival, Preference Registry correction/supersession lifecycle,
instruction-policy rollback activation events, company-profile revision
rollback when that authority supplies it, and evidence
revocation/supersession rather than destructive deletion.

## Compatibility and deliberate non-goals

Existing `memory_save` remains an active workspace Memory write. Its integration
uses origin `legacy_memory_save`; the router rejects any attempt to use that
origin for another surface, scope, or proposal mode. Legacy procedural or
preference-shaped Memory remains retrievable until a separate deterministic
promotion/supersession writes the Preference Registry; the router does not
rewrite historical Memory or create duplicate prompt injection.

This slice deliberately does not implement:

- learning-policy storage or resolution;
- autonomous evaluation/controller logic;
- natural-language parsing, new agent tools, or user-command wiring;
- company-profile storage, UI, snapshots, or prompt composition;
- prompt composition or duplicate suppression owned by later attempt-boundary
  work;
- a second Memory, Preference Registry, instruction-policy, company-profile, or
  Documents/RAG authority.
