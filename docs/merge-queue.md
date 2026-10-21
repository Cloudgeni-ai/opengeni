# Main merge queue and full-green release candidates

The checked-in ruleset is **disabled**. Landing workflows does not enable queue
enforcement. Activation needs the rollout owner's explicit go after review.
Production branch rules and release/environment approvals are not changed here.

## Two independent test lanes

`merge-queue.yml` runs on main PRs and `merge_group.checks_requested`. It checks
the actual combined SHA, using the merge group's base SHA (not only the final PR's
diff) and the existing fail-closed impact planner. One required aggregate,
**Queue ready**, requires successful planning, typechecks/static guards and every
selected unit shard. All eight unit shards retain real-PostgreSQL enforcement.
Unknown/global changes expand the plan rather than skip tests. Cancellation,
failure and unexpected skips fail the aggregate. There are no test-budget increases.

Package publication closure, example builds, published-SDK real-service tests,
browser/visual suites, other integrations and images remain in full CI. This is
a new fast lane, not a reduction in full CI coverage. Its 10–15-minute target is
not yet proven: historical planner/source/unit critical paths are closer to
19 minutes. Tune from actual queue profiles, never by increasing budgets or
silently dropping tests.

`ci.yml` uses a **full** plan on every admitted main push. Its existing
`ci-main-push` concurrency group does not cancel the running build; GitHub keeps
only the latest pending build. Hourly full-mode drift runs use that same lane.
Exact Version-PR merge and explicit rerun exceptions retain their existing lanes.
New pushes cannot continually restart the expensive suite. The schedule retries
coverage during quiet periods, but does not publish canary images; release
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
receipt is an error, not permission to substitute the latest main head.

Every push also runs `merge-content.yml`, independently of full-run coalescing.
It recomputes each first-parent two-parent merge with `git merge-tree` and compares
the complete tree, detecting dropped prior changes. Single-parent legacy squash
commits are reported as unverified rather than falsely attested. A mismatch is an
incident: stop queue intake, investigate, and repair via a reviewed PR. This detects
bad landed content; it cannot prevent a provider bug before landing.

## Measured sizing (October 21, 2026, 09:40 UTC)

GitHub API data for the preceding seven days: **835 merges**, **174 in 24 hours**,
**4.97/hour mean**, **25/hour peak rolling hour**. Last 300 main CI runs: 211
cancelled, 59 failed, 28 successful, one running and one pending. Cancellation
counts include superseded pending runs; current main already disabled running
push cancellation before this change.

Twelve recent successful runs give a planner + max(source, unit shards) estimate
of 6.53–21.52 minutes (median about 18.8). This is an estimate from existing jobs,
not an end-to-end queue benchmark; it excludes new runner waits and retries.

Initial settings:

| Setting | Value |
| --- | --- |
| Merge method | `MERGE` |
| Build concurrency | 8 |
| Merge limits | minimum 1, maximum 8 |
| Minimum-group wait | 5 minutes (minimum 1 means no intentional batching delay) |
| Only merge non-failing PRs | yes (`ALLGREEN`) |
| Check timeout | 45 minutes |
| Required status | `Queue ready`, GitHub Actions app 15368 |
| Strict/up-to-date PR check | false; combined queue builds provide freshness |
| Queue bypass actors | none |

**Do not multiply by batch size.** GitHub's merge limits combine successful merges,
not `merge_group` builds. Approximate healthy capacity is `60 × concurrency / T`:
32 PRs/hour at 15 minutes, **24/hour at 20 minutes**, 16/hour at 30 minutes.
The measured 25/hour burst can briefly exceed the 20-minute envelope. A replay of
the week's arrival timestamps with eight slots and fixed 20-minute checks yields
zero p95 waiting time and 13.62 minutes maximum wait **before** checks. This model
assumes healthy checks and sufficient runners; failures invalidate later groups
and lower capacity. It is not a latency guarantee. Eight groups can request up to
72 source/unit runners concurrently, in addition to PR/full CI: observe hosted
runner queuing before increasing concurrency. Do not claim a reserved runner pool.

At launch measure enqueue-to-start, check runtime, completion interval, retry
rate and queue age. If sustained arrivals exceed capacity, prioritize reducing
measured setup/critical-path costs or obtain an explicit runner/vendor decision.
Do not disable checks. Alert/investigate if full completion age exceeds 120 minutes
or queue waiting age exceeds 30 minutes. These are operator thresholds, not a
new unattended alert service.

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
5. Once enabled, `gh pr merge <number> --auto` enqueues; do not specify a conflicting
   squash/rebase method, use `--admin`, invoke the direct merge endpoint or jump
   the queue. Observe merge-group success and the actual landed SHA.
6. A substantive head edit invalidates the evidence: rerun affected full suites
   and independent review. Base movement alone is handled by the queue.

### Bots and release controllers

Version PRs are created with `GITHUB_TOKEN`, so their PR event cannot be relied on
to start CI. The existing authenticated Version-PR full-CI dispatch remains. Only
after admission and completion does it publish `Queue ready` on the exact input
head. The combined merge group still runs the ordinary fast workflow. Version
automation opens/updates PRs; it does not auto-merge them or bypass agent evidence.
Do not update an already reviewed/queued Version PR just to refresh its base.

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
- Native queue is available for organization-owned public repositories; this repo is public. No external vendor is installed. Mergify/Trunk/Aviator/Graphite require separate write-access and commercial decisions; no measured blocker currently justifies that commitment.
