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
  `packages/db/drizzle/0200_durable_learning_router.sql`;
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
not become human authority. A human actor must be that exact initiating human;
the router deterministically rejects a mismatched human actor before routing.
User scope must equal the immutable initiating human; workspace, organization,
role, session, and ephemeral scopes require an exact frozen grant. Labels,
collections, source ids, service identity, session creator metadata, and
provenance cannot widen scope.

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

- rejects every target surface, including Documents/RAG evidence, when no
  snapshot exists or the mode is `off`;
- routes mutable authorities to proposal authority in `suggest` mode, even if
  active authority was requested; Documents/RAG remains `evidence_only` after
  passing the same policy gate;
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
does not invoke an authority adapter again. A terminal compatibility replay is
read-only too: it loads the authority's immutable result snapshot and verifies
that its resource identity, version, and status still match the receipt rather
than calling a mutating adapter to reconstruct current state.

The router records the immutable attempt before invoking the selected adapter.
A separate renewable execution claim excludes concurrent invocation for the
same pending attempt; it is coordination state, not learning authority or audit
history. A crashed executor's expired claim can be replaced, and the successor
retries the same attempt id. Every adapter receives that attempt id as its
operation identity and must converge a crash-gap retry without duplicating
authority state. The current Memory adapter binds its write or rollback effect
and an immutable authority-result row to one RLS transaction under an
attempt-scoped advisory lock. A crash therefore commits both or neither; after
an uncertain response, the same attempt reads the stored result without a
second mutation. A concurrent caller receives typed `ATTEMPT_IN_PROGRESS`
rather than invoking a second adapter. The terminal receipt records:

- deterministic route/rejection/clarification code and reasons;
- destination, resolved scope and authority, and learning-policy snapshot id;
- outcome and exact resource identity/version/status when a write occurred;
- effective boundary (`immediate`, `next_accepted_attempt`, or not applicable);
- rollback support and an opaque authority-owned rollback token.

Adapter/provider diagnostics do not become the public receipt. A thrown adapter
error or claim-heartbeat failure is outcome-unknown because the authority may
already have committed. It never creates a false terminal failure receipt: the
immutable attempt remains pending, its claim prevents overlap until expiry, and
the caller retries the same attempt id. An adapter may expose a definitive
`AUTHORITY_WRITE_FAILED` receipt only when it can prove no authority effect
occurred; canonical authority audit data remains in its own ledger. Failure to
persist a terminal router receipt after a successful authority write or
rollback is also outcome-unknown, never proof that the authority effect failed.

## Rollback

Rollback is a new immutable router attempt that references the original
completed attempt. The router retrieves the original receipt, uses only its
destination and opaque rollback token, and invokes the same authority adapter.
Before invocation it reauthorizes the original initiating human, exact target
scope, resolved authority level, and current surface availability. A different
human cannot roll back another human's user-scoped write, and active-authority
rollback requires a current activation grant. The router never translates
rollback into a write on another surface. Missing, cross-scope, unauthorized,
terminally unsupported, or adapter-less targets receive a deterministic
rejection.

Authority adapters preserve their native history semantics: Memory correction
or archival, Preference Registry correction/supersession lifecycle,
instruction-policy rollback activation events, company-profile revision
rollback when that authority supplies it, and evidence
revocation/supersession rather than destructive deletion. The Memory rollback
adapter uses the rollback attempt id as its native operation identity, so a
post-effect retry returns the immutable archived result and cannot archive or
emit the authority effect twice.

## Compatibility and deliberate non-goals

Existing `memory_save` remains an active workspace Memory write. Its integration
uses origin `legacy_memory_save`; the router rejects any attempt to use that
origin for another surface, scope, or proposal mode. Legacy procedural or
preference-shaped Memory remains retrievable until a separate deterministic
promotion/supersession writes the Preference Registry; the router does not
rewrite historical Memory or create duplicate prompt injection.

Compatibility callers never mint a process-local random router id. First-party
MCP derives the id from the immutable logical turn and exact tool arguments;
the human REST path derives it from the authenticated subject and canonical
request payload. The compatibility helper also has a deterministic fallback.
Workspace Memory stamps the exact attempt/input identity onto a created or
in-place-updated resource and stamps supersession convergence evidence onto the
retired target. A retry can therefore reconstruct create, update,
insert-and-supersede, or dedupe-to-existing outcomes even when a short target id
became terminal after the first commit. The immutable authority-result snapshot
is the replay source of truth; those resource markers remain convergence and
audit evidence rather than a license to derive a different result from later
lifecycle state.

This slice deliberately does not implement:

- learning-policy storage or resolution;
- autonomous evaluation/controller logic;
- natural-language parsing, new agent tools, or user-command wiring;
- company-profile storage, UI, snapshots, or prompt composition;
- prompt composition or duplicate suppression owned by later attempt-boundary
  work;
- a second Memory, Preference Registry, instruction-policy, company-profile, or
  Documents/RAG authority.
