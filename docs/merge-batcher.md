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

A PR leaves the queue with a comment saying why when it conflicts with `main`
or fails CI on its own on top of `main`. Fix it and add the label again.
Pushing a new head while queued simply restarts its batch.

Database migrations need unique numbers, and two PRs can add the same number
without a Git conflict. A queued PR that adds a migration whose number `main`
already uses for another migration leaves the queue right away, with the
`scripts/renumber-migration.ts` command that fixes it, instead of failing a
whole batch. Two queued PRs that add the same number never share a batch.
The numbered directories are listed in `NUMBERED_FILES`
(`scripts/batcher/model.ts`).

## How a batch lands

1. **Collect.** Once the oldest ready PR has waited the batching window
   (3 minutes, `MERGE_BATCHER_WINDOW_SECONDS`), the batcher takes up to 12 ready
   PRs (`MERGE_BATCHER_MAX_BATCH`) in queue order. PRs that change `.github/`,
   `scripts/ci/` or `scripts/batcher/`, and Version PRs, are batched alone.
2. **Build.** It merges the PRs one by one onto the current `main` with
   GitHub's merge API on a scratch branch, and pushes the result with a
   manifest commit as `batch/<id>`. A PR that conflicts with an earlier one in
   the same batch waits for the next batch.
3. **Test.** The push runs `CI` (and any other workflow that runs on
   `batch/**`, such as the previous-binary database check). CI plans the batch
   like a PR: it runs exactly what the combined change affects, including
   integration, end-to-end and browser lanes, from the batch's base on `main`.
   It never builds or publishes images. Failed jobs are retried once to absorb
   flaky tests.
4. **Land.** When every run on the batch tip passed and `main` has not moved,
   each PR lands as **one squash commit**, `<PR title> (#<n>)`, through GitHub's
   merge API, so the PR shows as merged. A Version PR lands as a true merge
   commit, which release provenance needs. After each landing the batcher checks
   that the new `main` tree is exactly the tree CI tested at that point, and
   stops with a comment on the PR if not.
5. **Failures.** A failed batch is split in half and each half is tested in
   turn until the failing PR is found and removed from the queue.

A batch is rebuilt from scratch whenever `main` moves under it, a member gets a
new head or leaves the queue.

## Main CI cadence

`main` itself runs the full CI suite (every test lane plus release images) on a
cadence instead of on every push. With the repository variable
`MAIN_CI_DEFERRED=true`, an ordinary push's CI run cancels itself in its first
job, and `.github/workflows/main-approval-superseded.yml` re-runs the newest
`main` SHA's run when no full run is in progress and the last one started at
least 30 minutes ago (the repository variable `MAIN_CI_INTERVAL_MINUTES`
changes that). Version merges always run in full on their own push.

If that full run fails, the same workflow re-runs its failed jobs once, as the
batcher does for a batch, so one flaky test does not cost `main` its images for
a whole interval. A failure on the retry stays: `main` is broken and needs a fix.

To get a fully tested SHA with images now, re-run that SHA's `CI` run on `main`
(`gh run rerun <id>`). Canary and staging deploys use the newest fully green
`main` SHA as before.

## Operating it

- **See what it would do:** `GITHUB_TOKEN=$(gh auth token) bun scripts/batcher/main.ts --dry-run`.
- **Run a pass now:** `gh workflow run merge-batcher.yml`.
- **Stop landing:** set `MERGE_BATCHER` to anything else. Nothing is lost: the
  queue is the labels, and a leftover `batch/<id>` branch is rebuilt later.
- **Every pass is idempotent.** It reads GitHub, does the next step and exits,
  so a cancelled or failed pass is repaired by the next one (every 5 minutes,
  and whenever PR CI or batch CI finishes or a PR is queued).

