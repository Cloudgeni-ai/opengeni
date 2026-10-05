# WIP: worker shutdown sandbox recovery

Snapshot: October 5, 2026, 01:54 UTC. Work stopped at the user's request.

This branch is an incomplete investigation and partial fix, not a release-ready
solution. Do not infer that the production incident's complete causal chain has
been proven. No PR or merge is authorized. The original task and delegated work
are paused.

## Changes included

- `apps/worker/src/sandbox-resume.ts`: after successful warm publication, spawner
  cleanup releases its holder instead of terminating the published box. Before
  unpublished cleanup, it rereads the exact warming epoch and provider identity;
  missing, unreadable, published, or superseded lease state denies teardown.
- `apps/worker/test/sandbox-resume.test.ts`: real-Postgres regression holds the
  publication transaction's lease lock, cancels with `WORKER_SHUTDOWN`, lets the
  transaction commit, and verifies that a replacement resumes the same box at
  the same published epoch.

The new teardown check is a read, not an atomic provider-teardown ownership
claim. Its remaining race surface needs independent review. Unknown-outcome
setup cleanup and the credential-drain issue below are NOT fixed in this WIP.
No migrations, shutdown-time configuration, runtime APIs, or fallback UX were
changed.

## Verified regression and code-backed chain

The local-backend test uses real leases and RLS, not a mocked publication result:

1. A spawner creates a box and records its exact identity in a warming lease.
2. `commitWarmingToWarm` waits on a real Postgres row lock.
3. Cancellation eagerly releases the attempt's holder without writer-quiescence
   proof. The already-running publication transaction can still commit.
4. The post-commit cancellation check throws. Previously the outer catch treated
   the published box as an unpublished creation and physically terminated it.
5. A replacement would then encounter provider loss despite a durable published
   lease. Without a complete archive, the provider-loss path can mark recovery
   unrecoverable.

Before the change, the new test failed: expected zero physical close calls,
observed two. With the change it passes, preserves the live provider instance,
and proves exact reattachment at epoch 1. This independently reproduces a real
shutdown race; it does NOT establish that this was the production incident's
specific trigger.

## Incident evidence collected so far

The supplied timeline runs from initial provisioning at 01:29:18.282 UTC through
worker-shutdown recovery at 01:29:20.545, replacement start at 01:29:26.079, second
provision operation at 01:29:43.618, and terminal recovery failure at
01:32:31.396 on October 5, 2026.

Read-only incident investigation reported these additional durable/provider facts:

- No completed sandbox envelope or checkpoint was found in the examined lease
  record. Recovery became `archive_unavailable` at 01:32:31.283 UTC.
- The reaper event classified the provider as **missing before capture**. The
  later `sandbox.box.terminated` event is not proof that this reaper killed a
  healthy live box.
- A read-only lookup of the exact Modal box reported it terminated with exit
  code 137. This does not establish when it stopped, who stopped it, or whether
  it was usable when the replacement began.
- Identifier-bearing diagnostic log correlation was still incomplete at stop.

Accordingly, the available evidence points to archive absence, not a proven
`archive_generation !== workspace_generation` failure. The first physical loss
and its timing remain unresolved. No production state was changed.

## Other code-backed findings, not implemented

### Unknown-outcome setup cleanup bypass

The spawner captures `createdEstablished` before setup completes. Modal's inner
`releaseModalCreateFailure` uses `modalCommandStartCleanupIsSafe` to preserve a
physical box after an outcome-unknown Start while closing local transport.
The worker's outer unpublished spawner catch nevertheless invokes
`terminateEstablishedSandbox` and can then reset warming/rematerialization state.
The WIP publication guard does not cover this pre-publication case.

If work resumes, reuse/export the canonical runtime cleanup-safety guard rather
than duplicating its error-graph scanner. Unsafe or incomplete error graphs must
veto physical termination and cold reset, preserve attributed identity and
unresolved admissions, release without fabricated quiescence, and propagate the
typed cause. Do not publish incomplete setup or replay the unknown operation.
Plain cancellation alone does not prove incomplete setup is safe to reuse.

### Committed recovery credential cleanup cannot publish quiescence

The graceful-shutdown recovery transaction closes the exact attempt as
`interrupted_recoverable`, sets activity status to `recovering`, and requests
quiescence acknowledgement. `clearAttemptCredentialsWithSettledFence` permits
its generation-qualified fallback for `idle`, `failed`, and `cancelled`, but not
this committed recovery case.

A delegated in-memory invocation of the production finalizer reproduced:
tools drained, zero credential-provider calls, zero quiescence signals,
`attemptWritersDrained = false`, proof-free release only, and `attempt_fenced`.
No fix was written. Any future fix must use explicit evidence that recovery
closed the exact attempt, not merely allow all `recovering` statuses. Preserve
successor generations and keep wrong fence codes, unknown outcomes, deletion
failure, and unclosed recovery fail-closed.

## Why the delay is not yet proven

The default warming crash-detector TTL is 120 seconds, renewed by the owning
worker's 10-second heartbeat. A replacement can wait on the existing warming
lease rather than create another box. Reaper cadence, stale warming detection,
and the second internal provision attempt are plausible components of the
roughly three-minute delay. The exact expired lease timestamps and reaper/log
correlation were not reconciled before the stop request. Do not present this
timing hypothesis as a completed explanation.

## Graceful drain analysis

The existing shutdown path already drains tracked physical operations; simply
adding a worker-wide drain or extending grace is not yet justified:

- Shutdown stops polling. Activities are cancelled with `WORKER_SHUTDOWN` after
  five seconds.
- The configured force timeout is 100 seconds from shutdown request, leaving
  approximately 95 seconds after cancellation, not 105 seconds total.
- Turn finalization joins tracked starts, remote cancellation, shell sessions,
  retained provider/helper promises, credential cleanup, and any running
  periodic snapshot before proof-bearing holder release.
- Provisioning can detach with late-result disposal. This is not a blanket join
  of every asynchronous provider promise; unresolved operations must retain
  their admission/fence until exact provider exit or loss proof.
- Cancellation and force expiry are not physical quiescence evidence.

The credential fallback bug and outer spawner cleanup bypass deserve attention
before changing shutdown timers.

## Validation at stop

Real Postgres used a disposable local Postgres 17 + pgvector cluster on port
61440, fully migrated isolated test databases, and the restricted application
role with RLS. Test environment:
`OPENGENI_REQUIRE_REAL_DB=1 OPENGENI_TEST_PG_NATIVE=1`.

- Baseline `bun test apps/worker/test/sandbox-resume.test.ts`: exited 0.
- Baseline `bun test apps/worker/test/sandbox-lease.test.ts`: exited 0.
- New publication/shutdown regression: failed before the source fix (two closes
  instead of zero), then passed after the fix (1 pass, 7 expectations).
- Full `bun test apps/worker/test/sandbox-resume.test.ts` after the current
  source changes: retained command receipt confirms exit 0.
- `bun run typecheck`: exit 0; all 36 projects clean.
- `bun run lint` (`oxlint --deny-warnings .`): the recorded run failed on an
  unrelated temporary `packages/db/.pgq-tmp2.ts` unused catch variable. That
  scratch file is not in the current worktree or commit. Lint was not rerun
  after the explicit stop request; do not claim lint green.
- Delegated read-only drain analysis reported 85 focused tests passing and the
  credential-finalizer reproduction above. Two existing runtime cleanup tests
  passed, including unknown-command preservation without a second Start.
- No full final completion audit, finalization fix tests, final lease-suite
  rerun, independent exact-head review, PR CI, or merge was performed.

## If explicitly resumed

Finish exact incident correlation first; distinguish provider disappearance from
reaper termination and determine whether same-epoch attach was actually possible.
Then implement and test only justified small fixes, including unknown-outcome
exit/loss settlement and committed-recovery credential cleanup. Verify the new
teardown authority check against concurrent epoch changes. Preserve closed-write
capture, exact provider identity, epoch fencing, and never-replay invariants.

Existing automatic provider-loss recovery can select a verified checkpoint or an
explicit empty-workspace continuity lane after group-wide quiescence, with a
permanent visible receipt. Its initial authorization occurs before lazy
provisioning; a loss discovered later may miss that opportunity. This is an
unverified routing hypothesis, not an implemented UX fallback or product decision.

Run required real-Postgres suites, typecheck, and warning-denying lint, then obtain
fresh independent review. Do not open a PR or merge without renewed user direction.