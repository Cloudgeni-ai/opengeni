# Incremental Insights storage checkpoint

Migrations `0606_insights_daily_rollups.sql` and
`0607_insights_actual_model_debits.sql` add owner-only analytics storage after
`0604_insights_raw_usage_api.sql`. They change no billing writer, source policy,
permission row, visibility rule or API contract. They are rolling migrations.

## Maintenance and bootstrap

The migration owner must be `NOSUPERUSER NOBYPASSRLS`. Each bootstrap opens the
documented transaction-local `NO FORCE ROW LEVEL SECURITY` owner window, locks
its source tables, installs the exact-source `AFTER INSERT OR UPDATE OR DELETE`
triggers, aggregates history once and checks convergence before restoring FORCE.
Migration journal replay is idempotent; a failed transaction leaves neither the
bootstrap nor its triggers partially installed. No runtime backfill is needed.

Usage groups retain quantity and source-row count. Model groups retain every
nullable counter's sum and known count, frozen prices/classes, normalized
contributions, and an exact joint timestamp multiset. Removing or moving an
extremal source row therefore updates minimum/maximum occurrence and recording
times without stale facets. Uncached input is derived separately per fact only
when input, cache-read and cache-write are all known, nonnegative and consistent.

Actual charge groups come only from negative `model_usage_debit` ledger entries
with `source_type=model_response`. The `turnId:sourceKey` link supplies model
dimensions only when a matching fact exists. Clipped debits, late facts, ledger
and fact mutations, deleted facts and NULL-workspace residual money remain exact;
unmatched money has zero calls and no invented model or tokens. The nominal
`priced_cost_micros` and `model.cost` event amounts are not actual debit authority.

Sorted transaction-scoped source/group fences serialize concurrent deltas and
opposing dimension moves. `ON CONFLICT DO NOTHING` source retries do not run an
extra insertion delta. Transaction rollback also rolls back all projections.

## Read integration seam

`opengeni_private.insights_rollup_amount_inputs(account uuid, workspace uuid|null,
since timestamptz, until timestamptz, granularity text)` is **SECURITY INVOKER** and
checks the source owner and exact tenant context. It returns the existing narrow
raw-input shape: session/provider/model/payer/schedule, occurrence/recording time,
flat numeric measures, and charge-row flag. Complete UTC days use daily groups;
only the two incomplete day edges read facts/charge links. Hourly windows must be
at most one day; day windows must be at most 370 days. Equal bounds return no rows.
Raw model edges are issued separately with scalar timestamp index bounds, not a
join against an estimated edge relation. A complete UTC-day window issues no raw
model query. The owner fixture uses `row_security=off` (fail on RLS, not bypass):
a FORCE-bound raw query is rejected, but complete-day history is still returned
without opening a fact-read capability or changing FORCE posture.

Rolling migration `0609_insights_daily_usage_reader.sql` switches only the two
amount-input calls in the existing scoped usage reader to this seam. Definition
guards require exactly the reviewed call sites and owner/posture; the function
OID, grants, configuration and every other body byte remain unchanged. Current
masking, authenticated detail ceilings, filters and metadata joins are preserved.
The source seam is not an authorization or an application-facing reader. Private
tables and columns deny app/PUBLIC direct access; helper EXECUTE remains compatible
with frozen runtime inventories but cannot convey intermediate identities.
Triggers attest their exact permanent source relation, not a table name, and
reject application-created temporary lookalikes before making an owner write.

## Verification and remaining work

The focused real PostgreSQL owner/app fixture covers historical bootstrap,
concurrent inserts/conflicts, rollback, updates/deletes, extrema, contributions,
late ledger/fact races, class conservation, full-day/edge/hour source parity,
direct-write denial, and frozen/current runtime provisioning including polluted
column-grant repair. These checks do not establish staging p95.
The larger fixture seeds 40,000 old-writer calls and actual debits before the
non-superuser bootstrap, compares full API responses to a frozen raw oracle,
and measures workspace/model and organization/workspace/person reads. The test
oracle alone permits a longer timeout for diagnostic raw comparisons; production
read budgets and authority are not extended.

The merged unified workspace/org usage API selects daily groups for full days
across all six ranges and all eight supported groupings. Recent/cursor calls and
hourly/partial-edge reads remain bounded raw reads. Existing legacy bundles have
separate private rollup seams but are not switched by this bounded follow-up.
The additive source/custom grain is preserved on the source-extension branch,
not installed here and not a blocker for basic daily reads. No historical list
total is repriced by these migrations.

## Versioned historical list-class allocation

Rolling migration `0608_insights_historical_list_allocations.sql` adds a private
immutable comparison-rate snapshot and nullable per-fact allocation provenance.
It does not install rates or scan source history during deployment. After approval
of the current comparison catalog, the migration owner calls
`installInsightsListRateSnapshot(db, { settings, version, batchSize, maxBatches })`.
Only model IDs, numeric four-class rates and input-token thresholds are retained;
credentials, full Settings and debit margins are not stored. The snapshot's hash
binds its version and sanitized profiles. Reusing a version with different rates
fails, rather than changing a prior snapshot.

`resumeInsightsListRateSnapshot` processes at most `batchSize` candidate facts per
transaction, with a committed UUID cursor. Each batch opens a bounded owner-only
NO FORCE window under the source table lock and restores FORCE before commit.
The cursor, corrected facts, daily deltas and counts commit or roll back together.
Late old-writer inserts and telemetry enrichment use the active snapshot through
an exact-source BEFORE trigger, with no private write for conflict-discarded NEW
rows. Activating another snapshot does not reallocate already captured classes.

Eligible recorded provider estimates are allocated proportionally to
`class_tokens * approved_class_rate` using integer largest remainders, with stable
class-order ties. The four amounts sum to exactly the unchanged recorded total;
reasoning is an output subset, never a fifth cost. Missing recorded price,
required counters, positive-class rates or inconsistent counters remain unknown.
Gateway-reported totals remain unknown here. Historical TTLs are not asserted:
these are approximate single-schedule comparison weights, not exact provider
class charges. Every generated split is marked approximate and contributes to
stored class-coverage counts; captured caller classes are preserved.

Correcting an allocated fact's model, relevant counters or recorded total
recomputes its derived split from the original immutable snapshot, not whichever
catalog is active now. If the corrected row is ineligible, its derived class
coverage/provenance is removed. Billing debits and recorded total prices are never
written by the allocator.

Known-call counts describe **stored telemetry coverage**, not uniform proof of
original provider reporting. The native Anthropic adapter historically defaults
missing counters to zero, without retaining per-field presence. Such rows are
left unallocated when uncached input, read, write or output is zero/unknown;
positive counters can be checked without treating an ambiguous default as a
provider-supported zero. Exact forward captures remain independent and frozen.

## Coordinated source-grain extension (not implemented here)

The parent owns canonical source capture/classification and the raw API privacy
projector. The proposed amount seam keeps its nine columns and appends a tenth
`usage_source text`: `web`, `api`, `slack`, `schedule`, `agent` or `other`.
`api` covers API/SDK/embed; `agent` requires proven agent-spawned child origin.
Unknown source is not guessed from a generic user/service initiator. Commercial
plan/tier history is not captured and must not be inferred from current settings.

Future captured source can join the daily grain directly. For NULL captured
source, the grain must also retain immutable turn ID and exact classification
provenance, so different turns in one session/day do not collapse before the
parent classifier resolves retained accepted-turn surface or proven child origin.
The charge link must copy that same grain: a late fact or source capture then
moves its actual debit via OLD-/NEW+ deltas. Unmatched ledger amounts have source
`other`, zero calls and no fabricated model, actor or commercial plan.

Owner/root/project/current schedule labels remain live joins behind the unchanged
parent projection. Only already-authorized opaque owner/person facet selections
may select disclosed private/Personal amounts; other hidden metadata stays
non-probing. This checkpoint does not add that selection or any source facets.
The coordinated custom range permits inclusive UTC calendar days, at most 370
days, hourly at at most two days. The delivered source's current one-day hourly
cap and nine-column result are unchanged until the exact parent classifier and
source interface are integrated and parity-tested. Partial coverage must use
explicit raw fallback, not silently return differently classified totals.