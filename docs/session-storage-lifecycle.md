# Session storage lifecycle

Session data is the dominant share of an Opengeni database. On a busy
deployment almost all of it is repetition rather than conversation: the same
tool catalog and the same model-request prefix are recorded on every attempt,
and streamed text is stored as one row per fragment next to the completed
message. This document owns how session data is stored compactly while a
session is live, and how idle sessions leave PostgreSQL.

## Content-addressed session content

`session_content_blobs` stores large JSON values once per session, keyed by
the SHA-256 of their canonical JSON (object keys sorted, array order kept).
Owning rows keep the non-repetitive fields inline plus digests in a nullable
`content_refs` column:

| Owning row | Externalized values | Stored inline |
| --- | --- | --- |
| `session_attempt_tool_catalogs` | every catalog entry | identity, generation, digest, `entries: []` |
| `session_attempt_model_context_snapshots` | `instructions`, `layers`, `tools`, `skills`, and `providerRequest.body` as content-defined chunks | `tokens`, `parts`, request metadata, emptied externalized fields |

The request body is a raw wire string that grows by a few items per attempt.
It is split with content-defined chunking (a gear rolling hash over UTF-16
code units, 2 Ki–64 Ki units per chunk, never splitting a surrogate pair), so
consecutive attempts share every chunk except the changed tail. Chunk
parameters affect only deduplication, never correctness: hydration
concatenates the chunks.

`packages/db/src/session-content-blobs.ts` is the only encoder and hydrator.
Every reader selects `content_refs` and hydrates; a NULL value is the legacy
inline form and is returned unchanged. Hydrated values are exactly the values
written, so the tool-catalog integrity digest still verifies. A missing blob is
an error (`SessionContentBlobMissingError`), never an empty value.

Blobs belong to exactly one session: no sharing across sessions or workspaces,
so tenancy, visibility and lifecycle are the session's. The table is FORCE-RLS
with the ordinary workspace policy plus the restrictive session-visibility
policy, the application role may only `SELECT` and `INSERT`, and rows cascade
with their session.

### Legacy compaction

Rows written before migration 0648 are compacted in place by the control
worker's session storage maintenance Schedule (every five minutes, a bounded
number of rows per content kind per pass). The worker cannot enumerate FORCE-RLS
workspaces, so discovery is the SECURITY DEFINER
`opengeni_private.session_content_compaction_candidates`, which returns only
routing ids. For each row the worker encodes the value and writes its blobs
under the row's workspace scope, then calls
`opengeni_private.compact_session_content_row`. Under a row lock that routine
proves the referenced blobs rebuild exactly the stored inline value (each
externalized field compared as jsonb, the body compared as the concatenated
string) and only then replaces the row. Any mismatch leaves the row untouched.

Operators can drain the backlog faster with the same code path:

```sh
OPENGENI_DATABASE_URL=... bun run --cwd packages/db compact-session-content --batch-size=200
```

### Returning disk space

Compaction frees space inside PostgreSQL; it does not shrink table files. Plain
`VACUUM` (autovacuum) makes the freed TOAST pages reusable for new writes. To
return the space to the operating system, rewrite the two tables after the
backlog is drained, for example with `pg_repack`, which rewrites online and
needs free disk roughly equal to the compacted table size. `VACUUM FULL` also
works but holds an exclusive lock for the duration.

## Idle-session archive

Off by default. Enable it per deployment:

| Setting | Helm value | Default |
| --- | --- | --- |
| `OPENGENI_SESSION_ARCHIVE_ENABLED` | `sessionArchive.enabled` | `false` |
| `OPENGENI_SESSION_ARCHIVE_IDLE_DAYS` | `sessionArchive.idleDays` | `30` |

The archive requires the deployment's object storage. The same maintenance
Schedule runs it after content compaction; each pass keeps archiving batches
of eligible sessions until its ten-minute budget ends or none remain, so a
backlog drains steadily after the archive is first enabled. Compaction and
delta folding get the same budget in the same workflow, so neither starves the
other while a backlog drains.

### What qualifies

Each session is judged on its own, not by its tree. A session qualifies when
all of these hold for the idle period:

- it is older than the idle period, no turn was created or updated in it, and
  the session is `idle`, `failed` or `cancelled` with no active turn. Activity
  is measured by turns, because every message, steer, child result or
  scheduled wake creates or advances one. The session row's `updated_at` and
  bookkeeping events (visibility changes, machine link notices) are not
  activity: bulk maintenance and infrastructure appends touch them on idle
  sessions;
- it is not marked keep-live, is not an imported archive, and has no session
  wait;
- it has no pending human input request, active goal, pending machine input or
  inbound outbox delivery, running background command, scheduled task that
  reuses it, or site-authentication maintenance binding;
- no direct child is still active or recently active.

### What happens

1. Under the session's write lock the worker re-checks eligibility and sets
   `content_archive_state = 'archiving'`, recording the planned object keys.
   From that moment the database refuses new turns, attempts, history, goals,
   workflow wakes and machine inputs for the session (`SESSION_ARCHIVED_READ_ONLY`),
   the API refuses sends and steers with 409, and the agent tools
   `session_send_message` and `session_steer` return a non-retryable
   `<tool>_session_read_only` error that says to start a new session. A
   message cannot race the archive.
2. The worker streams two zstd-compressed JSON-lines objects to a temporary
   file and uploads them through the bounded object-storage path, which reads
   every byte back before success. On object stores without read-after-write
   consistency a just-written object can briefly read as missing, so readback
   is retried with a short backoff (about 16 seconds in total) before the
   attempt fails; size or digest mismatches fail at once:
   - `bundle.jsonl.zst`: a header with the exact `sessions` row, then every row
     of the session's turns, attempts, goals, goal revisions, all events,
     history items, machine inputs, realtime entries, code-mode calls, tool
     catalogs, model-request snapshots, content blobs, pending tool calls and
     preference snapshots, each as `{"table": ..., "row": <exact row JSON>}`,
     then a footer with row counts. Full fidelity, for analysis and audit.
   - `transcript.jsonl.zst`: a header, then the readable timeline as public
     `SessionEvent` objects (`{"event": ...}`), then a footer. This is the
     stable, documented readable section and does not require Opengeni's
     internal tables to interpret.
3. The manifest (object keys, sizes, SHA-256 digests, row counts) is recorded
   and the state becomes `archived`.
4. Only then are the bulky tables purged in bounded batches: realtime entries,
   machine inputs, model history, code-mode calls, tool catalogs, model-request
   snapshots, content blobs, pending tool calls, and the event types only an
   executing session or a debugger needs (streamed fragments, model-request
   telemetry, update bookkeeping, startup phases, credential selection and
   late-rejected events).

What stays in PostgreSQL: the session row, turns, attempts, goals and every
readable timeline event, so the web app, `session_events` and the SDK read an
archived session exactly as before, and every durable reference (task notes,
artifact versions, Knowledge lifecycle, usage, billing and audit facts) is
unchanged. Small per-turn audit snapshots also stay.

Archiving is one-way: there is no restore to an executable state. Start a new
session to continue the work. A late machine input for an archived session (a
child result, schedule or media completion) is settled like input to a
cancelled session.

Purging leaves holes in an archived session's event sequence. Event streams
report them as covered: each SSE frame's `id` (its covered-through sequence)
extends to just before the next stored event, or to the session's last
sequence, so stream clients never try to backfill an intentional hole. Raw
event pages simply skip the missing sequences.

### Keep-live

`PUT /v1/workspaces/:workspaceId/sessions/:sessionId/retention` with
`{ "keepLive": true }`, `keepLive: true` on session create, or the SDK's
`updateSessionRetention`, exempts a session permanently. It is workspace-wide
and independent of a member's personal rail archive. It cannot change once a
session is archived.

### In the web app

The web app calls an archived session "read-only" and its storage "long-term
storage", so it is never confused with the personal Archive action, which only
hides a chat from one member's list.

- A read-only chat opens normally with a notice above its timeline that says
  when it was stored and offers a new chat; the composer is not shown.
- The chat's Agent tab has a "Keep this chat active" switch (keep-live) under
  Storage, shown only when the deployment archives idle sessions
  (`ClientConfig.sessionArchive`, present when archiving is enabled and object
  storage is configured).
- The session list's view menu links to a "Read-only chats" page that lists
  every read-only root chat in the workspace, including chats a member
  archived personally, with title search, a project filter and sorting. It is
  backed by the session list's `contentArchivedOnly` filter.

### Recovery and deletion

An archive left in `archiving` by a crashed worker for more than two hours is
abandoned: the session returns to live, and its planned objects are queued for
deletion in the same transaction. An `archived` session whose purge did not
finish resumes purging on the next pass. Deleting an archived session queues
its objects for deletion in the deleting transaction, and the maintenance
worker removes them, so a deleted session never leaves its bundle behind.

## Folded text deltas

A model answer or reasoning stream is stored as one `session_events` row per
provider fragment, often thousands per turn, next to the completed message.
Ten minutes after a turn settles, the same maintenance pass folds each run of
adjacent `agent.message.delta` or `agent.reasoning.delta` rows (one turn, one
producer, one message and phase, at most 48 KiB of text) into the run's first
row and removes the others. Always on: it is lossless.

The folded row keeps its id, sequence and timestamps, and its payload is the
shape live streams already deliver:

```json
{
  "text": "the whole run's text",
  "coalescedUntil": 1234,
  "messageId": "optional, as on the fragments",
  "phase": "optional, as on the fragments",
  "folded": {
    "v": 1,
    "parts": [[0, 0, 0, 17, 5, "id-of-fragment-1"], [1, 1520, 1610, 18, 3, "id-of-fragment-2"]]
  }
}
```

Each part is `[sequenceOffset, occurredOffsetMicroseconds,
createdOffsetMicroseconds, producerSeq, textLengthInUtf16Units, id]`, relative
to the folded row. `unfoldSessionEventDeltas` in `@opengeni/db` rebuilds the
original events. Readers already treat a delta with `coalescedUntil` as
covering the sequences up to it; event streams and compact pages report that
coverage, and raw pages skip the removed sequences. Only plain fragments fold:
anything with another payload field, a client event id or a duplicate marker,
and command or terminal output, stays as it was. Progress is recorded per turn
in `opengeni_private.session_turn_delta_folds`, so each turn is folded once.
