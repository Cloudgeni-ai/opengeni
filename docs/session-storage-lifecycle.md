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

## Planned next stages

- Fold streamed delta events into compact records once their turn settles.
- Archive idle sessions: a full-fidelity compressed bundle in the deployment's
  object storage, read-only access from the archive, a per-session keep-live
  setting, and deployment configuration to enable automatic archiving.
