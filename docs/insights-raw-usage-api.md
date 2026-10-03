# Insights unified DB API checkpoint

Migration `0602_insights_raw_usage_api.sql` is rolling and independent of the
unfinished daily-rollup migration. It adds nullable captured class annotations
and two scoped read capabilities. Released readers, authorization policies,
permission checks, billing writes, pricing/catalog definitions and ledger rows
are unchanged. No historical total is repriced.

`readInsightsUsage` and `readInsightsCalls` accept `(db, { accountId,
workspaceId: string | null, query, now, detailsWorkspaceIds?: readonly string[],
detailsSharedWorkspaces?: boolean })`. A null workspace selects organization
scope. The result is the existing `@opengeni/contracts/insights-usage` response.
All six UTC ranges and agreed grouping/filter/cursor fields are supported.

Core must supply authenticated detail authority, not wire fields: workspace
routes pass their sessions:read-authorized workspace; organization routes pass
their actual same-account/same-subject workspace grants. Shared-all must come
only from the existing stamped account-scoped API-key authority proof with
sessions:read. Billing/account administration alone grants no detail access.
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
service buckets with zero calls/tokens and no fabricated model attribution.
Late ledger/fact updates are read immediately in this raw checkpoint.

Captured class annotations must conserve the recorded provider estimate. NULL
telemetry is not zero, including cache-write telemetry. This interim checkpoint
does not perform historical allocation: eligible fixed-total allocation using
the separately approved current-catalog snapshot remains the rollup follow-up.

This is an intentionally raw-backed endpoint-first checkpoint: full-day/YTD
scans are not yet accelerated and no staging p95 claim is made. Contract
follow-up 3296 permits a money-only prior with zero recorded calls; the DB and
routes retain that money rather than inventing calls or dropping it. A truly
empty prior is null.

Focused real PostgreSQL coverage uses a NOSUPERUSER/NOBYPASSRLS migration owner
and restricted application role, with historical facts before the migration,
both scopes, all ranges/groupings, clipped/orphan debit conservation, strict
privacy/authority ceilings, class snapshots, microsecond cursors, exact UTC
midnight, grants, capability cleanup and runtime posture. Daily-rollup
bootstrap/maintenance tests are retained in the separate rollup branch.