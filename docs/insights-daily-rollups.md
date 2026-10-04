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

Sorted per-row source/group fences cover the tested single-row opposing moves.
They do not establish a transaction-wide order across multiple source statements;
the independent review found a multirow deadlock blocker described below.
`ON CONFLICT DO NOTHING` source retries do not run an extra insertion delta.
Transaction rollback also rolls back all projections.

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

After migration 0609 commits, the existing unified workspace/org usage API selects
daily groups for full days across all six ranges and all eight supported
groupings. The separately merged raw API does not activate this substitution by
itself. Recent/cursor calls and hourly/partial-edge reads remain bounded raw reads.
Existing legacy bundles have separate private rollup seams but are not switched
by this bounded follow-up.
The additive source/custom grain is preserved on the source-extension branch,
not installed here and not a blocker for basic daily reads. No historical list
total is repriced by these migrations.

### Frozen-head full-volume bootstrap measurement

On October 4, 2026, a new isolated physical copy of the retained synthetic data
was measured at head `78c96261d7c779fe1d7cd910ab17abdecc482d6f`. It contained
838,000 model facts, 4,170,000 usage events (2,870,000 warm events), 276,568 ledger
entries and 4,097 sessions. The original scale fixture and its prior cache-copy
template were left unchanged. Only migrations 0606–0609 ran on the new copy,
once; no comparison snapshot was installed and no historical allocation ran.

| Migration | Total elapsed | Observed source AccessExclusiveLock hold |
| --- | ---: | --- |
| 0606 | 537.071 s | 536.614–537.071 s on model facts and usage events |
| 0607 | 23.713 s | 23.375–23.713 s on model facts and credit ledger entries |
| 0608 | 0.243 s | Below the 250 ms observer resolution; not a no-lock claim |
| 0609 | 0.009 s | No source-table lock observed |

The hold intervals are sampled lower bounds through phase-duration upper bounds,
not exact lock-release timestamps. These locks conflict with ordinary source
reads and writes. Four normal `opengeni_app` writer probes under an explicit
transaction-local 10-second diagnostic timeout were cancelled with PostgreSQL
`57014`: model/usage during 0606 and model/ledger during 0607. The normal pool's
statement and lock timeouts remained zero; an unbounded writer may wait for the
full fence instead of failing at ten seconds. All fourteen post-phase probes,
including the old writer and the new writer after 0608, completed and deliberately
rolled back. No probe committed facts, events or money.

The migration transactions committed. Counts, checked nullable-counter knownness,
token/list/debit amounts, source policies and FORCE posture matched afterward;
current runtime posture had no violations before or after. The reader changed
only its two reviewed amount-input calls, preserving OID, owner, ACL,
configuration and other definition bytes. Resulting storage was 282,624 model
daily rows and 847,872 usage daily rows: the 40,000-call fixture's compression
ratio must not be extrapolated to this distribution.

The local environment was PostgreSQL 17.11, a 16.125-CPU quota with affinity 0–16,
128 MiB shared buffers and 4 MiB work memory. This was one instrumented synthetic
bootstrap, not a dedicated four-vCPU run, real staging HTTP measurement or p95.
The source-write fence is a material rollout risk requiring explicit owner
disposition; rolling schema compatibility is not online/no-downtime readiness.
The retained primary JSON and matching harness identify the exact migration
hashes. A final diagnostic amount-query cast error was repaired by read-only
attestation, without replaying any migration. If corrective changes alter the
bootstrap or lock strategy, these figures remain historical measurements of
this frozen head and must not be relabeled as the new candidate's results.

### Independent review and the UUID correction checkpoint

The measured candidate was not merge-ready. Its 0607 bootstrap/private lookup
keys compare literal UUID text in places where the raw baseline casts valid UUID
prefixes. A valid uppercase turn UUID can therefore lose debit attribution;
correction must normalize only that prefix, preserving the case-sensitive source
key and original ledger row. Independent raw-oracle regressions must cover
historical bootstrap, ledger-first late facts, current corrections and deletion.

The subsequent DB-only checkpoint `b6ccbbdfd45e031adb7481b368c1f6358ce9662c`
corrects the valid UUID prefix in private link/fence keys and uses an independent
UUID-cast bootstrap join. It does not lowercase the source-key suffix or rewrite
the original ledger row. Its real PostgreSQL owner/app suite passes 120 tests and
1,719 assertions, including mixed-case history, late attribution, corrections,
deletion and raw-oracle parity. The integration retains those two DB file bodies
unchanged. These checks are correctness evidence, not a repeat of the frozen-head
volume measurement; the changed 0607 bootstrap has not been timed at that volume.

The bounded DB worker also reported a real PostgreSQL reproduction in which
opposing multirow transactions on disjoint source rows both commit before
rollups, but a new analytics advisory-lock cycle aborts one afterward with
`40P01`. This is a source-write availability blocker, not a demonstrated money
corruption. A fail-fast error is not sufficient protection unless all affected
old writers actually retry; removing advisory locks alone can leave shared daily
row-lock cycles. The diagnostic regression deliberately asserts the unresolved
`40P01`; a green test run does not make this checkpoint merge-ready. The
corrective strategy and completed regression evidence remain separate from the
frozen-head measurement. Neither finding reopens the already
merged raw API, and no rollup merge or deployment is implied by these notes.

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