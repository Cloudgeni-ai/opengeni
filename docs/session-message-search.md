# Full-history session message search

`GET /v1/workspaces/:workspaceId/session-message-search` is the additive,
authorized full-history Find endpoint. `searchSessionMessages(workspaceId,
request, { signal })` is available from both the ordinary SDK and its browser
entry. Wire schemas live in `packages/contracts/src/session-message-search.ts`;
SDK mirrors are checked for parity.

## Request and matching

The request takes `query` (1–200 UTF-16 code units), optional `sessionId`,
`archiveStatus` (`active`, `archived`, `all`; default `active`), `limit` (1–50;
default 20), and an opaque `cursor`. Whitespace is significant. The query is a
literal substring, not a regexp, SQL wildcard, token query, or relevance query.
Matching uses ECMAScript Unicode simple case folding (`iu`); it does not apply
locale-dependent lowercasing, Unicode normalization, or multi-character folding
(`ss` does not match `ß`). Every **non-overlapping occurrence** is returned.

Sources are durable, visible `user.message` text and full
`agent.message.completed` text. This includes code blocks and unloaded/old
history, but not tools, reasoning, `modelContext`, system updates, or session
titles. Use the existing session-list title/initial-message search separately
when those matches are wanted. Never-claimed human/API prompts and stale or
explicitly duplicate events are excluded, consistently with the conversation
reader. Provider-message repeats and the id-less final-settlement copy are
deduplicated within their turn; distinct provider message ids remain distinct.
For a repeated provider message id, the latest full completion wins, preventing
an earlier shorter completion from hiding later retained text.

**Completion-only assistant scope:** streaming/interrupted output retained only
as deltas is not searched. `turn.completed.output` is not searched again as a
duplicate answer. Clients should label the scope as user and completed assistant
messages, not promise recovery of delta-only text.

## Results, references, and counts

Each `matches` item contains `sessionId`, `sessionTitle` (nullable), `eventId`,
`sequence`, `turnId` (nullable), `role`, `messageId` (nullable),
`messageMatchOffset`, and `snippet: { text, matchStart, matchEnd }`.
Offsets are zero-based **UTF-16 code units in the original text**, and ends are
exclusive. `messageMatchOffset` addresses the entire visible message;
`matchStart`/`matchEnd` address the returned snippet. Snippet edges preserve
surrogate pairs. Use `(sessionId, eventId, messageMatchOffset)` as an occurrence
key. The per-session event sequence is the durable navigation reference;
provider `messageId` is supplemental and is not always present.

Ordering is session UUID ascending, then event sequence ascending, then match
offset ascending. This is stable traversal order, not relevance ranking.
`matchedMessageCount` and `matchedOccurrenceCount` are cumulative counts for this
traversal. `scannedMessages` counts distinct visited source messages, including a
large message still being scanned. `countIsExact` is true only at exhaustion.

This is a **live traversal, not a database snapshot**. Every page reapplies live
authority and archive filters. Concurrent appends, deletion, archiving, or
visibility changes require restarting the traversal for refreshed results and
counts; exhaustion does not certify a snapshot of mutable history. Cursors bind
workspace, subject, resolved host/agent scope, query, session filter, and archive
filter. They carry bounded positions/counts, not source message text. Counts
from a cursor are continuation bookkeeping, never authorization or billing
evidence. Invalid or changed-scope cursors return HTTP 400.

## Bounded scanning and cancellation

An empty page with `hasMore: true` is valid: keep requesting `nextCursor` while
displaying provisional counts/searching state. Never treat an empty page, page
size, or an arbitrary number of requests as complete. There is no overall
history cutoff.

Each request reads one batch of at most 33 message identities/bounded small
scalars, processes at most 32 message/scalar windows, returns at most 50 hits,
and yields a continuation after roughly 1.5 seconds of processing. SQL statements
have a five-second timeout, and AbortSignal checks run before/between reads.
In-flight database statements finish or hit that timeout; browser cancellation
does not promise instantaneous database cancellation. Authorization, transaction,
and RLS setup remain bounded per page, rather than per ordinary message.

Large scalars use the existing `session-event-slices` reader, including exact
lossless UTF-16 decoding for NUL, lone surrogates, and codec-marker collisions.
Overlapping windows and in-message occurrence cursors prevent truncated false
negatives and duplicate hits at window/page boundaries. PostgreSQL still has to
extract/detoast source scalars; large encoded messages are slower than ordinary
batched messages. This API is bounded in transfer and resumable work, not an
indexed-search latency guarantee.

Clients should cancel superseded searches with the SDK's third `{ signal }`
argument and retain only result snippets/cursors. Do not fetch or concatenate
complete history in the browser to implement Find. Old servers return an error;
the SDK never silently falls back to title search or local history scans.

## Selected-result context

Use the existing bounded `listEventPage` around the selected `sequence`, in two
directions if necessary, with `includeTypes: ["user.message",
"agent.message.completed"]` and `payloadMode: "summary"` for a visible-text
preview. Cursor/byte bounds on that reader remain authoritative. The search
preview must render **only `payload.text`** from those two event types: the
existing event reader also serves audits and can retain `modelContext` and other
fields even in summary mode. Do not stringify whole events/payloads into the
preview. Search itself never includes those fields. The search
snippet is the precise hit excerpt even when a legacy message is larger than
the ordinary event projection. Do not interpret a truncated context projection
as a complete message, or expect the match to be inside its prefix.

Search authorization is list-shaped even with `sessionId`: the normal live
grant plus complete host/agent list scope precedes SQL, and the subject RLS,
session-tenancy fence, member-removal fence, private-session policies,
Slack-private restrictions, and per-subject archive rules are reused. Reading
surrounding events separately uses the ordinary target-session authorization.

## Verification

`packages/db/test/session-message-search.test.ts` and
`apps/api/test/session-message-search.test.ts` require real PostgreSQL. They use
the shared Docker pgvector harness by default. In a sandbox without Docker,
`OPENGENI_SESSION_SEARCH_TEST_ADMIN_URL` may point at an explicitly disposable
native PostgreSQL/pgvector cluster: the narrow test helper creates an isolated
database, runs all migrations, provisions a distinct non-superuser application
role with the production FORCE-RLS grants, and removes its database/role on
completion. It never uses the admin role for application search assertions.