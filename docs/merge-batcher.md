# Merge batcher

The merge batcher lands pull requests on `main` after testing them together.
It is a small GitHub Actions workflow, `.github/workflows/merge-batcher.yml`,
that runs `scripts/batcher/`. It keeps no state of its own: everything it needs
is in GitHub (the queued PRs, one `batch/<id>` branch and that branch's CI). It
is enabled by the repository variable `MERGE_BATCHER=actions` and acts as the
"Opengeni merge batcher" GitHub App, whose key lives in the `merge-batcher`
environment that only `main` can use.

## Queueing a PR

Add the `queue-ready` label or turn on auto-merge (`gh pr merge --auto --squash`).
A queued PR is batched once its **PR CI** check has passed on its exact current
head. Add `queue-priority` as well for an urgent fix: priority PRs are tested
next, as soon as the batch that is already running finishes. A running batch is
never cancelled for one.

## Releasing: a Version PR holds main

A queued Version PR (the `changeset-release/main` branch that the Open Version
PR workflow opens) holds the queue so it lands on a stable `main`:

1. Run the **Open Version PR** workflow, then add `queue-ready` to the PR.
2. The batch already running, if any, still finishes and may land. After
   that, nothing else builds, including priority and CI-change PRs, so `main`
   moves at most once after you queue it. The Version PR gets one comment per
   head saying it holds `main`.
3. Once the Version PR's PR CI passes on its head, it is built alone on that
   `main` and lands as a true merge. Normal batching then resumes, priority
   PRs first.

If the batch that was running lands a file the Version PR also changes, or
its merge conflicts with `main`, the Version PR cannot land as reviewed. It is
never ejected for that: it keeps holding the queue and gets one comment per
head asking for it to be regenerated. Run the Open Version PR workflow again;
do not merge `main` into it. That updates the same PR from the now-stable
`main`, it keeps its label, and it lands next.

A Version PR leaves the queue with a comment, so a broken release never blocks
other work, when its PR CI fails or times out on its current head, or when no
PR CI run has passed or is running on that head an hour after it was queued
or pushed (a cancelled run counts as none: rerun it). A bisection in progress
may be dropped during a hold; its PRs are simply batched again afterwards.

While a Version PR holds the queue, nothing else lands, including a lone
control-plane fix. To land a fix first, remove `queue-ready` from the Version
PR, let the fix land, then queue the Version PR again; to give up on a
release, just remove the label.

The release-plan guard recognizes singleton Version batches by their manifest
and exact parent topology, independently recomputes their complete merge tree,
then reproduces the original Version head from its own base. Consumed changesets
are therefore validated without losing disjoint main changes or skipping the
deterministic Version check.

A PR leaves the queue with a comment saying why when it conflicts with `main`
or fails CI on its own on top of `main`. Fix it and add the label again.
Pushing a new head while queued restarts its batch, unless the new head tests
exactly the same: merging the same `main` into the branch again, or rebasing
it, leaves the batch running, and it lands the new head.

Database migrations need unique numbers, and two PRs can add the same number
without a Git conflict. When `main` already uses the number of a migration a
queued PR adds, the batcher fixes it on the PR's branch instead of failing a
whole batch: it merges `main` into the branch and moves the migration to the
next free number above `main` and every number other queued PRs add (or were
moved to earlier in the same pass), renaming its companion tests and rewriting
references in the PR's changed files, as `scripts/renumber-migration.ts
--next` does. The PR's later migrations move with it, so they keep their
order. It does this through GitHub's API with the planner from `main`, so it
never runs PR code, and it only fast-forwards the branch. The PR stays queued,
a comment says what moved, and it is batched once PR CI passes on the new head.
If the move needs judgment (a Git conflict, a changed file that names the
number without naming the migration, a changed text file it cannot read, a
branch GitHub will not update, or any other failure), the PR leaves the queue
with the `scripts/renumber-migration.ts` command instead. GitHub being down or
throttling (5xx, 429, a rate-limit 403) or the network failing only postpones
the move to the next pass, and once the branch is updated nothing after it
takes the PR out of the queue. Migrations on the `production` and
release branches are never moved. Two queued PRs that add the same number
never share a batch. The numbered directories are listed in `NUMBERED_FILES`
(`scripts/batcher/model.ts`).

## How a batch lands

1. **Collect.** Once the oldest ready PR has waited the batching window
   (3 minutes, `MERGE_BATCHER_WINDOW_SECONDS`), the batcher takes up to 12 ready
   PRs (`MERGE_BATCHER_MAX_BATCH`) in queue order. PRs that change `.github/`,
   `scripts/ci/` or `scripts/batcher/`, and Version PRs, are batched alone
   (a Version PR first; see above).
2. **Build.** It merges the PRs one by one onto the current `main` with
   GitHub's merge API on a scratch branch, and pushes the result with a
   manifest commit as `batch/<id>`. A PR that conflicts with an earlier one in
   the same batch waits for the next batch.
3. **Test.** The push runs `CI` (and any other workflow that runs on
   `batch/**`, such as the previous-binary database check). CI runs on the
   batch tip exactly what it runs on a `main` push: the full suite
   (`impact.ts --full`, every unit, real-service, end-to-end and browser lane),
   deployment artifacts, the artifact runtime and every workload image. Images
   are built but never pushed or signed, and the API image builds beside the
   lanes instead of waiting for the release-approval gate. A batch passes only
   when `Typecheck and unit tests`, `Deployment artifacts` and
   `Workload image builds` all passed, the same jobs canary admission requires
   on a `main` SHA. Failed jobs are retried once to absorb flaky tests.
4. **Land.** When every run on the batch tip passed and `main` has not moved,
   each PR lands as **one squash commit**, `<PR title> (#<n>)`, through GitHub's
   merge API, so the PR shows as merged. A Version PR lands as a true merge
   commit, which release provenance needs. After each landing the batcher checks
   that the new `main` tree is exactly the tree CI tested at that point, and
   stops with a comment on the PR if not.
5. **Failures.** A failed batch is split in half and each half is tested in
   turn until the failing PR is found and removed from the queue. Priority PRs
   in those halves keep their place in them, so a failed batch of priority PRs
   is split too; a priority PR queued since goes first.

A batch is rebuilt from scratch whenever `main` moves under it, a member leaves
the queue, or a member gets a new head that changes what the batch tests. For a
member's new head, the batcher merges it on a scratch branch at the member's
place in the candidate; when that gives exactly the tree CI is testing there,
the batch carries on and lands the new head (the landed-tree check still
applies). Version PRs always restart.

## Main CI records the batch result

When a batch lands, its last PR's squash commit has exactly the Git tree the
batch's CI run tested. That push's CI run starts with the `Batch receipt` job
(`scripts/ci/batch-receipt.ts`), which finds the batch from the `Batch: <id>`
line in the commit message and checks, failing closed:

- the commit is not a re-run, a Version merge, or a landing that changes
  `.github/` workflows or actions, `scripts/ci/` or `scripts/batcher/`;
- `batch/<id>` has exactly one tested tip, and its latest `CI` run completed
  successfully;
- the tip's manifest names this batch, its tree is the last member's tree, and
  this commit sits on the batch's base with the members landed in order;
- `Explain change impact`, `Typecheck and unit tests`, `Deployment artifacts`
  and `Workload image builds` passed on that run, and its uploaded impact plan
  is `full`.

If all of that holds, the push is **attested**. Its test lanes are skipped,
while deployment artifacts, the artifact runtime, workload images (signed and
pushed as usual), landed-content verification and the `Full CI` status still
run. Its `full-green-main.json`
names the batch run in an `attestation` field. Canary admission accepts it,
because the three required jobs passed on that exact SHA. Release admission
refuses attested receipts, so a production release still needs a SHA tested in
full on `main` (or a descendant of one).

The earlier squash commits of a batch have trees no run tested on their own.
They are **intermediate**: the receipt labels the run "Covered by batch
`<id>` → `<final SHA>`" (the SHA the batch's tested tree landed as), and
nothing else runs, so the run is never red. They get no `Full CI` status and
no required job results, so canary admission refuses them; canary and staging
pick the newest fully green SHA, which is the batch's last commit. The last
commit's landed-content check covers them.

Anything else, including missing or unreadable evidence, runs as before.

## Main CI cadence

`main` itself runs the full CI suite (every test lane plus release images) on a
cadence instead of on every push. With the repository variable
`MAIN_CI_DEFERRED=true`, an ordinary push's CI run cancels itself in its first
job, and `.github/workflows/main-approval-superseded.yml` re-runs the newest
`main` SHA's run when no full run is in progress and the last one started at
least 30 minutes ago (the repository variable `MAIN_CI_INTERVAL_MINUTES`
changes that). Version merges always run in full on their own push.

If a cadence re-run fails, the same workflow re-runs its failed jobs once, as the
batcher does for a batch, so one flaky test does not cost `main` its images for
a whole interval. A failure on the retry stays: `main` is broken and needs a fix.

Batch landings are never deferred: an attested push records its batch's result
and an intermediate one runs nothing else. An attested push still builds the
signed API image, so like every image-building `main` run it waits for the
`public-release` approval, and an older waiting run is cancelled when a newer
`main` push supersedes it. Once approved it completes with a `Full CI` status
that canary admission accepts. Releases are unaffected: a Version merge always
runs in full on its own push, and tested-descendant admission needs a fully
green tip that is not attested.
An attested push's failed jobs (for example a flaky image build) are not retried
automatically: `main` shows red until the next push, or until an operator runs
`gh run rerun --failed <id>` on that run. This can leave `main` red, never
falsely green.

To get a fully tested SHA with images now, re-run that SHA's completed `CI`
run on `main` (`gh run rerun <id>`); a re-run always runs in full. Canary and
staging deploys use the newest fully green `main` SHA as before.

## Operating it

- **See what it would do:** `GITHUB_TOKEN=$(gh auth token) bun scripts/batcher/main.ts --dry-run`.
- **Run a pass now:** `gh workflow run merge-batcher.yml`.
- **Stop landing:** set `MERGE_BATCHER` to anything else. Nothing is lost: the
  queue is the labels, and a leftover `batch/<id>` branch is rebuilt later.
- **Hold main for a release:** queue the Version PR (see
  [Releasing](#releasing-a-version-pr-holds-main)); do not change the window,
  the batch size or other PRs' labels.
- **Every pass is idempotent.** It reads GitHub, does the next step and exits,
  so a cancelled or failed pass is repaired by the next one (every 5 minutes,
  and whenever PR CI or batch CI finishes or a PR is queued).

