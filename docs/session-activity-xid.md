# Session activity transaction IDs

Session writers stamp `sessions.activity_xid` with `pg_current_xact_id()` in a
BEFORE trigger, in the original INSERT or semantic UPDATE. `updated_at` writes
and project detachment (`channel_id`, including FK actions) count as activity;
raw event/cursor writes do not. The ID is the top-level xid, including inside
savepoints. Rollbacks roll back the stamp. New application transactions never
open the activity gate, flush/re-defer every constraint, advance a workspace
counter, or write the session again to finalize activity. Tenant/actor RLS,
tenancy fences, per-session locking, and atomic event semantics are unchanged.

## Readers

Updated-order pagination uses `(activity_xid, updated_at, id)` descending.
The timestamp tie-break preserves historical ordering for the zero-xid bucket
and multiple sessions written in one transaction. This is a live keyset, not a
retained historical view: a changed row can move above the current cursor;
a lower-xid transaction that commits late can enter a later page. Unchanged
rows do not repeat. There is no stored or cursor-embedded PostgreSQL snapshot.

Incremental discovery captures `pg_snapshot_xmin(pg_current_snapshot())` in
the **same statement and MVCC snapshot** that selects the page. A supplied
token means `activity_xid >= token`, with no upper bound. Every transaction
below xmin has finished; any transaction still able to commit has an xid at
least xmin. A slow, lower-xid writer is therefore included on a subsequent
poll even if a higher-xid writer committed first. Delivery is **at least once**,
not an event log: intermediate versions can be coalesced, duplicate sessions
are expected, and deleted/unauthorized rows are not exposed. Finish all pages
before using `updatedThrough` as the next `updatedAfter`. Continuations retain
page one's watermark; advancing it mid-traversal could skip a commit that
lands above the current keyset. Long-running transactions can cause more
replay, but do not delay updated-order discovery.

Relevance pagination alone retains a fixed exclusive snapshot xmax ceiling. Its
normalized filters and bounded activity window satisfy the existing activity
snapshot contract without hiding committed rows behind an unrelated old
transaction's xmin. As with live keysets, a lower-xid transaction still in flight
on page one can become visible on a later page; there is no retained row snapshot.

Decimal tokens encode `2^64 + xid`, distinguishing every new xid watermark
from every legacy signed-bigint workspace revision without losing xid8
precision. Legacy incremental tokens and updated/relevance cursors restart
conservatively. Relevance and updated MCP cursors use a compact positional
envelope that fits the unchanged 512-character input. No tool descriptions
or input schemas change.

Insights response-cache invalidation uses the database visibility snapshot
instead of a workspace counter. This also detects out-of-order commits, unlike
`max(activity_xid)`. It may invalidate on unrelated database activity; correctness
is preferred over stale results, and authorization is still checked per read.

## Rolling deployment and eventual contract

The expand migration adds an xid8 column with constant default zero (PostgreSQL's
metadata-only existing-row default; no table backfill is required), installs the
stamp trigger, and permits writers that do not open the legacy gate. The index
is built concurrently in its own idempotent migration. Old gate callers still
mark/finalize their rows and pass the unchanged counter-table runtime posture.

Accepted mixed-rollout tradeoff: old readers can temporarily miss activity from
new writers because new writers do not dual-write the contended counter. An old
revision token always restarts on a new reader, repairing the temporary miss
with a superset. New-format tokens/cursors are not readable by pre-expansion
binaries; a request routed back to one may need retry on a new replica. Do not
claim cross-version exact-once delivery or support rollback to old readers after
adopting the new tokens. No physical session data or event history is lost.

After every old replica has retired, a **subsequent release** may contract:

1. Replace the remaining SECURITY DEFINER SQL lifecycle gate blocks with xid-only
   writes, preserving their authority and locking logic. Audit `pg_proc` and source
   references rather than dropping functions with CASCADE.
2. Remove legacy pending-marker and commit-guard triggers/functions, workspace
   initializer and counter guard, the counter table, legacy revision/pending
   columns and their indexes, and the matching schema/posture declarations.
3. Register an annotated `-- deployment-mode: rolling` / `-- contract-step:`
   migration only in that later release, and verify both preceding/current
   binaries against it. All pending migrations run before pod replacement;
   bundling this destructive contract with the expand would break old pods.

This expand release intentionally retains the legacy objects. They are not
consulted by new discovery, pagination, cache invalidation or activity wrappers.
