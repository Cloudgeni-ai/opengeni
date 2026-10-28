# Main CI and release candidates

Pull requests land through the [merge batcher](merge-batcher.md), whose batch
CI runs what the combined change affects. `main` itself runs the **full** suite
and builds the release images; releases deploy only a SHA whose full run passed.

## Full CI on main

- `ci.yml` uses a full plan on `main`: every test lane, deployment artifacts,
  the artifact runtime and the release images. With `MAIN_CI_DEFERRED=true`,
  ordinary pushes wait for the cadence in
  [merge-batcher.md](merge-batcher.md#main-ci-cadence); Version merges always
  run in full on their own push.
- Every main run has its own concurrency group (`ci-<run id>-<attempt>`) and is
  never cancelled or replaced once it has started, so each tested SHA keeps its
  own run and receipt. Runner capacity, not workflow concurrency, decides how
  many run at once.
- The API image is the only job behind a protected environment
  (`public-release`). Its `release-image-validation` prerequisite checks every
  other lane first, so approval is requested only after tests, contracts and
  deployment artifacts passed, and a red run finishes red without waiting.
  `main-approval-superseded.yml` cancels older parked approvals, keeping the
  newest five, anything under three hours old and the current `main` SHA.
- Scheduled runs do not publish canary images. Release candidates come from
  successful `push` runs, including a re-run of a deferred push.

## Full-green receipts

When the full aggregate, deployment and image jobs succeed and landed content
is verified, CI publishes a `Full CI` status on the exact `main` SHA and a
`full-green-main-<SHA>` JSON artifact. Find the newest with:

```bash
bun scripts/ci/latest-green-main.ts
```

It returns JSON, never a moving branch name. Release tooling still verifies
`main` ancestry, the exact successful run, image receipts and source admission.
A missing receipt is an error, not permission to use the latest `main` head.

## Landed-content checks

Every push to `main` runs `merge-content.yml`
(`scripts/ci/verify-merge-content.ts`). It recomputes each first-parent merge
with `git merge-tree`, and each squash commit titled `... (#N)` from its parent
and PR #N's head, then compares the complete tree, so a dropped or altered
change is detected. Other single-parent commits are reported as unverified,
never attested. The full-green gate also audits every landing since the
previous full-green SHA, so deferring CI cannot hide a content failure from
release evidence. A mismatch is an incident: stop the batcher
(`MERGE_BATCHER` to anything else), investigate and repair through a PR.

## Version PRs and release admission

Version PRs are opened with `GITHUB_TOKEN`, which starts no pull request
workflows, so `open-version-pr.yml` dispatches both their authenticated full CI
and PR CI on the exact head. With PR CI green and `queue-ready` added, they land
through the batcher alone, as a true merge commit, because release provenance
needs it.

Release source admission accepts an exact-head merge onto a moving `main` only
when the merge keeps that head, the integration base keeps the reviewed base,
and the reviewed file delta equals the landed delta. Extra or overlapping
changes, incomplete trees and missing ancestry fail. Production promotion
(`hotfix/*` and `main` into `production`), canary dispatch and image admission
are separate and unchanged.
