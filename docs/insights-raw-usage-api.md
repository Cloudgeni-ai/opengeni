# Insights unified DB API

Migration `0604_insights_raw_usage_api.sql` introduced the rolling endpoint
checkpoint. It adds nullable captured class annotations
and two scoped read capabilities. Released readers, authorization policies,
permission checks, billing writes, pricing/catalog definitions and ledger rows
are unchanged. No historical total is repriced.

`readInsightsUsage` and `readInsightsCalls` accept `(db, { accountId,
workspaceId: string | null, query, now, detailsWorkspaceIds?: readonly string[],
detailsSharedWorkspaces?: boolean })`. A null workspace selects organization
scope. The result is the existing `@opengeni/contracts/insights-usage` response.
All six preset UTC ranges and the original grouping/filter/cursor fields are
supported. Source/plan/session dimensions and custom dates remain preserved
follow-up work: these queries return HTTP 400 rather than silently using a
different window or dimension. The interim response omits `facets.sources`.

Core must supply authenticated detail authority, not wire fields: workspace
routes pass their sessions:read-authorized workspace; organization routes pass
their actual same-account/same-subject workspace grants. Shared-all must come
only from the existing stamped account-scoped API-key authority proof with
sessions:read and an all-workspaces scope. Selected keys pass exactly their
canonical selected IDs instead; explicit workspace:admin never substitutes for
literal sessions:read. Workspace endpoint permission gates are unchanged,
but detail authority is independently intersected. Billing/account administration
alone grants no detail access.
Shared-all never admits Personal workspaces. The cursor binds these flags.

Live session/root/project/person/schedule metadata is projected only after
actor and detail-authority masking. Hidden Only-me and other Personal amounts
are aggregated inside the owner capability by kind/opaque person/payer/bucket,
not returned per hidden call. Private/Personal rows are not identity-filterable;
facets contain only visible metadata. Deleted and restricted usage are distinct.
Call details are visible-only, with filtering before cursor and limit.

Charged amounts come only from negative `model_usage_debit` / `model_response`
credit-ledger entries, matched by `turnId:sourceKey`. Requested fact prices are
not actual debits. Unmatched workspace/account charges retain their money in
restricted buckets with zero calls/tokens and no fabricated model attribution.
Successful JSON responses have a bounded, process-local 60-second cache, so
amounts can be up to 60 seconds stale. Cache hits preserve `generatedAt` and
`dataThrough`. Every request reauthenticates and reauthorizes; keys partition by
account/workspace, normalized query, authenticated credential/principal and
current selected-workspace/session-read ceilings. The existing committed
session-activity revision plus current shared inventory/project/schedule metadata
fences private/deleted/moved identities before a hit. Unavailable fence metadata
disables caching. Credentials are HMAC-digested, not retained as cache keys.
The cache holds at most 128 entries/8 MiB, with a 1 MiB per-response limit; hits
do not extend TTL, failures are never cached, and browser cache control is
`private, no-store`. `x-opengeni-insights-max-staleness-seconds: 60` discloses the
upper bound. Existing transaction-local 10-second statement cancellation maps
to HTTP 408 in the normal error envelope: `Range too large, try 7 days.`
Usage totals follow each debit's ledger `occurredAt` in the selected period;
call details follow the fact's `occurredAt` and show lifetime debits linked to
that call, including a later clipped debit. These are different clocks: summing
call rows is not period-ledger reconciliation. No requested price is substituted
and a delayed debit is retained in its actual period even without period facts.
Cursor timestamps are always UTC with all six PostgreSQL fractional digits,
independent of the database connection timezone.

Usage reads decode measure columns once before aggregation and deduplicate only
visible facet metadata. Totals and ingestion watermarks retain every authorized
source row. The prior and current windows run as separate statements in the same
actor-scoped transaction, each retaining the 10-second statement timeout; this
avoids spending one statement's entire allowance across both independent scans.
Migrations 0815–0818 accelerate the fact input with transactionally maintained
hourly aggregates; the response query and its timeout stay unchanged.

Captured class annotations must conserve the recorded provider estimate. NULL
telemetry is not zero, including cache-write telemetry. This interim checkpoint
does not perform historical allocation: eligible fixed-total allocation using
the separately approved current-catalog snapshot remains the rollup follow-up.

Contract follow-up 3296 permits a money-only prior with zero recorded calls; the DB and
routes retain that money rather than inventing calls or dropping it. A truly
empty prior is null.

Focused real PostgreSQL coverage uses a NOSUPERUSER/NOBYPASSRLS migration owner
and restricted application role, with historical facts before the migration,
both scopes, all ranges/groupings, clipped/orphan debit conservation, strict
privacy/authority ceilings, class snapshots, microsecond cursors, exact UTC
midnight, grants, capability cleanup and runtime posture. The same owner/app
fixture compares complete raw and rollup-backed responses over all supported
ranges, groupings, filters and privacy kinds; it also covers additive maintenance,
recorded-at maximum repair, rollback, idempotent rebuild and concurrent writers.

## Missing model-fact reconciliation

The control worker's existing three-minute maintenance run advances persisted
workspace scans, rather than limiting the result of an unbounded history join.
`reconcileModelCallFacts` advances one input page (500 rows in the worker).
Its `truncated` result means more scan work remains, even when this page found
no missing facts. Callers must continue until it is false. Counts describe only
the missing keys resolved by that page, not an estimate of the remaining scan.

The discovery phase reads ledger `(occurred_at, id)` pages and queues missing
`(turn_id, source_key)` keys. The repair phase reads each queued turn's usage
history once in timestamp/id order, including historical payload keys without a
backfilled `usage_source_key`. It fetches full payloads only for matching keys.
Unrepairable keys are drained in bounded pages; they cannot starve later rows.
The two workspace-scoped FORCE-RLS tables retain the cursor and candidates.
Queue changes, fact inserts and cursor advancement share one transaction. An
aborted page rolls back; another process resumes the last committed page. A slow
sweep completes its captured window before advancing to a new window, bridging
the elapsed interval instead of skipping it. Recent overlapping windows still
recheck late events. The existing historical backfill remains separate.

Repair preserves first-event selection, durable billing annotations and existing
facts. It never charges or rewrites the usage/credit ledger. Concurrent sweepers
serialize only on their workspace's progress row. Each workspace gets a page
before the activity revisits unfinished work round-robin.

The activity passes its cancellation signal and **existing** run deadline to
each database page and workspace enumeration. On the postgres.js adapter,
`withDatabaseMaintenanceLifetime` reserves a transaction, preserves any shorter
configured statement timeout, and uses a transaction-local disconnect check.
Abort sends the protocol cancellation and joins both its acknowledgement and
the query before rollback/release, so a late cancel cannot be sent to a later
pool borrower. Abrupt process death is detected by PostgreSQL after the socket
closes; a network partition still depends on TCP failure detection and the
server-side deadline. Pool acquisition and an already-sent COMMIT are joined,
not abandoned: an acknowledged commit is retained, not reported as rolled back.
No deployment-wide timeout or resource setting is changed. Externally injected
drivers lacking this cancellation capability fail explicitly for this activity;
hosts can use `createDb` for the maintenance connection.

Migrations 0890–0893 are rolling: new FORCE-RLS state plus concurrently built
indexes. Run them before new worker code. Old workers ignore the new state and
may duplicate repair attempts during a rollout; the existing unique fact key
keeps insertion idempotent. They retain their old query until drained. The event
index covers only `agent.model.usage`, not every streamed session event. The
ledger paging/source indexes add write and storage cost; measure their size and
the full sweep, not just its first page, when evaluating this change.

## Hourly rollup lifecycle

`opengeni_private.insights_usage_hourly_rollups` retains the exact additive
measures captured on facts, keyed by account, workspace, UTC hour, session,
provider, model, payer and scheduled task (`NULLS NOT DISTINCT`). Session keys
are intentionally not foreign keys: deleted-session amounts remain billable.
Workspace deletion cascades the rollups and the backfill queue. Neither table
is granted to runtime roles. Maintenance routines live in the owner-only
`opengeni_insights_internal` schema, outside old binaries' runtime-function
inventory. No superuser or BYPASSRLS privilege is required.

The four rolling migration files deliberately use separate transactions:

1. **0815** installs the tables and AFTER INSERT/UPDATE/DELETE delta trigger.
   It performs no historical scan under CREATE TRIGGER's table lock. Writers
   take a shared transaction advisory fence per workspace/hour. The group
   upsert serializes additive changes; removing the latest recorded fact repairs
   its maximum from raw facts while holding the group row lock. Timing-only
   updates whose usage projection is unchanged do no rollup write.
2. **0816** queues historical hours from raw facts **and** provisional rollups
   in the same snapshot. This includes an hour whose last historical fact was
   deleted after trigger installation. Reads still use the original raw input.
3. **0817** uses the existing batched migration runner to rebuild and commit
   one hour at a time. Recompute requires READ COMMITTED, takes the exclusive
   hourly fence, then obtains a fresh raw snapshot with the existing owner-only
   fact capability. A failure leaves the batch pending; retry is idempotent.
   Raw fact writes are never globally locked by the backfill. Writers for the
   one hour being rebuilt wait until its short transaction commits.
4. **0818** refuses activation with any pending hour, then replaces only the
   fact branch of the existing input function. The credit-ledger branch, owner
   attestation, ACLs and public signatures remain intact. Complete UTC hours
   use rollups; ragged edges use exact raw predicates on the same statement
   snapshot. UTC hour starts bucket identically for hourly and daily output;
   `dataThrough` remains the maximum visible `recorded_at`, not the hour start.
   Daily requests combine typed hourly measures into session/dimension/day
   rows before building JSON, avoiding a second payload and sort expansion.
   Private-session visibility keys are computed once per workspace statement.

The migration's lock timeout is one second: contention fails safely instead
of waiting behind a busy writer and creating a long insert queue. Resume the
normal migration command after the contending transaction completes. Backfill
duration depends on facts/hour, number of hours, storage and concurrent load;
`scripts/bench-insights-hourly.ts` measures the exact response queries with
4 million facts, 80 days and roughly 7,000 sessions on disposable local Postgres.
It also prints trigger time separately from insert/index work. Rollup size is
proportional to distinct session/model/payer/hour tuples, not just hours: very
high-cardinality workloads compress less. Existing SQL functions and binaries
remain compatible throughout; use a forward migration for database rollback.
Changes to payer classification or captured-measure formulas must rebuild the
affected historical hours before activating the corresponding reader.

### Local scale evidence (2026-10-17)

PostgreSQL 16, `work_mem=16MB`, JIT off, 4,000,000 facts over 80 days,
about 7,000 sessions, 41,760 hourly rows. Each session is active for six hours;
the fixture has no credit-ledger entries. These are individual EXPLAIN ANALYZE
runs on a shared development machine, not production latency percentiles.

| Range | Raw current window | Rollup current window | Rollup prior + current |
| --- | ---: | ---: | ---: |
| today | 11.155 s | 0.206 s | 0.676 s |
| 30d | >300 s (cancelled) | 0.837 s | 1.271 s |
| ytd | >300 s (cancelled) | 2.437 s | 2.513 s |

All three final plans wrote zero temporary blocks. The raw today plan wrote
49,104 8-KiB temporary blocks. Hourly-only JSON output still took 11.414 s for
YTD, which is why daily typed aggregation is part of the reader, not a later
optimization. Full backfill took 199 s for four million facts and 1,840 hours
(about 108 ms per hour on average). At similar density, 1.8 million facts would
take roughly 90 s; budget additional time for contention, workspace count and
slower storage. A completed-queue replay scanned/enqueued history in 9.4 s
without rebuilding completed hours.

Two 10,000-row insert samples attributed 0.31–0.48 ms per fact to the hourly
trigger. Latest-fact deletes/updates additionally repair the group's maximum
by scanning its hour; they are not represented by that insert-only figure.
Higher cardinality, large credit ledgers and unusually dense hours need their
own measurements. Neither the statement timeout nor `work_mem` was increased
for the final response timings.

Historical staging API `2a5ab6f512a05bf28afce38ac4259dea861d3669` is also
tested before/after this migration against the **complete** current catalog,
with both old and current provisioners. Its pre-existing readiness blockers
from main's Claude pool tables (0598), selected-key table (0600) and Slack
rate-limit DML (0597) remain identical; 0604 adds no violations. The old
provisioner removes newer required grants, so current-role provisioning must
be restored at cutover. This is not a claim that the serving old binary is
ready on the combined main schema. The f893cb5 modules (independently verified
equivalent to serving e61's runtime-posture/role-relationships/provisioner blobs)
are also compared before/after with both provisioners, preserving any main-0603
service-account inventory blockers. Frozen pre-0604 (a15e7a5) and current
runtime/provisioner readiness pass without exclusions or widened grants.

After the synthetic full-HTTP baseline exceeded two seconds, 0605 adds only a
concurrent partial debit-period index on account/occurredAt/workspace; no source
rows, prices, allowances, permissions or policies are changed. The pre-index
workspace seven-day p95 was 3.59s, workspace 30-day 9.80s, organization seven-day
6.62s, and organization 30-day hit the existing 10s statement timeout. These are
synthetic volume-sized local PostgreSQL 17.11 results, not PostgreSQL 16.15 staging
clearance. The indexed 5239f006 run measured workspace seven-day warm p95 4.09s,
organization seven-day 8.41s, and both 30-day cases encountered the 10s timeout
(workspace's first request succeeded). Cache-hit smoke is separate from this
uncached performance evidence; this is not a sub-two-second uncached claim.
