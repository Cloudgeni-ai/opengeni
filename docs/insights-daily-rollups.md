# Incremental Insights storage checkpoint

Migrations `0610_insights_daily_rollups.sql` and
`0611_insights_actual_model_debits.sql` add owner-only analytics storage after
`0604_insights_raw_usage_api.sql`. They change no billing writer, source policy,
permission row, visibility rule or API contract. They are rolling migrations.

## Maintenance and bootstrap

The migration owner must be `NOSUPERUSER NOBYPASSRLS`. Each bootstrap opens the
documented transaction-local `NO FORCE ROW LEVEL SECURITY` owner window, locks
its source tables, installs the exact-source `AFTER INSERT OR UPDATE OR DELETE`
triggers, aggregates history once and checks convergence before restoring FORCE.
Migration journal replay is idempotent; a failed transaction leaves neither the
bootstrap nor its triggers partially installed. Bootstrap is maintenance-only;
the full-volume historical fence measurements below are not online-rollout proof.

Normal old and current writers append transactional rows to the private
`insights_rollup_invalidations` table instead of locking shared daily groups or
charge links. Rollback also removes those marks. Model reads replace affected
days with authoritative raw inputs; charge reads use raw ledger inputs for a
pending scope, including OLD/NEW scopes after fact moves or late attribution.
There is no automatic reconciliation cadence in this checkpoint.

The schema owner can explicitly call
`opengeni_private.insights_reconcile_rollups(account, workspace, max_source_rows)`
inside a REPEATABLE READ transaction. The default source-row budget is 100,000
(maximum 10,000,000); exceeding it aborts rather than partially publishing.
A nonblocking cache-rebuilder fence does not serialize normal source writers.
Rebuilt caches and deletion of the exact snapshot-visible mark IDs commit
atomically; concurrent unseen invalidations remain pending. The application role
cannot execute this recovery operation. Dirty scopes can retain raw-query cost
until supported owner maintenance runs.

Usage groups retain quantity and source-row count. Model groups retain every
nullable counter's sum and known count, frozen prices/classes, normalized
contributions, and an exact joint timestamp multiset. Invalidated reads and
explicit reconstruction preserve minimum/maximum occurrence and recording
times after source corrections. Uncached input is derived separately per fact only
when input, cache-read and cache-write are all known, nonnegative and consistent.

Actual charge groups come only from negative `model_usage_debit` ledger entries
with `source_type=model_response`. The `turnId:sourceKey` link supplies model
dimensions only when a matching fact exists. Clipped debits, late facts, ledger
and fact mutations, deleted facts and NULL-workspace residual money remain exact;
unmatched money has zero calls and no invented model or tokens. The nominal
`priced_cost_micros` and `model.cost` event amounts are not actual debit authority.

The append-only writer hooks replace the historical shared source/group fences
that introduced an opposing-multirow analytics deadlock. They do not depend on
whole-transaction retries, deferred final flushes or changes to the existing
forced-immediate activity gate. `ON CONFLICT DO NOTHING` source retries do not
append an extra insertion mark.

## Read integration seam

`opengeni_private.insights_rollup_amount_inputs(account uuid, workspace uuid|null,
since timestamptz, until timestamptz, granularity text)` is **SECURITY INVOKER** and
checks the source owner and exact tenant context. It returns the existing narrow
raw-input shape: session/provider/model/payer/schedule, occurrence/recording time,
flat numeric measures, and charge-row flag. Clean complete UTC days use daily
groups; pending model days and incomplete day edges read facts, while dirty
charge scopes and charge edges read the actual ledger. Hourly windows must be
at most one day; day windows must be at most 370 days. Equal bounds return no rows.
Raw model edges are issued separately with scalar timestamp index bounds, not a
join against an estimated edge relation. A complete UTC-day window issues no raw
model query when its cached days are clean. The owner fixture uses
`row_security=off` (fail on RLS, not bypass):
a FORCE-bound raw query is rejected, but complete-day history is still returned
without opening a fact-read capability or changing FORCE posture.

The amount helper is STABLE and read-only: dirty selection, cached/raw inputs
and current debit attribution share its calling SELECT snapshot. This does not
introduce request-wide isolation across separate organization/current/prior
SELECTs. Native column aggregation batches the existing leaf-session, provider,
model, payer, schedule and UTC-bucket grain before JSON and live metadata joins;
per-fact nullable-counter knownness and actual-negative-debit attribution remain
unchanged.

Rolling migration `0613_insights_daily_usage_reader.sql` switches only the two
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

After migration 0613 commits, the existing unified workspace/org usage API selects
daily groups for full days across all six ranges and all eight supported
groupings. The separately merged raw API does not activate this substitution by
itself. Recent/cursor calls and hourly/partial-edge reads remain bounded raw reads.
Existing legacy bundles have separate private rollup seams but are not switched
by this bounded follow-up.
The additive source/custom grain is preserved on the source-extension branch,
not installed here and not a blocker for basic daily reads. No historical list
total is repriced by these migrations.

### Retained-volume full-App uncached diagnostic

On October 4, 2026, the timing-only harness
`apps/api/scripts/bench-insights-daily-http.ts` ran at unchanged start/end head
`dd82c46c26cbd9bc6b03d3b8cbe6a94256dd8932` on a new physical copy of the
838,000-fact/4,170,000-event fixture. Its database was copied from the historical
`78c96261` bootstrap result: this is not a measurement of the UUID correction or
the subsequent concurrency repair. The original datasets were unchanged, and no
migration or seed was replayed.

Each request used the full `createApp`, actual loopback HTTP, a normal canonical
selected organization key, a restricted `opengeni_app` connection with FORCE RLS,
and a fresh App instance with an empty response cache. Both scopes queried
`range=week&groupBy=model`, resolving from `2026-09-27T00:00:00.000Z` through
`2026-10-03T23:59:59.999Z`; the prior window began at
`2026-09-20T00:00:00.001Z` and ended at `2026-09-27T00:00:00.000Z`. These are
seven UTC calendar dates with equal-duration prior, not an exact 168-hour window.

| Scope | First request | Subsequent samples | Empirical p50 / p95 |
| --- | ---: | --- | --- |
| Workspace | 1.661 s | 1.570 s, 1.586 s | 1.570 s / 1.586 s |
| Organization | 4.487 s | 3.985 s, 4.037 s | 3.985 s / 4.037 s |

All six responses were HTTP 200; the sub-one-second target was unmet in both
scopes. Two subsequent samples are only a bounded diagnostic, not final p95
clearance. The dominant database scoped callback took about 1.50–1.52 s for
workspace requests and 3.90–4.40 s for organization requests; other observed
authentication/metadata callbacks were at most about 5 ms each. Nested timing
observations overlap and must not be added together.

The first requests are not true-cold samples: shared PostgreSQL, connection-pool
and OS caches were not flushed. The local PostgreSQL 17.11 instance had a
16.125-CPU quota, 128 MiB shared buffers and 4 MiB work memory. Postmeasurement
`taskset` inspection confirmed postmaster and shell affinity 0–16; the terminated
benchmark process's affinity was not captured by this diagnostic. This is not a
dedicated four-vCPU or real-staging result.

Primary evidence is retained as artifact
`35d7a831-de14-48bc-9432-f0e18146fefc` (310,511 bytes,
SHA-256 `8468d0a1287a93bd370f23561e4137c09273708fb4883ee981fc8e4e7482c031`).
The physical-copy attestation is artifact
`7efa32ca-4f5b-4fcb-b61e-da76544a12d2`. Subsequent repaired-head measurements are
recorded separately below; cached responses and the small DB builder fixture do
not satisfy the uncached target.

### Composed repaired-head retained-volume checkpoint

On October 4, 2026, head `a763ff312233ba9f77307fe65242d88cf773d36a`
combined the completed snapshot/batching repair `28d48b1396d6d8dfcb223ec69d4475084083cb51`,
mechanical migration renumbering `9212564afb44973004b0ef08f8c82aca2009ae5f`,
and inspected main `e64a5a9177e4c2c8528022f9532245ed5874d892`.
The four migration bodies remained byte-identical after renumbering to 0610–0613.
Full-App authorization/raw-oracle parity and release checks passed 14 tests with
536 assertions; DB/Core/API types, 18 unit tests with 146 assertions, ordinal,
schema, FORCE-RLS and test-budget guards also passed. Independent review approved
the limited DB source delta, not the performance or rollout outcome.

One new physical copy of the same 838,000-fact/4,170,000-event fixture ran the
four migrations once. No original, historical allocation or rate snapshot was
changed, and no applied migration was replayed.

| Migration | Total elapsed | Sampled source AccessExclusiveLock hold bounds |
| --- | ---: | --- |
| 0610 | 526.884 s | 526.567–526.884 s on facts and usage events |
| 0611 | 26.261 s | 26.000–26.261 s on facts and credit ledger entries |
| 0612 | 0.231 s | Below the 250 ms sampling resolution; not a no-lock claim |
| 0613 | 0.005 s | No source-table lock observed |

Four normal-app write probes were cancelled with `57014` under explicit LOCAL
10-second diagnostic timeouts; native pool statement/lock timeouts were zero.
Fourteen post-phase probes succeeded and rolled back. Count, amount, knownness,
policy and FORCE parity held, with zero runtime-posture violations before and
after. These source-write fences still require maintenance-only owner disposition;
the append-only steady-state repair does not make bootstrap online-safe.

Both clean and immediately-after-write HTTP runs used the same frozen head,
exact calendar/prior windows described above, normal canonical selected-key
authority, FORCE RLS, and a fresh full App response cache for every timed request.
Each cell below has one separately reported first request and twenty subsequent
samples. All 84 timed responses were HTTP 200 with zero errors.

| State | Scope | First | Subsequent p50 | Subsequent p95 |
| --- | --- | ---: | ---: | ---: |
| Clean | Workspace | 2.187 s | 1.870 s | 1.892 s |
| Clean | Organization | 5.281 s | 4.946 s | 5.177 s |
| Immediately after writes | Workspace | 6.532 s | 6.569 s | 6.686 s |
| Immediately after writes | Organization | 9.703 s | 9.719 s | 9.787 s |

The sub-one-second uncached target is **unmet in both scopes and states**.
Before every dirty request, one ordinary restricted-app fact, warm usage event
and matching negative actual debit committed atomically; no manual reconciliation
ran between samples. Entire current totals, prior totals and unknown coverage
matched the expected wire deltas. The isolated copy gained exactly 42 facts,
42 usage events and 42 ledger rows, requested/list amounts of 4,242/3,066 micros,
and actual debits of 42 micros. Original source data, copy FORCE posture and
migration history were unchanged. All start/end source hashes matched.

The first requests were not true-cold measurements. Both the benchmark and
postmaster affinity were captured as 0–16, with the same PostgreSQL 17.11,
16.125-CPU quota, 128 MiB shared buffers and 4 MiB work memory. This is synthetic
local evidence, not staging p95 or merge/launch clearance.

A subsequent bounded full-App nested-plan diagnostic retained normal selected-key
authority, the restricted app role and the ten-second read budget. Session-local
`auto_explain` captured 12 workspace and 59 organization JSON plans with analysis
and buffers, timing disabled and a 10 ms threshold. Both diagnostic requests
succeeded; their elapsed times are not benchmark samples. The dirty workspace
charge-input queries consumed about 2.7 s current and 2.4 s prior, while daily
model reads took about 90/83 ms and raw model edges about 240/54 ms. The DB owner
received those native plans for a contained helper-local optimization; no query,
privacy projector, source data or global setting was changed by the diagnostic.

A separate comparison against a new copy of the already-built exact-head test
template found all 25 Insights routine definitions, volatility, security-definer
flags and configurations byte-identical to the measured database. Fixture owners
and ACLs are recorded separately; this is not a claim that the template's superuser
owner represents the measured non-superuser FORCE-RLS role.

Retained primary evidence:

- Bootstrap: `3fec20ae-fb68-4f5d-9156-d529f15429bc`, 6,730,328 bytes,
  SHA-256 `651edb8a8191454723604c72c64be2291c0e974f75674420880674722673bf9c`.
- Physical-copy attestation: `e8ac4f90-b183-466d-921b-be01566c7f13`, 94,505 bytes,
  SHA-256 `ce2faf2969d07fea39dcb7a59e353ff80551c68d26cb0eabab8165a7c7ef468c`.
- Clean HTTP: `31fce32c-520e-4e9f-afdc-eaf62d8d92e3`, 537,508 bytes,
  SHA-256 `63b3f81e3913600e769d7077dd53f96f865a4adb094880b6c6e5bf37ac72cbb3`.
- Dirty HTTP: `238bfb61-5b86-4545-b137-b0fbcf17561e`, 635,064 bytes,
  SHA-256 `56248b0532ca915eae59eeb667e2d831644aaba95bc45827d220feb841a7606b`.
- Routine provenance: `845bec4a-c398-43d6-9c61-3f17bc80463b`, 37,874 bytes,
  SHA-256 `a0f30addcf188c2c0165ea54fc2fee888da01d1ea0e2a3cd1c4ca94832830003`.
- Native plans: `15a47f77-3d11-4b09-9ce4-c333d000e016`, 3,987,720 bytes,
  SHA-256 `10d5c830c3638e9cc06a02e089abb2a6e891a5c686c00b38b01fce73279ecb1e`.

### Read-input optimization retained-volume checkpoint

On October 4, 2026, composed head
`0c7caf63ae100623736de031a9a51f5d3bed3208` incorporated the independently
source-approved DB input delta `ed04a773b8a36d406d5f79f37c71c9c1edc129e1`
and the actual `33d2a7cccb435251a1538676c537107f7e650636` main composition.
The latter already included the coordinator's raw-adapter optimization; these
results must not be attributed to the DB delta alone. The two imported DB file
bodies matched the immutable bundle. SQL outside `insights_charge_window` and
`insights_rollup_amount_inputs` remained byte-identical, including bootstrap,
source hooks, reconciliation and grants.

The read delta reuses a clean edge day's cache only after an authoritative
excluded-record absence proof in the same STABLE snapshot. It does not round the
caller window or reuse a pending day. Dirty negative debits use typed UUID-prefix
and exact source-key lookups through the existing full source index. The nested
loop setting is local to the charge helper and restored for its caller. Its
required owner/app PostgreSQL suite passed 129 tests and 2,226 assertions, with
one heavy historical fixture filtered. Independent source review found no new
correctness, privacy or ACL defect; it did not rerun PostgreSQL tests.

The composed head passed 14 full-App/release tests with 536 assertions, including
fresh actual-auth daily-versus-raw full-response parity; 93 runtime/API/Core units
with 635 assertions; touched type checks; migration, FORCE-RLS, test-budget and
documentation guards; and lint. These are correctness checks, not latency
acceptance.

A new attested physical copy of the unchanged 838,000-fact/4,170,000-event fixture
received 0610–0613 once. No prior migration was replayed, no source history was
reseeded, and no comparison catalog or allocation was invoked. Bootstrap phases
committed in 526.511 s, 26.375 s, 0.233 s and 0.005 s respectively. Source
AccessExclusiveLock sampled hold bounds were 526.083–526.511 s for 0610 and
25.998–26.375 s for 0611, retaining the material maintenance-window disruption.
No source lock was observed during the latter two phases at 250 ms resolution;
this is not a no-lock claim. Four normal-app probes were cancelled under LOCAL
10-second diagnostic budgets; native statement/lock timeouts remained zero.
Three baseline and fourteen post-phase writes completed and deliberately rolled
back. Counts, amounts, checked knownness, policies, FORCE posture and original
history matched, with zero current runtime-posture violations before and after.

Each following HTTP case used actual full `createApp`, canonical selected-key
authorization, the normal non-superuser/NOBYPASSRLS role and a fresh response
cache for every request. Both clean and immediately-after-write dirty states had
one first request and twenty subsequent MISS samples per scope: 84 HTTP 200s in
total, no errors. Current/prior windows matched the earlier exact frozen calendar
windows; no range was shortened to meet the target.

| State | Scope | First | Subsequent p50 | Subsequent p95 |
| --- | --- | ---: | ---: | ---: |
| Clean | Workspace | 1,896.2 ms | 1,613.6 ms | 1,643.3 ms |
| Clean | Organization | 4,961.1 ms | 4,564.8 ms | 4,804.2 ms |
| Dirty | Workspace | 2,656.9 ms | 1,820.2 ms | 1,873.1 ms |
| Dirty | Organization | 5,313.6 ms | 5,368.9 ms | 5,699.6 ms |

The uncached sub-one-second target remains **unmet in both scopes and states**.
Before every dirty request, an ordinary fact, warm event and matching negative
debit committed atomically without intervening reconciliation. All complete
current/prior totals and unknown coverage matched expected wire deltas. Only the
isolated copy gained 42 facts/events/debits and 4,242/3,066/-42 requested/list/actual
micros. Original data and source/head hashes remained unchanged. Shared PG/OS
caches were not flushed: there were zero true-cold samples. The environment was
still PostgreSQL 17.11, affinity 0–16, a 16.125-CPU quota, 128 MiB shared buffers
and 4 MiB work memory, not a dedicated four-vCPU or staging run.

Two subsequent full-App nested-plan diagnostics returned 200 with 11 workspace
and 55 organization parsed plans, preserving normal authority and the read
budget. Their elapsed times are not benchmark samples. They confirm dirty fact
attribution now uses the full workspace/turn/source index, one row per lookup
over 3,608 prior and 5,450 current debits rather than scanning 502,514 facts.
However, clean organization charge-edge branches still scan the 276,568-link
history twice per workspace/window; one zero-output scope discards all 276,568
rows twice. Other clean scoped projectors consume roughly 0.36–0.43 s and
54–55 thousand shared-read blocks for three or four output rows. Scalar edge
gating and nullable-workspace index predicates remain concrete input-helper
optimization candidates, not a proven repair or authority to change the privacy
projector. This checkpoint is not merge, staging p95 or rollout clearance.

Retained primary evidence:

- Targeted combined-head checks: `41967f59-a1bf-40e8-98b6-89b380993003`,
  SHA-256 `25915522ded120983516efc4b927ab0a0544d752dac9ce955c4b210e597f9abc`.
- Bootstrap: `3465575a-179c-4427-a00d-5ec2bc2658c7`, 6,725,145 bytes,
  SHA-256 `7d861e90ed8da69f9f807e97b899a5b3a8594f016f3bb09771f97d66b0539a36`.
- Physical-copy attestation: `98665213-27ca-4ace-9b9e-5e1aae988bf9`, 94,505 bytes,
  SHA-256 `8f9235b3d64d8c7be935e0d836cd7703a85489111d178d0dff08689975afdfaa`.
- Clean HTTP: `dc4f38e2-4221-4b21-9036-20448126bce2`, 537,559 bytes,
  SHA-256 `6e754f94839d70ec641d12661eacec65e551f28446ba4466a8ea8a6e3b91105d`.
- Dirty HTTP: `74fbfed5-2ba8-4a45-a7bd-af38845aa475`, 635,127 bytes,
  SHA-256 `aad2b212b45fecf94f33d3983ed5bb5fe3983cdd4bba6a9608c8c0b7a26c7b71`.
- Native plans: `2e20777b-6c90-4bff-a2b5-681fe155b705`, 4,056,419 bytes,
  SHA-256 `21c5d1a112a12fd576935d29a3ec985b8e44d3b8e64585ab078b59d319a80dc2`.
- Executed native-plan runner: `050bb366-de33-49a4-9719-0b9c192766ce`, 9,615 bytes,
  SHA-256 `de96bfe0c320f6258acd0e5aad4689341c61692ce11bc9685d981011c90c5021`.

For a later read-helper-only revision, the local copy harness can bind the
completed dirty receipt by SHA-256 and physically clone that measured database.
It preserves, rather than deletes, the 42 deliberate test records: the next
baseline is explicitly 838,042 facts and 4,170,042 events. Counts, amounts, FORCE
posture and migration history must match the completed parent receipt exactly.
This is not a new pristine 838,000-fact seed or permission to replay migrations.

`apps/api/scripts/prepare-insights-retained-readers.ts` is a copy-only laboratory
step. It obtains the two approved reader definitions from the source-built native
test schema, verifies all other Insights definitions are unchanged, replaces
only those readers under the preserved owner, and checks identities, ownership,
ACLs and configuration. One bounded owner repeatable-read reconciliation makes
the copy clean before measurements; it records its duration and explicit
10-million-source-row budget, then independently compares cache call/token/money/
knownness and usage/debit counts and quantities to raw source aggregates.
No refresh is allowed between the subsequent dirty
samples. The HTTP harness requires completed exact-head preparation evidence for
this descendant-copy lane. This procedure changes neither the original fixture
nor deployment history, and establishes no automatic production maintenance
cadence or performance acceptance.

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
volume measurement; at that UUID-only checkpoint the changed 0607 bootstrap had
not yet been timed at that volume. The composed repaired-head measurement above
subsequently timed its renumbered 0611 body.

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

The subsequent immutable DB checkpoint
`77dad806ace707f424d7ce41fdc687ef1d1e6fd0` replaces shared writer-cache mutation
with the append-only invalidation and owner-reconciliation design above. Its
executed opposing multirow and mixed-stream regressions make both transactions
commit, including forced-immediate constraints followed by later writes. The
author reports 125 PostgreSQL tests and 1,771 assertions; those tests are not a
retained-volume latency or bootstrap measurement.

Checkpoint `28d48b1396d6d8dfcb223ec69d4475084083cb51` then pins the read-only amount
helper to a single calling SELECT snapshot. Frozen-reader red versus repaired
green tests exercise a concurrent clean-to-dirty fact move and debit correction,
plus move/delete/insert interleavings. A 192-input-row fixture batches to two
rows with identical measures and timestamps. Its exact-head owner/app suite
passes 127 tests and 2,179 assertions, including existing mutation, knownness,
privacy and frozen-runtime checks. This is focused correctness and row-reduction
evidence, not the full-App sub-second acceptance result; maintenance cadence and
dirty-charge scan cost remain explicit limits.

## Versioned historical list-class allocation

Rolling migration `0612_insights_historical_list_allocations.sql` adds a private
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