# Mergify batching draft — not enabled

The adjacent `.mergify.yml` is outside every Mergify discovery path. No App was
installed and no ruleset changed. Copying it to the root needs Bendik's decision,
independent review and the adapter below. This is a prepared configuration, not
a claim that the current native workflow is vendor-compatible.

## Settings and capacity

Serial cumulative batches, two concurrent checks, dynamic batch size 1–16,
30-second maximum fill wait, merge commits, one failed-check retry, automatic
bisection, 45-minute check timeout. At full batches and 20-minute checks, ideal
capacity is `16 × 2 × 60 / 20 = 96 PRs/hour`, before failures and contention.
Unlike native landing limits, these batches share CI. Two 17-job candidates need
34 peak runners, leaving 26 of a hypothetical 60-slot pool for other work. This
is not a reserved pool or a demonstrated full-CI completion guarantee.

Retry at exactly one level: this draft uses `max_checks_retries: 1`; the adapter
must bypass the native in-job retry wrapper, or set vendor retry to zero and keep
that wrapper. Do not multiply retries. Bisection reruns the complete selected
subset, not optional failed-test-only reuse.

Version PRs use a separate one-entry queue with authenticated Version-head full
CI and exact landed-SHA release evidence. Ordinary PRs still batch. Verify that
`merge_method: merge` creates the Version PR's own push and unique full-CI lane;
otherwise stop until descendant-tip admission below is implemented.

## CI adapter required before activation

1. Recognize same-repository draft PRs under `mergify/merge-queue/`, created by the
   installed Mergify App, as combined candidates. Branch prefix alone is not
   provenance. Ordinary PR `Queue ready` remains cheap entry only.
2. Run the existing impact planner and selected source/unit jobs against the exact
   combined base/head. Emit **Queue batch ready** only from that aggregate. The
   current native workflow does not emit it: the draft fails closed until adapted.
3. Trigger heavy CI for batch drafts without requiring `queue-shadow`; preserve
   main full-CI non-cancellation, content audits and exact-head review evidence.
   Extend telemetry to vendor batch/retry/bisection stages.
4. Test a good batch, one flaky retry, a bad throwaway PR, bisection preserving good
   PRs, Version release admission and landed tree equality. Close test PRs afterward.

## Exact operational sequence — only after approval

1. Approve plan, contributor count and App permissions. Install the official
   [Mergify App](https://github.com/apps/mergify) for **Cloudgeni-ai/opengeni only**.
   Resolve its actual Integration App ID; never substitute a guessed ID.
2. Snapshot `gh api repos/Cloudgeni-ai/opengeni/rulesets`, then GET each affected
   main ruleset (currently 16435119) into dated rollback files. Snapshot repository
   merge-method/auto-merge settings. Leave production and immutable-tag rules alone.
3. Land the reviewed adapter and root `.mergify.yml`, validate with Mergify, and
   initially leave `queue-reviewed` absent so no PR can enter. Agents apply that
   label only after posting exact-head full VM and independent-review evidence.
   No automatic queue rule is configured.
4. Preserve the main ruleset while adding `merge` to allowed methods. Keep native
   `merge_queue` disabled; vendor and native enforcement must not coexist.
5. Add the installed Mergify Integration actor in the documented `exempt` mode
   only on affected main/queue-branch rules. This new bypass/write commitment needs
   explicit approval; the draft grants nothing. Preserve zero formal reviews and
   the independent-agent evidence process.
6. Require the provider's **observed** merge-protection context for ordinary writers,
   bound to that App ID, with strict/up-to-date checks off. Discover the real emitted
   context in shadow setup before PUT, rather than guessing and locking main.
   Verify direct non-App merge is denied while an independently reviewed batch can
   land. Mergify must enforce `Queue batch ready` on its combined candidate.
7. Queue a reviewed head with the provider command, verify candidate, landed tree,
   full-CI receipt and Version admission, then notify all merging agents.

There is no unconditional enable command using unknown App/check identities. Use
the snapshot/PUT procedure in [the native runbook](../merge-queue.md) with observed
installation values and a reviewed JSON diff. No setup is performed by this PR.

## Descendant-tip release admission design

If Version and ordinary PRs land in one push, distinguish **Version provenance
SHA** from **release candidate SHA**. Require provenance to be an ancestor of the
candidate on main and verify its complete reviewed parent/head delta. Bind the
full-green status, successful CI attempt, canary images, source manifest and
release artifacts to the **tested descendant tip**, never mix ancestor images
with descendant tests. Audit intervening merge trees and reject unexplained tree
changes. Update stable publication, promotion and Version consumers together;
an ancestry check alone is insufficient. Designed, not implemented in this PR.

## Rollback

Pause vendor intake and stop its queue, retaining active-work evidence. Restore
only affected main rules from snapshots after checking concurrent edits; restore
prior required contexts and remove the App's main bypass together. Do not delete
production/tag rules. Disable/remove the root config through a reviewed PR or
revoke the repository installation if authorized by the incident owner. Keep
non-cancelling full CI and full-green receipts. The native one-command rollback
only disables native enforcement; it does not pause or uninstall Mergify.

Official references checked October 21, 2026:
[configuration](https://docs.mergify.com/configuration/file-format),
[batching/bisection](https://docs.mergify.com/merge-queue/batches),
[retry lifecycle](https://docs.mergify.com/merge-queue/lifecycle),
[rulesets](https://docs.mergify.com/merge-queue/github-rulesets).
