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

For the workspace picker, optionally pass `groupBy: "session"`. This returns
only the first occurrence in the first matching message of each session, then
skips that session's remaining occurrences and messages, including history not
yet loaded by the scanner. The next cursor advances past the entire matching
session, so one prolific message cannot flood the picker with repeated pages.
Combining `groupBy` with `sessionId` is rejected (HTTP 400). Default in-session
Find and ungrouped workspace search retain every-occurrence behavior.

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
With `groupBy: "session"`, both matched counters count returned **session
representatives**, not full message or occurrence totals within those sessions.
The skipped history is intentionally not counted. Grouped clients should label
these as matching sessions, never as complete per-session message/hit counts.

This is a **live traversal, not a database snapshot**. Every page reapplies live
authority and archive filters. Concurrent appends, deletion, archiving, or
visibility changes require restarting the traversal for refreshed results and
counts; exhaustion does not certify a snapshot of mutable history. Cursors bind
workspace, subject, resolved host/agent scope, query, session filter, and archive
filter. Scope id order is canonicalized before binding, so a host returning the
same scope in a different order does not invalidate a continuation — only a real
scope change does. Cursors carry bounded positions/counts, not source message
text. Counts from a cursor are continuation bookkeeping, never authorization or billing
evidence. Invalid or changed-scope cursors return HTTP 400.
Grouping mode is also bound to the cursor; it cannot be switched mid-traversal.

## Bounded scanning and cancellation

An empty page with `hasMore: true` is valid: keep requesting `nextCursor` while
displaying provisional counts/searching state. Never treat an empty page, page
size, or an arbitrary number of requests as complete. There is no overall
history cutoff.

Each request reads one batch of at most 33 message identities/bounded small
scalars, processes at most 32 message/scalar windows, returns at most 50 hits,
and checks a roughly 1.5-second processing budget between windows. That budget
cannot interrupt a statement already running: any single SQL statement may run
up to the five-second statement timeout, so one slow identity or slice read can
push a page past 1.5 seconds. This is not an end-to-end latency bound: connection
acquisition, authorization, transaction setup, and multiple SQL statements add
time outside the between-window processing budget.
AbortSignal checks run before/between reads. In-flight database statements
finish or hit that timeout; browser cancellation does not promise instantaneous
database cancellation. An abort observed during the search returns an empty
499 (client closed) response rather than a server error; a disconnected client
may never receive that response. Authorization, transaction, and RLS setup run
once per page, rather than per ordinary message.

Large scalars reuse the `session-event-slices` scalar reader and exact lossless
UTF-16 decoding for NUL, lone surrogates, and codec-marker collisions. Search
already holds the subject-RLS transaction and authorized event identity, so it
does not repeat identity discovery and nested RLS setup for every slice. A
search-only read can coalesce up to four adjacent 8192-unit windows, charging
each against the unchanged 32-window request budget. Ordinary conversation
slice reads remain bounded to 8192 units.
Overlapping windows and in-message occurrence cursors prevent truncated false
negatives and duplicate hits at window/page boundaries. PostgreSQL still has to
extract/detoast source scalars; large encoded messages are slower than ordinary
batched messages. This API is bounded in transfer and resumable work, not an
indexed-search latency guarantee.

Clients should cancel superseded searches with the SDK's third `{ signal }`
argument and retain only result snippets/cursors. Do not fetch or concatenate
complete history in the browser to implement Find. Old servers return an error;
the SDK never silently falls back to title search or local history scans.

## Browser query and failure lifecycle

The stock search dialog and conversation Find separate the draft input from the
committed literal query. Brief edits that are undone before commitment leave the
active request, results, selection, and scroll position intact. Highlights and
navigation use the committed query while the draft differs; clearing the input
is immediate. This is not a persistent result cache: scope/client changes and
reopening require fresh authorization.

Transient transport/server failures retain already-returned snippets and the
last successful continuation. Retry resumes that boundary, without discarding
matches or fetching successful title/context sources again. Warnings appear
alongside usable results instead of replacing them. Definitive client errors
discard the affected traversal; a rejected cursor retries from the beginning.
Access-denied responses also hide the other sources and selected preview until
fresh authorized reads succeed. Disabled hooks expose no retained content, and
late responses from cancelled requests cannot restore it.

The HTTP metrics use the bounded route label
`/v1/workspaces/:workspaceId/session-message-search`, without query text or
workspace identifiers, so search latency and status can be measured separately.

## Selected-result context

For the **selected** search hit, call
`getSessionMessagePreview(workspaceId, sessionId, { eventId, sequence }, { signal })`.
This browser-compatible SDK read issues
`GET /v1/workspaces/:workspaceId/sessions/:sessionId/events/:eventId/message-preview?sequence=N`.
It returns `{ status: "available", text }` for the entire selected visible
message at or below 12,000 UTF-16 units, or `{ status: "unavailable" }` for
larger text. Stale event-ID/sequence pairs, duplicate/late/unclaimed events,
non-message types, and missing text fail closed with 404; invalid references
return 400. It reuses target-session read authorization and 8192-unit scalar
slices, without projecting the event or other payload fields (including
`modelContext`) into the response. The response is not a history/stream API.

For **surrounding** context, the bounded `listEventPage` reader selects nearby
event identities in two directions around the selected sequence with
`includeTypes: ["user.message", "agent.message.completed"]` and
`payloadMode: "summary"`. Read their visible text separately through the same
text-only preview endpoint. Summary projections discard the payload codec
version and can contain an encoded storage marker even when they fit under the
4096-byte cutoff; never render their `payload.text` or stringify the event.
Omit unavailable context messages. Search snippets remain the precise hit
excerpt even when the selected preview is unavailable.

Search authorization is list-shaped even with `sessionId`: the normal live
grant plus complete host/agent list scope precedes SQL, and the subject RLS,
session-tenancy fence, member-removal fence, private-session policies,
Slack-private restrictions, and per-subject archive rules are reused. Reading
surrounding events separately uses the ordinary target-session authorization.

## Verification

`packages/db/test/session-message-search.test.ts`,
`apps/api/test/session-message-search.test.ts`, and the search browser suite
`test/e2e/session-search.browser.e2e.ts` require real PostgreSQL. They use
the shared Docker pgvector harness by default. In a sandbox without Docker,
`OPENGENI_SESSION_SEARCH_TEST_ADMIN_URL` may point at an explicitly disposable
native PostgreSQL/pgvector cluster: the narrow test helper creates an isolated
database, runs all migrations, provisions a distinct non-superuser application
role with the production FORCE-RLS grants, and removes its database/role on
completion. It never uses the admin role for application search assertions.