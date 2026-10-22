# Main merge queue and full-green release candidates

The checked-in ruleset is **disabled**. Landing workflows does not enable queue
enforcement. Activation needs the rollout owner's explicit go after review.
Production branch rules and release/environment approvals are not changed here.
This document retains the native-queue measurements and inactive configuration.
The selected in-house batching workflow is documented in
[`merge-batcher.md`](merge-batcher.md); do not enable native enforcement as a
side effect of following the historical commands below.

## Two independent test lanes

`merge-queue.yml` admits main PRs and tests `merge_group.checks_requested`. The PR
entry check is deliberately cheap and explicitly **not test or review evidence**:
agents must first complete the full VM tests, independent review and evidence
comment below. This is an auditable agent process, not a new formal approval or
strict comment-parser gate. Ordinary PRs do not duplicate the hosted fast suite.
The `queue-shadow` label explicitly runs the suite on a PR for pre-rollout timing;
its aggregate is named `Queue shadow result`, never confused with queue admission.

On a merge group it checks
the actual combined SHA, using the merge group's base SHA (not only the final PR's
diff) and the existing fail-closed impact planner. One required aggregate,
**Queue ready**, requires successful planning, typechecks/static guards and every
selected unit shard. The matrix uses one shard per 240 selected files, capped at
sixteen; focused plans no longer allocate sixteen nearly empty jobs. Every shard
retains real-PostgreSQL enforcement and the complete selected inventory.
Unknown/global changes expand the plan rather than skip tests. Cancellation,
failure and unexpected skips fail the aggregate. There are no test-budget increases.

Package publication closure, example builds, published-SDK real-service tests,
browser/visual suites, other integrations and images remain in full CI. This is
a new fast lane, not a reduction in full CI coverage. Its 10–15-minute target is
not yet proven: historical eight-shard planner/source/unit critical paths are closer to
19 minutes. The sixteen-shard variant preserves the exact selected file set and
1200-second per-attempt deadline; it removes the planner's unnecessary dependency
installation and caches the Bun package store, never unchecked node_modules.
Tune from actual queue profiles, never by increasing test budgets or
silently dropping tests.

Failed unit shards retry unchanged inputs **once inside the required job**, before
GitHub can eject a PR and invalidate its successors. Recovery is recorded in
`queue-retry.json`; deterministic failure stays red. Cancellation/signals and the
existing 1200-second deadline do not retry; process-leak exit 70 also stays red.
Attempt profiles use separate `queue-unit-1.json`/`queue-unit-2.json` files and a
recovered flake emits a warning annotation. The new job's 45-minute outer envelope
accommodates two attempts; individual test and attempt budgets remain unchanged.
Native queue has no configured flake-retry switch here.
The draft's 45-minute queue response timeout includes runner waiting and planning;
at the worst-case job envelope it may expire before a retry finishes. Do not treat
the retry as guaranteed under saturation; timeout remains failure, not a waiver.

`ci.yml` uses a **full** plan on every admitted main push. Its existing
`ci-main-push` concurrency group does not cancel the running build; GitHub keeps
only the latest pending build. Weekly service/drift runs use a separate lane and
cannot replace a pending push.
Exact Version-PR merge and explicit rerun exceptions retain their existing lanes.
The full lane uses twelve unit shards after eight-shard run 39580448753 exhausted
its unchanged 1200-second deadline with passing tests. This splits the same
inventory; it does not raise budgets or suppress slow files.
New pushes cannot continually restart the expensive suite. Scheduled coverage
does not publish canary images; release
candidate discovery uses successful **push** runs. No CI design can promise a
green result while tests are failing, runners are unavailable or environment
approvals are held. The operational target is a completed full run every 120
minutes under continuous traffic, not a claimed hard provider wall-clock guarantee.

After the existing full aggregate, deployment and image jobs succeed, and landed
content is verified, CI publishes a `Full CI` status on the exact main SHA and a
`full-green-main-<SHA>` JSON artifact. Discover the latest with:

```bash
bun scripts/ci/latest-green-main.ts
```

This returns JSON, never a moving branch name. Release tooling must still verify
main ancestry, the exact successful CI run, image receipts and its ordinary source
admission. Queue green alone is **not** a release candidate. A missing full-green
receipt is an error, not permission to substitute the latest main head. Discovery
requires the GitHub Actions bot's status linked to the exact successful run attempt.

Every push also runs `merge-content.yml`, independently of full-run coalescing.
It recomputes each first-parent two-parent merge with `git merge-tree` and compares
the complete tree, detecting dropped prior changes. Single-parent legacy squash
commits are reported as unverified rather than falsely attested. A mismatch is an
incident: stop queue intake, investigate, and repair via a reviewed PR. This detects
bad landed content; it cannot prevent a provider bug before landing.
The full-green gate additionally audits every first-parent merge since the prior
full-green SHA (or the check's introduction when no prior receipt exists), so
coalescing a push cannot hide a content failure from release evidence.

## Measured sizing (October 21, 2026, 09:40 UTC)

GitHub API data for the preceding seven days: **835 merges**, **174 in 24 hours**,
**4.97/hour mean**, **25/hour peak rolling hour**. Last 300 main CI runs: 211
cancelled, 59 failed, 28 successful, one running and one pending. Cancellation
counts include superseded pending runs; current main already disabled running
push cancellation before this change.

Twelve recent successful runs give a planner + max(source, unit shards) estimate
of 6.53–21.52 minutes (median about 18.8). This is an estimate from existing jobs,
not an end-to-end queue benchmark; it excludes new runner waits and retries.

Prepared settings (disabled; **not yet a capacity-qualified activation choice**):

| Setting | Value |
| --- | --- |
| Merge method | `MERGE` |
| Build concurrency | 8 |
| Merge limits | minimum 1, maximum 1 |
| Minimum-group wait | 5 minutes (minimum 1 means no intentional batching delay) |
| Only merge non-failing PRs | yes (`ALLGREEN`) |
| Check timeout | 45 minutes |
| Required status | `Queue ready`, GitHub Actions app 15368 |
| Strict/up-to-date PR check | false; combined queue builds provide freshness |
| Queue bypass actors | none |

The one-PR landing limit is a temporary Version-SHA compatibility safeguard, not
the requested CI-sharing batching. It must not be presented as a final throughput
solution. The parent explicitly directed inert landing. On October 21 at 11:04 UTC
the owner chose an in-house batcher using GitHub-hosted CI; native enforcement and
vendor installation remain off. The [Mergify draft](queue-options/mergify-rollout.md)
is retained as an inactive comparison, not the selected rollout path.

**Do not multiply by batch size.** GitHub's merge limits combine successful merges,
not `merge_group` builds. Maximum landing size is one so each Version PR gets its
own exact-SHA push CI; its merge message/branch marker also retains a dedicated
full-CI lane. Approximate healthy capacity is `60 × concurrency / T`:
32 PRs/hour at 15 minutes, **24/hour at 20 minutes**, 16/hour at 30 minutes.
The measured 25/hour burst can briefly exceed the 20-minute envelope. A replay of
the week's arrival timestamps with eight slots and fixed 20-minute checks yields
zero p95 waiting time and 13.62 minutes maximum wait **before** checks. This model
assumes healthy checks and sufficient runners; failures invalidate later groups
and lower capacity. It is not a latency guarantee. Eight groups can request up to
136 source/unit runners concurrently, in addition to full CI: observe hosted
runner queuing before increasing concurrency. Do not claim a reserved runner pool.

At launch measure enqueue-to-start, check runtime, completion interval, retry
rate and queue age. If sustained arrivals exceed capacity, prioritize reducing
measured setup/critical-path costs or obtain an explicit runner/vendor decision.
Do not disable checks. Alert/investigate if full completion age exceeds 120 minutes
or queue waiting age exceeds 30 minutes. These are operator thresholds, not a
new unattended paging service.

### Thirty-day replay and runner budget

The September 21, 2026 10:00 UTC through October 21, 2026 10:00 UTC collection
contains 2,630 created PRs, 2,487 merged PRs and 5,747 CI runs. The longer-window
rolling-hour peak is **27**, so twice that peak is **54/hour**. The busiest creation
day, October 3, has 200 arrivals; the replay duplicates its arrival timestamps to
400/600 for 2×/3×, preserving bursts and idle gaps, rather than pretending arrivals
are uniformly distributed. Of the CI runs, 2,299 cancellations are excluded from
failure calibration. There were no native merge-group runs in this window.

Only 231 PRs have ready-for-review events, and these are not verified merge
readiness. Replay uses explicit creation and ready-for-review/creation proxies.
Created-to-merged median/p95 is 4.20/683.63 minutes, **not queue latency**. In 119
sampled runs, workflow-created to first actual job start is 0.13/16.63 minutes;
candidate construction, native admission and removal times are unavailable.
The continuously emitted report below will replace these unknowns after rollout.

`scripts/ci/queue-replay.ts` takes JSON arrivals and paired duration/job-work samples.
It models an in-order speculative window, failures, one retry, and restart of
successors, including already-green candidates. Its comparison batcher drains all
ready PRs, retries once, then bisects serially. That is a conservative generic model,
not a vendor's optimized parallel bisection. Cancelled speculative work is charged;
cancelled historical runs are never counted as failing PRs. No runner scheduler,
merge conflicts or correlated failure model is inferred.

The original 360-scenario sensitivity matrix uses two arrival proxies, three timing
distributions and four calibrations. Historical first-attempt core red fraction
42.142% is a **stress calibration, not a measured merge-ready PR failure rate**:
historical edits, repeat runs, policy changes and incomplete PR/run attribution
prevent that inference. The illustrative mixed case below assumes 1% permanent
and 4% once-flaky failures. Whole-candidate retry invalidates successors in this
baseline model; the implemented in-job retry can avoid those invalidations.

Baseline creation-proxy replay, minutes (wait means **first CI start**, not landing):

| Model | Current 18.8-minute median: 2× p95 wait / completion | Projected ≤10 minutes: 2× p95 wait / completion | Projected ≤10 minutes: 3× p95 completion |
| --- | ---: | ---: | ---: |
| Native C6 | 623.58 / 642.50 | 87.38 / 99.60 | 382.55 |
| Native C8 | 329.00 / 357.37 | 26.57 / 39.43 | 182.13 |
| Native C12 | 140.48 / 170.20 | 13.02 / 31.55 | 69.42 |
| Native C16 | 60.78 / 93.15 | 4.65 / 28.07 | 47.48 |
| Serial true batch | 699.48 / 1101.43 | 93.00 / 116.70 | 1060.65 |

At projected ≤10 minutes, the 30-day p95 completion is about 20 minutes for native
and 33.73 for serial batching. This does not establish peak capacity: the projection
artificially caps historical duration samples and proportionally reduces work.
The serial batch 2× case uses 102 builds versus native C16's 637, but serialized
bisection makes its tail worse; do not advertise its work savings as a latency win.

Refined replay with `retryWithinCandidate: true` models the implementation's
first failed attempt without invalidating successors. Only failure after the
unchanged retry removes the entry and rebuilds successors. Same arrivals, seed
834 and assumed 1% permanent/4% flaky; each cell is p95 wait / completion:

| Native | Historical current timing, 2× | Projected ≤10 minutes, 2× | Projected ≤10 minutes, 3× |
| --- | ---: | ---: | ---: |
| C6 | 625.03 / 649.48 | 76.60 / 88.98 | 359.63 / 369.63 |
| C8 | 284.75 / 310.27 | 20.40 / 32.08 | 132.15 / 142.90 |
| C12 | 100.48 / 122.60 | 10.40 / 23.37 | 41.15 / 53.95 |
| C16 | 26.32 / 54.53 | 2.13 / 24.62 | 16.67 / 36.57 |

C16 now meets the historical-time **first-start** wait bound in this hypothesis,
but not completion latency and not physical runner capacity. At projected C12/2×,
median wait/completion is 0/10 minutes; p95 completion improves 31.55→23.37 and
invalidations 200→35. The model charges a candidate-level retry, not a measured
single failed shard; it isolates retry policy rather than claiming an exact forecast.
The sixteen refined scenarios preserve the original 360 results in default mode.

GitHub API confirms the **Team** plan and zero registered self-hosted/larger
runners. The standard Team documented default is **60 concurrent jobs**; the
available API only exposes a public-IP limit, not the actual/custom standard-job
quota. Sampled job history proves at least 42 simultaneous runners, not spare
capacity. Duplicate historical successful jobs copied into rerun attempts were
deduplicated before that count. No reserved full-CI runner pool exists.

The new 16-unit + source layout can request 17 jobs per candidate: C6/8/12/16
means 102/136/204/272 peak jobs, **plus full CI and other organization work**.
Sharding improves the critical path only when runners are available; it does not
divide total work. The older eight-shard samples average 120.48 runner-minutes per
build: at 50 PRs/hour, that needs **100.4 average runner slots even without failures**.
The unverified ≤10-minute projection needs 53.79 before failures; the baseline
mixed-failure replay increases this to roughly 67–74 before full CI. At the
longer-window 54/hour target, work demand is still higher.

**Fresh hosted measurement, October 21 at 10:41 UTC:** shadow run 39585134188
passed all sixteen unit shards, with a 9m26s maximum; planning took 29s and total
elapsed time was 10m02s. Source contracts passed type/runtime/changeset/format and
migration checks but failed on the pre-existing stale API snapshot owned by
PR5272; this is not a fully green aggregate. Allocated job work was **130.32
runner-minutes**, a lower bound because source guards stopped early. Thus the
real sharding speedup does **not** support the proportional-work-saving projection
above: 50/hour needs **108.60 average runners**, 54/hour needs **117.29**, before
retries or full CI. This decisive work-conservation limit is why the near-ten-minute
critical path alone does not qualify native activation under a 60-slot default.

**Activation gate:** do not enable if the failure-aware 2× replay exceeds 30-minute
p95 first-start wait at capacity supported by measured runner availability. Current
evidence does not pass that gate. First demonstrate the optimized real critical
path, aggregate failures after in-job retry, actual runner quota and full-CI capacity
reserve; then rerun the model. Merely configuring C16 does not create runners.

## Continuous timing and post-land watch

`queue-health.yml` records JSON after each queue/full-CI completion and reconciles
the last day hourly. Cheap PR-entry completions are filtered before job concurrency.
Event receipts and reconciliation have separate non-cancelling lanes, so PR/queue
traffic cannot displace the hourly reconciliation. It reads provider queue-add/remove events, synthetic commit
timestamps, exact-attempt job starts/finishes and PR merge time. Missing timestamps
remain null; workflow metadata `updated_at` is not substituted for CI completion.
It reports ready → candidate, candidate → CI, CI → result and result → merge, with
separate cancellation/failure counts. Rebuilds count once per enqueue for waiting
percentiles. A rolling-day p95 enqueue-to-CI-start wait over 30 minutes sets
`stopSignal: true` and recommends true batching (option B). Reports are retained
for 30 days; no pre-activation native stage times are invented.

The in-house batcher adds `Batch CI` completion receipts and hourly reconciliation
to the same report. `batchRows` and `batchSummary` contain exact-attempt provider
job timing and separate cancellation/provider-red counts. A provider-red run is
not itself a verified code-failure verdict. These rows deliberately leave ready,
actual build and landing timestamps unknown: deterministic candidate commit dates
are not build timestamps. The controller stage ledger owns those stages and its
rolling-day wait signal; an unknown batch queue wait must not be read as healthy.
Batch collection errors are recorded as unavailable and cannot suppress the
independent full-main alert reconciliation. Provider start delay uses the selected
attempt's `run_started_at`; a retry without that timestamp remains unknown.
Hourly reconciliation contains only the latest attempt of each run, while event
receipts retain each delivered completion. Do not interpret that hourly sample as
the controller's complete retry history.
Historical `queue/shadow-traffic/` runs are reported in separate
`trafficShadowRows` / `trafficShadowSummary` fields; they never contribute to the
live batch provider sample. Historical readiness proxies and reconstruction
artifacts must not be presented as live queue capacity or culprit evidence.

Landing instrumentation does **not** post public comments or issues. Explicit
rollout opt-in `QUEUE_HEALTH_ALERTS=true` enables the hourly/manual reconciliation
lane as the sole public writer. For red **push CI on main**, it comments on the
exact landing PR and appends a deduplicated alert to **Main CI health: failed
full-suite runs**. Event receipts remain read-only. Hourly reconciliation catches
reports coalesced while the event lane was busy. Cancelled, neutral, skipped and unfinished runs never
become failures. The landing PR is an investigation suspect, **not a proven
culprit**: coalesced full CI includes earlier changes too. Compare the last green
SHA and failing leaf, then bisect/reproduce if needed. Once confirmed, revert the
culprit PR first through the queue and fix it afterwards; do not leave main red
while developing a forward fix. There is no automatic blind revert or external
paging integration. A failed full run cannot prove causality alone.

## Agent procedure

1. Freeze the reviewable head. Run `bun run typecheck`, the process-isolated
   `bun run test:unit`, and every relevant complete integration/browser/service
   suite on the VM. Use at most four test workers on the shared staging machine;
   lower that under contention. Isolate services and clean owned resources.
2. Obtain an independent agent review of that head. Formal GitHub approval is not
   required, but the reviewer session and findings must be auditable.
3. Post a PR comment with `Head: <40-character SHA>`, commands, results, relevant
   limitations, `Independent reviewer: <session>`, and findings resolved.
4. Explicitly call out any threshold/budget increase or test skip/coverage
   reduction. Label `test-policy-change`; the reviewer must confirm it explicitly.
5. For the inactive native option only, `gh pr merge <number> --auto` enqueues; do not specify a conflicting
   squash/rebase method, use `--admin`, invoke the direct merge endpoint or jump
   the queue. Observe merge-group success and the actual landed SHA.
6. A substantive head edit invalidates the evidence: rerun affected full suites
   and independent review. Base movement alone is handled by the queue.

### Bots and release controllers

Version PRs are created with `GITHUB_TOKEN`, so their PR event cannot be relied on
to start CI. The existing authenticated Version-PR full-CI dispatch remains. Only
after admission and completion does it publish `Queue ready` on the exact input
head. Human label/reopen/push events on that branch never emit even a skipped
check with the `Queue ready` name; manual dispatch is always a shadow result.
The combined merge group still runs the ordinary fast workflow. Version
automation opens/updates PRs; it does not auto-merge them or bypass agent evidence.
Do not update an already reviewed/queued Version PR just to refresh its base.
For the selected in-house batcher, Version PRs retain the real VM-test and
independent-review evidence requirement, then use `queue-ready` with auto-merge
off. They occupy one singleton batch. `Queue ready` from trusted Version CI is
not a substitute for that evidence comment, nor for the batch's `Batch ready`
result. See the before/after-activation procedure in `deployment.md`; no existing
Version merge bot needs a bypass or a fabricated test attestation.

Release source admission accepts an exact-head merge onto moving main only when
the provider merge topology retains that head, the integration base retains the
reviewed base, and the full reviewed file delta matches the landed delta. Extra
or overlapping changes, incomplete trees and missing ancestry still fail. Existing
production promotion, canary dispatch and image admission remain unchanged.

## Rollout — only after the explicit go

First land and independently review this PR using the existing normal squash
path. Observe the fast workflow on a real PR and a complete full push run. Check
current runner saturation and the existing ruleset for concurrent operator edits.
The known main `Protection` ruleset is 16435119 and currently only permits squash;
it must also allow merge commits. Snapshot immediately before mutation:

```bash
repo=Cloudgeni-ai/opengeni
gh api repos/$repo/rulesets/16435119 > main-protection-before.json
gh api repos/$repo --jq '{allow_auto_merge}' > repo-before.json
jq '{name,target,enforcement,conditions,bypass_actors,rules} |
  .rules |= map(if .type == "pull_request" then
    .parameters.allowed_merge_methods |= (. + ["merge"] | unique) else . end)' \
  main-protection-before.json > main-protection-with-merge.json
gh api --method PUT repos/$repo/rulesets/16435119 --input main-protection-with-merge.json
gh api --method PATCH repos/$repo -F allow_auto_merge=true
jq '.enforcement="active"' .github/main-merge-queue.ruleset.json > main-queue-active.json
gh api --method POST repos/$repo/rulesets --input main-queue-active.json > main-queue-created.json
queue_id=$(jq -r .id main-queue-created.json)
gh api repos/$repo/rulesets/$queue_id
gh label create test-policy-change --repo "$repo" --color D93F0B \
  --description 'Explicitly reviewed test coverage, skip, threshold or budget policy change'
```

If the label already exists, keep it. Retain the exact snapshots and created ID.
Never repeat POST after an uncertain response: list rulesets and reconcile first.
Verify current main protection still has zero required formal approvals and no
unintended changes. Enqueue a small real reviewed PR; verify an actual merge_group
run checks the combined SHA, passes `Queue ready`, uses merge commits and produces
a successful post-merge content check. Check the latest full-green JSON separately.

## Rollback and production incidents

The one-command queue rollback (only after incident/rollout-owner authorization) is:

```bash
bun scripts/ci/queue-control.ts disable
```

It resolves the unique named main-only ruleset, preserves its other fields,
disables it and verifies the provider result. `--dry-run` prints the intended
payload without writing. It does not remove production or other branch protections.

Disable only the new queue ruleset by its recorded ID; do not delete other rules.
Stop new enqueueing first and inspect/drain existing entries. Restore auto-merge
and allowed merge methods from the snapshots only after checking for concurrent
operator changes. The existing production hotfix lane is unaffected by this
main-only ruleset. Restore production first through `hotfix/*` → `production`,
then queue the backmerge. If a genuine incident requires exceptional main action,
the incident owner explicitly authorizes temporary queue disablement and records
the reason, evidence and re-enable plan; routine failures are never a bypass.

```bash
gh api repos/$repo/rulesets/$queue_id > main-queue-current.json
jq '{name,target,enforcement,conditions,bypass_actors,rules} | .enforcement="disabled"' \
  main-queue-current.json > main-queue-disabled.json
gh api --method PUT repos/$repo/rulesets/$queue_id --input main-queue-disabled.json
jq '{name,target,enforcement,conditions,bypass_actors,rules}' main-protection-before.json > main-protection-restore.json
gh api --method PUT repos/$repo/rulesets/16435119 --input main-protection-restore.json
gh api --method PATCH repos/$repo --input repo-before.json
```

Workflow rollback is a reviewed revert; leave non-cancelling full CI and green-SHA
discovery in place unless they themselves caused the incident.

## Research

- [GitHub queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue): coupled PR/merge-group checks, merge-limit semantics, failure removal and rebuilds.
- [GitHub's April incident update](https://github.blog/news-insights/company-news/an-update-on-github-availability/): April 23, 2026 affected 658 repositories and 2,092 PRs using **squash** groups of more than one PR. The corrected April 28 report says **merge and rebase were unaffected**, contrary to the initial task summary. We still select MERGE to avoid rewritten queue commits and independently check landed content. The incident was resolved; this is not a claim that future provider regressions are impossible.
- Native queue is available for organization-owned public repositories; this repo is public. No external vendor is installed. Mergify/Trunk/Aviator/Graphite require separate write-access and commercial decisions; capacity findings justify evaluation, not an unauthorized installation.

### Option B: true batching, design only

Native remains the first implementation, but current runner-work demand is a
concrete reason to evaluate batching if optimization/capacity cannot satisfy the
gate. Do not install a vendor or self-hosted writer without the owner's decision.

At 174 merges/day (5,220/month), current seat-based prices are **Mergify Max
$21 × N/month** ($17.85 × N annual-billing monthly equivalent) and **Trunk Team
$18 × N/month**. N is the vendor-defined active contributor/committer count, not
the repository's merge count or automatically the organization's seven GitHub
seats. Mergify's current free Open Source tier does not include Batch; Free
small-team eligibility is unverified. Trunk public-repository counting also needs
confirmation. Its billing documentation still says 50 Team committers while the
current pricing page says unlimited; confirm that discrepancy before purchase.

Trunk is the stronger commercial candidate to evaluate here: its documented
batching includes configurable parallel bisection and the lower published monthly
seat price. An illustrative batch size 4, two concurrent builds, 10-minute checks
has ideal capacity `4 × 2 × 60 / 10 = 48 PRs/hour`; three builds give 72/hour,
before failures, coordination and runner limits. This is design math, not a vendor
benchmark. Our serial simulator is not evidence of Trunk's actual latency.

Core Trunk App permissions: repository read/write Actions, Checks, Contents,
Issues, Pull requests and Workflows; read-only Administration, Commit statuses,
Metadata; organization Events and Members read-only. Optional Direct-to-Queue
needs a separate Sudo app; it is not required by this proposal. Mergify requests
repository read/write Actions, Checks, Contents, Deployments, Issues, Pages,
Pull requests and Workflows; read-only Administration, Commit statuses, Metadata,
Merge queues; organization Administration/Members and dashboard email read-only.
These are documented permissions, **not grants made by this workstream**.

A self-hosted alternative would use one GitHub App/controller lease per main
branch, collect ready PRs, construct a deterministic combined candidate with
`git merge-tree`, test its tip once, and fast-forward main only if both the tested
tree and expected old main SHA still match. A new run includes arrivals since the
previous snapshot and never cancels a valid active run. On red, retry once then
bisect bounded subsets; preserve independent-review/head evidence and retain every
stage/candidate receipt. Changes to base/head invalidate only the affected
candidate. Version commits still need their exact full-CI release evidence.

The selected implementation needs a shadow-only controller, race recovery,
durable ownership, bisection, release admission, audit/rollback and real shadow
evidence before it controls main. Main risks are stale-head races,
partial/uncertain writes, merge conflicts, cross-PR interaction failures, flake
attribution, accidental content loss, privileged writer scope and breaking exact
Version-SHA admission. Do not replace native enforcement with an unreviewed
fast-forward bot. A ready-to-merge PR is still independently reviewed and tested.

Sources checked October 21, 2026:

- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [Mergify pricing](https://mergify.com/pricing), [batching](https://docs.mergify.com/merge-queue/batches), [permissions](https://docs.mergify.com/security/)
- [Trunk pricing](https://www.trunk.io/pricing), [billing](https://docs.trunk.io/setup-and-administration/billing), [batching](https://docs.trunk.io/merge-queue/optimizations/batching), [App permissions](https://docs.trunk.io/setup/integrations/github/trunk-app)

The prepared Mergify file is [`queue-options/.mergify.yml`](queue-options/.mergify.yml),
outside all active discovery paths; [adapter, installation, ruleset, Version and
rollback steps](queue-options/mergify-rollout.md) identify what must be completed
after the owner's provider choice. It passes the current official JSON schema,
but no installed-provider integration or live queue test is claimed.

The supplied Super Merge anecdote (600/day, 79-second CI, 124-second coordination)
could not be independently sourced and is not used as measured evidence here.
