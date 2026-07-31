# Sandbox production remediation — 2026-07-30

Status: canonical implementation and rollout contract. Migrations 0138 and
0142 are maintenance-only protocol cutovers; operators must verify the deployed
schema and exact application image before assuming this contract is active.

## Executive conclusion

There is one recurring architectural mistake, not one low-level bug:

> Provider runtime identity was allowed to stand in for durable OpenGeni
> ownership.

It produced several independent defects:

1. OpenGeni configured Modal boxes to die after two hours and had no transition
   before that finite deadline.
2. OpenGeni treated Modal's opaque native snapshot receipt as if Modal promised
   GNU-tar/inode equivalence.
3. Provider snapshots had no durable creation/deletion ledger, so publication
   races and worker crashes could leak Images.
4. Retained process rows copied one provider identity but later reconciliation
   compared them only with the mutable current lease identity.
5. Pre-cutover receipts and process rows lacked the metadata required by the new
   ownership model.
6. Nonretryable recovery failures were re-entered repeatedly within one turn.
7. The `execCommand` fallback framed confined filesystem/Git output only at its
   start, so provider or shell diagnostics appended after stdout could corrupt
   control probes and byte-count records.
8. A durable `warm` lease was treated as provider-liveness proof. Modal could
   terminate the exact box while OpenGeni was idle, leaving a false-live pointer
   that was discovered only inside a later user operation.
9. The private provisioning heartbeat was bound to the lifetime of an
   unresolved provider promise rather than the authoritative turn attempt. A
   workflow could close the attempt while that promise and timer remained
   resident in the worker, indefinitely refreshing a holder for work that no
   longer existed.
10. The 0138 checkpoint trigger treated an adopted legacy checkpoint's capture
    generation as if it had to equal the continually advancing live workspace
    generation. The first successful post-restore workspace mutation therefore
    invalidated the checkpoint that had just restored the box.
11. The global reaper counted holders in one PostgreSQL statement snapshot
    before waiting on a concurrently acquired lease row. It could then commit
    the stale zero count after the acquire, changing the new owner's live lease
    to draining immediately before its first tool mutation.
12. A solo image/rig conflict bypassed the reaper by clearing the live provider
    identity, resume envelope, and checkpoint state directly in `acquireLease`.
    That could both leak the old provider box and discard the only durable
    recovery path.
13. A native Modal checkpoint pauses the source box while the provider creates
    its Image. OpenGeni fenced publication with a generation compare-and-swap
    but did not fence new provider operations during that pause. A newly
    admitted command could therefore reach Modal and fail with `state paused`;
    rejecting the now-stale checkpoint afterward protected recovery truth but
    did not protect the user operation.

These defects interact, but no single flag fixes all of them. The remediation
draws four explicit boundaries:

- the session and mutation ledger are durable OpenGeni truth;
- a sandbox is a finite, replaceable execution instance;
- a native snapshot is an opaque provider artifact with provider-scoped
  ownership;
- a retained process belongs to the exact instance and provider namespace on
  which it started.

## Answers to the disputed points

### Is two hours a Modal hard limit?

No. Production supplied `timeoutSecs=7200`; Modal ended the initiating box at
that exact creation-time deadline. Modal documents a maximum of 24 hours. A
running sandbox cannot have its creation-time timeout extended, so work lasting
longer than one box must cross a native snapshot into a successor.

The new default is 24 hours. This is containment and rotation headroom, not
durability by itself.

### Are 0.125 CPU and 128 MiB automatically resized?

They are default requests that Modal guarantees. A sandbox may burst above them
when spare capacity exists, but that opportunistic burst is not a guaranteed
elastic resize. Sustained under-requesting can still be throttled or OOM.

No evidence connects those defaults to the checkpoint failures investigated
here. Resource tuning is a separate performance/capacity concern.

### What are the tar bytes and where are they stored?

Production uses Modal `snapshot_filesystem`:

- Modal stores the workspace filesystem as an Image.
- the Agents extension returns a small opaque receipt containing the Image ID;
- OpenGeni stores that small receipt and its descriptor in PostgreSQL;
- OpenGeni's new artifact row records ownership/lifecycle for that same Image.

No production workspace tar is stored in this path. The old tar commands merely
streamed the tree into a hash and discarded the stream. That extra verifier was
both expensive and invalid.

The separate `workspacePersistence="tar"` provider mode really does return tar
bytes. It keeps content verification and safe-extraction limits. Moving large
tar payloads from PostgreSQL to object storage is optional future portability
work, not part of the Modal repair.

### Why verify a Modal snapshot at all?

OpenGeni verifies only its own persisted protocol:

- receipt bytes still match their recorded hash and length;
- receipt and descriptor name the same provider, persistence kind, and Image ID;
- the provider binding is canonical and names the Modal server, workspace, and
  environment in which the ID is meaningful;
- publication won the exact lease, epoch, source instance, and mutation-revision
  fence.

OpenGeni does not serialize the restored tree through tar, compare inodes, or
write/verify a marker. Modal owns Image storage and restore semantics. A marker
would add another mutable protocol without proving anything the receipt and
publication fence do not already prove.

### What are retained processes?

A yielded Shell/Terminal execution continues after the initiating tool call
returns. OpenGeni stores a retained-process row plus a non-expiring lease holder
so it can later poll/write/interrupt that exact provider process and truthfully
settle its mutation admission.

That is valid while all of these copied fields still refer to the same physical
execution:

- lease ID and epoch;
- provider backend and instance ID;
- provider binding;
- route and route epoch;
- provider process/session ID.

The old reconciler retried historical rows against a successor lease forever.
In the Master Owner session, 18 rows from epoch 128 had reached 63
`identity_mismatch` attempts while the lease was already cold at epoch 129.
Those stale holders also kept successor refcounts wrong.

A 2026-07-30 10:51 UTC global read found 740 active retained-process rows:
684 already had terminal logical owners and 56 belonged to running turns. The
same read found 19 Modal leases past their drain deadline (one under five
minutes, 16 between five minutes and one hour, and two between one hour and one
day). These are rollout baseline metrics, not proof that every row shares the
same low-level cause.

The later provider-bound preflight at 2026-07-30 16:29 UTC made the false-live
case concrete: PostgreSQL exposed 17 Modal leases as warming/warm/draining, but
exact `Sandbox.poll()` calls found only ten running. Six had already exited 124
at the configured two-hour lifetime and one warming instance had exited 137.
This is why a database lease can look available while Shell/Files/Terminal are
not.

All six exit-124 leases still had a `turn-attempt:<uuid>` holder whose
`last_heartbeat_at` advanced every few seconds even though:

- the owning attempt was `closed`;
- the turn's `active_attempt_id` was null;
- the session workflow had completed; and
- the lease-level `expires_at` was already hours old.

Temporal history for one representative session showed the workflow completing
while the cancelled activity was still physically unwinding. The provider
attach promise never settled, so `resumeBoxForTurn`'s private 10-second
holder-liveness interval outlived the logical activity. That interval refreshed
only the holder row, not the lease deadline, which explains the otherwise
contradictory production state exactly.

A follow-up read at 17:17 UTC applied the complete active-writer predicate
rather than filtering by provider liveness and found nine stale canonical
holders. The original six remained on warm leases pointing at terminal Modal
instances. Three more were refreshing on leases already marked cold with no
instance ID, including attempts whose durable outcome was `completed`. The
cold cases prove that Modal's two-hour exit is not the cause of the holder
leak: the missing ownership fence is. Migration coverage therefore proves both
warm-to-draining repair and cold-state preservation while clearing counters.

The repair probes the exact historical Modal sandbox ID. It settles only from a
durable exit/loss proof and removes only the copied historical holder; it never
changes successor liveness, expiry, or instance identity.

Provider binding is essential. A sandbox ID that is `NotFound` under today's
credential does not prove it was absent under a previous Modal workspace.
Therefore:

- every new retained process resolves the exact live session's Modal workspace
  before its mutating command starts;
- a bound historical row may treat `NotFound` in that same namespace as loss;
- an unbound legacy row is adopted only after Modal positively resolves its
  exact sandbox as running or terminated in the configured namespace;
- `NotFound` alone never assigns a namespace to an unbound legacy row.

### Why can a session look healthy while its sandbox is not?

Conversation/model work and non-sandbox tools can continue without a managed
sandbox. Recent completed turns therefore do not prove that Shell, Files, or
Terminal can establish the lease.

The production investigation found multiple independent failure families:

- a historical two-hour timeout plus a large checkpoint gap, even though newer
  non-sandbox turns could still run;
- a cold lease plus historical retained-process identity backlog, even though
  recent model-only work made the session look healthy;
- an unrelated unknown MCP server ID that surfaced in the same product area but
  did not involve Modal.

`Session event byte accounting did not converge`, subject-owned MCP errors, rig
setup errors, and provider transport uncertainty are separate defects. They must
not be collapsed into “sandbox unavailable.”

## Implemented steady state

### Typed native receipts

The v2 descriptor discriminates:

- `provider_snapshot`: opaque provider receipt, provider/persistence kind,
  snapshot ID, receipt hash/length, and mutation revision;
- `tar_archive`: real OpenGeni-owned tar bytes, tree hash, and extraction limits.

Native capture and restore never invoke the tar/tree fingerprint. Actual tar
capture uses `--hard-dereference` so its own content contract survives a tar
round trip.

### Durable artifact ledger

`sandbox_checkpoint_artifacts` records every Modal Image whose creation result
returns to the OpenGeni process:

- source account/workspace/group/lease plus typed provenance;
- exact capture epoch, instance, and mutation revision for new native captures;
- explicit `legacy_provider_adopted` provenance with the unknowable historical
  capture instance/generation left null, never fabricated;
- canonical non-secret Modal provider binding;
- Image ID, receipt bytes/hash/length, and descriptor;
- lifecycle state and bounded deletion claim metadata.

Lifecycle states are:

`candidate → current → previous → delete_pending → deleting → deleted`

with `delete_failed` as the retry state.

Capture registers `candidate` immediately after the provider returns. Publication
atomically:

1. checks the exact source lease/epoch/instance/mutation revision;
2. refuses only current-identity unsettled writers;
3. promotes the candidate to `current`;
4. rotates the old current to `previous`;
5. marks the displaced previous `delete_pending`.

A candidate that loses publication is also durably `delete_pending`. Current and
previous references are protected by deferred database constraints, so label and
lease-reference state cannot diverge at commit.

The reaper:

- claims at most a bounded batch with `SKIP LOCKED`;
- recovers expired deletion claims after worker death;
- re-resolves the exact configured Modal workspace and compares its canonical
  binding before deletion;
- treats Image `NotFound` as idempotent success only after that binding matches;
- records exponential-backoff failure without dropping ownership;
- keeps deleted tombstones for 30 days, then prunes at most 500 per pass.

OpenGeni pins Modal JS 0.9.0 and passes `ttlMs: null` for both native snapshot
kinds. Modal's 30-day default is not a safe session-recovery lifetime: a
checkpoint remains provider-retained until this ledger proves its exact Image
id unreferenced and completes bounded garbage collection.

This keeps one current and one previous checkpoint per lease. Old Images are not
left around merely because another writer won a race.

Modal exposes neither snapshot listing nor a public caller-supplied idempotency
key in the pinned SDK. There is therefore one irreducible provider-API window:
the worker process can die after Modal commits an Image but before the RPC result
reveals its ID. OpenGeni cannot discover or delete that unknown ID. Local timeout
and cancellation are handled—the still-running promise registers the late Image
and hands it to GC. Registration itself is idempotently retried, so an unknown
database commit outcome is reconciled by reading the immutable artifact row.
OpenGeni never directly deletes after an ambiguous registration failure: the
first transaction may have committed and that Image may already be durable
truth. A hard process death or prolonged database outage in the
response-before-registration interval still requires Modal to provide either
list-by-tag/owner or caller-controlled idempotency. This residual must remain a
tracked provider issue; it must not be hidden by claiming exactly-once creation.

### Restore

Restore selects the durable current artifact, validates receipt integrity and
provider binding, asks Modal to create from that Image, verifies ordinary command
readiness, and publishes the successor under the warming/rematerialization
fence.

No marker and no whole-tree verifier are involved.

`archive_generation` is the immutable generation represented by the current
checkpoint. `workspace_generation` is live mutation intent and advances after
restore. A native artifact binds the former to its exact recorded source
generation. An adopted legacy artifact has no trustworthy historical source
generation, so its archive generation is bound once when the pointer is
attached and cannot be rewritten while that pointer remains current; live
workspace generation may advance independently.

### Provider-pause admission gate

A provider-native checkpoint is an exclusive operation on the source box, not a
read-only observation. Before asking Modal to capture an Image, OpenGeni now
claims the exact lease, epoch, instance, and workspace generation durably. A
claim is admitted only for the exact live turn as the sole holder (or for a
zero-holder drain) with no unsettled mutation admission. A viewer holder may own
an interactive noVNC or PTY tunnel, so it blocks capture and remains attached.
If that skips a periodic turn-end checkpoint, the zero-holder drain path captures
after the viewer detaches or its stale holder is reaped. While the claim exists:

- new lease holders wait outside the transaction and re-read every ownership
  fence until the exact claim releases or the bounded capture budget expires;
- every workspace mutation admission waits for its exact release, rechecking
  attempt and lease ownership on each bounded retry; and
- the in-process provider-operation gate drains ordinary reads, runs the native
  capture exclusively, and withholds later reads until Modal resumes the box.

The local gate is necessary because provider-native reads such as Files probes
can execute commands inside Modal without advancing `workspace_generation`.
The durable sole-holder claim ensures no other normal worker can hold a second
session handle while the exclusive provider operation begins.

Publication must present the exact capture UUID and source generation and clears
the claim in the same transaction that installs the checkpoint. Failure clears
only that exact claim. A caller timeout does not abandon the provider promise:
the owned capture continues to a durable artifact registration/publication or
delete-pending handoff before releasing the gate. The stored deadline is
diagnostic and a recovery threshold, never permission to clear ownership.
Recovery may replace an expired drain claim only after proving zero holders,
zero unsettled admissions, the same provider identity, and either exact command
readiness or definitive provider loss; paused, missing-envelope, timeout, and
ambiguous observations preserve the gate.

Migration 0142 installs this protocol under an exclusive lease-table lock after
all old application writers stop. Its database constraint makes a raw
workspace-generation advance impossible while a capture claim is present, so a
missed application caller fails closed rather than reintroducing the race.

### Lock-first lease reconciliation

Every holder-creating or holder-removing path serializes in the order
`lease row → holder row`. The global reaper first claims at most 500 oldest
live/corrupt leases with `FOR UPDATE SKIP LOCKED`, then deletes stale holders,
recomputes counters, and changes liveness only for that exact claimed set. It
never waits behind an acquire and never applies counts observed before such a
wait. Updating the claimed rows' `updated_at` rotates a larger backlog fairly;
cold leases without holders are not rewritten every 30 seconds.

Stale-holder selection also uses `SKIP LOCKED`, so a heartbeat from an older
rolling writer cannot invert the lock order into a deadlock. A real PostgreSQL
regression holds an in-flight draining→warm rearm open while the global sweep
runs, proves the sweep returns without blocking or changing the lease, commits
the holder, and proves the next sweep retains `warm/refcount=1`.

### Finite-deadline rotation

Each Modal identity persists `provider_created_at`, `provider_deadline_at`, and
rotation state. The global reaper requests rotation in a bounded oldest-deadline
batch one hour before the 24-hour deadline by default. For a shorter explicitly
configured provider lifetime, the default lead and idle grace each cap
themselves at half that lifetime; explicit operator values still win.

The implemented handoff deliberately reuses the existing cold-rematerialization
state machine instead of inventing a second overlapping-box allocator:

1. set `rotation_requested_at`; this fences new mutation admission;
2. attached viewer and direct API holders remain stable-checkpoint blockers
   until normal release or the existing TTL reaper proves a holder stale;
3. a live turn captures an exact stable checkpoint and ends as
   `sandbox_deadline_rotation`;
4. process reconciliation polls and, after the admission fence, may send
   Ctrl-C to that exact retained provider session;
5. once holders reach zero, the reaper captures/publishes once more, terminates
   the old box, and commits the lease cold;
6. the workflow waits at least one snapshot timeout plus two reaper periods,
   then the next fenced attempt restores a successor from the current artifact;
7. successor creation publishes a new instance, epoch, and deadline.

Only one box is routable. No unowned successor exists between provider creation
and lease publication. If capture fails, the old box is not intentionally
terminated; the overdue alert fires while the reaper retries. The provider's
hard deadline remains the final failure boundary, which is why rotation begins
with an hour of headroom.

A solo image or rig change uses this same handoff with
`rotation_reason='operator'`. It preserves the old provider identity and
checkpoint, fences the requesting attempt, and makes the final-holder release
immediately drainable. Only the later cold successor stamps the new image/rig.
A conflicting request while another holder is active remains an explicit
shared-state error and does not disrupt the box.

Every normal worker attach also performs one bounded command-readiness probe
before handing a supposedly warm box to the agent. Authoritative terminal
evidence atomically retires only the exact lease epoch/instance and enters the
existing recoverable supersession path. A provider transport timeout or
ambiguous error leaves the lease untouched; a dead box is never guessed from
generic message text.

### Retry semantics

Nonretryable recovery failures are memoized for the frozen turn, so every later
tool call sees the same terminal result instead of re-entering provisioning.
Ordinary lease supersession remains recoverable. Deadline rotation uses a
workflow-visible delay so the next attempt does not hot-loop while the reaper is
still draining the old instance.

### Attempt-lifetime holder fencing

Provider calls may be uninterruptible, but their database authority is not.
Sandbox provisioning now receives a signal for the complete logical attempt
lifetime. Finalizing the activity aborts that signal even when Temporal did not
deliver cancellation to the SDK call. Abort synchronously:

1. marks the local resume operation released;
2. removes and stops its private holder-liveness interval; and
3. releases the exact database holder.

Every provider-return boundary checks that fence before it may publish or
return a sandbox, so a late provider result cannot resurrect ownership.

The database independently rejects both warmup touches and full lease
heartbeats for canonical `turn-attempt:<uuid>` holders unless the complete
attempt/turn chain is still the active writer: matching account, workspace,
session, turn, execution generation, `active_attempt_id`, and a
`claimed`/`running` attempt state. A rejected touch causes the in-memory resume
operation to release itself. This is the authoritative backstop when an
in-process signal is missed.

Migration 0138 removes canonical turn holders whose ownership chain was already
broken before rollout, recomputes only the affected leases' source-of-truth
counters, and makes now-empty warm leases immediately drainable. It does not
reclassify unrelated leases.

### Confined command framing

Modal-like `execCommand` transports can combine command stdout with provider or
shell diagnostics. Each confined filesystem/Git transport attempt now emits a
fresh nonce-bound start frame and a final status frame from an operation
subshell. OpenGeni accepts only that attempt's exact pair, parses its status
strictly in the shell exit-code range, and returns only the enclosed bytes.
Provider prelude, trailer, delayed earlier-attempt output, and payload lookalikes
cannot authenticate the frame; a missing, truncated, or malformed frame fails
closed.

This fixes a separate current-main regression in bounded Git capture: a trailing
diagnostic could make a valid `HEAD` probe look absent, select the unborn-repo
path, and then reject otherwise valid byte-count output. Tests cover prelude,
trailer, control-marker collisions, replay-distinct nonces, malformed/truncated
frames, large bounded capture, and unborn repositories.

## Legacy compatibility

### Native v1 descriptor

Receipt hash/length and provider identity remain authoritative. Historical tree
metadata is retained for diagnostics but is not used to reject a native restore.
The descriptor upgrades atomically to v2 before restore.

### Descriptor-less native receipt

Automatic adoption is allowed only when:

- bytes parse as a supported native Modal receipt;
- the exact live sandbox proves the Modal provider binding;
- mutation revision is zero and checkpoint revision is null;
- the warming lease lock still sees exactly the same bytes;
- no malformed descriptor is overwritten.

A backend mismatch, tar payload, missing live binding, or mutation gap fails
closed.

### Legacy artifact rows

The reaper scans only warming/warm/draining Modal leases with live instance IDs
and v2 native receipts not yet represented in the artifact table. It proves the
live sandbox under the same provider binding, then registers and attaches the
current or previous slot in one locked transaction.

A cold legacy receipt is not registered under ambient credentials before use.
The restore first materializes it through Modal; the newly active session then
proves its exact authenticated workspace, and the warming/rematerialization
fence atomically registers and attaches that same receipt before the successor
can publish warm. A stale fence writes neither a lease pointer nor an
unreferenced candidate, so GC can never delete an Image still carried only by a
legacy slot. Subsequent ordinary snapshots rotate the adopted Image through the
same bounded ledger and GC path.

### Mutation gaps

If mutation revision is greater than checkpoint revision, the uncovered
interval cannot be reconstructed after the only provider box is gone. The last
Image may be offered as explicit stale-checkpoint salvage, with the loss interval
and interrupted/outcome-unknown effects visible. It must never be labeled exact
recovery or silently replayed.

## Rollout contract

No code path in this change performs a production repair automatically before
the migration and application rollout.

1. **Preflight**
   - bind the exact Azure subscription/AKS context and Modal workspace;
   - record current lease, retained-process, artifact, rotation, and provider
     inventories;
   - use Modal's control-plane sandbox listing to bind each live instance ID to
     its provider `createdAt` clock and compute its deadline from the currently
     deployed lifetime (two hours for the pre-cutover production cohort);
   - confirm the reaper schedule is running;
   - classify boxes with less than one hour of headroom as urgent rotation
     candidates; do not invent a later deadline for them or delay the cutover
     merely to make the inventory look healthy.
2. **Maintenance migration 0138**
   - stop API, control-worker, and turn-worker application pods first;
   - verify there are no `opengeni_app` sessions in `pg_stat_activity`;
   - keep only the migration identity/job available;
   - run with server statement/lock bounds;
   - remove canonical turn holders whose exact attempt/turn writer chain is no
     longer live, and recompute only their affected lease counters;
   - adds artifact/deadline/provider-binding state and privileged bounded
     operators;
   - marks existing live Modal identities immediately due for controlled
     rotation because their actual provider creation clocks are unknowable;
   - leaves legacy retained-process bindings null.
3. **Application rollout**
   - start only the new API/control/turn image after 0138 commits; mixed old/new
     application versions are forbidden;
   - ensure new retained processes carry canonical provider bindings;
   - keep the rotation batch size at its safe default of one and the lead at one
     hour. This admits one newly due box per non-overlapping reaper sweep; it is
     the production cohort control, not merely a SQL query cap.
4. **Canary and first production cohort**
   - complete the isolated short-lifetime canary in staging before production
     migration 0138 is allowed to start;
   - after the new production workers start, treat the first automatically
     requested legacy rotation as the production cohort and require its durable
     checkpoint, successor, and cleanup receipts before widening admission;
   - create an isolated sandbox with a deliberately short test timeout;
   - exercise Shell/Files/Terminal across checkpoint, drain, and successor;
   - prove current/previous references and provider Image deletion;
   - never alter a user session or the seeded production test account.
5. **Historical reconciliation**
   - preview counts by owner state and provider binding;
   - allow automatic positive-lookup adoption;
   - keep unbound `NotFound` rows for explicit operator attestation/salvage;
   - preserve before/after receipts; do not weaken current-identity fences.
6. **Cohort expansion**
   - watch overdue rotation, terminal-owner backlog, checkpoint deletion,
     expired drain, orphan termination, and provider API errors;
   - leave the batch at one through at least two clean production rotation
     cycles; raise `OPENGENI_SANDBOX_ROTATION_BATCH_SIZE` only through the
   reviewed deployment configuration, and only when observed provider and
   worker capacity justify servicing more fenced boxes per sweep.

Migration 0140 is a forward-only rolling repair on top of the completed 0138
maintenance cutover. It replaces the checkpoint validator and the
SECURITY-DEFINER global reaper in place, so old and new application pods call
the same corrected database protocol during rollout. It performs no historical
data rewrite. Production verification must prove 0140 recorded, the exact
function bodies installed, no stale active holders, and a cold→restore→shell
mutation→drain→restore cycle before the release is terminal.

Migration 0142 is a second maintenance-only boundary because the capture claim
changes both lease shape and write-admission semantics. Stop every old
API/control/turn writer, reject any remaining `opengeni_app` database session,
apply and verify the migration with the owner identity, reprovision runtime
roles, and only then start the matching application image. Verify the constraint
and partial deadline index from the catalog before traffic resumes.

Rollback may stop requesting new rotations, but must not remove migrations 0138
or 0142 or discard artifact/process/capture ownership rows. Old application code
is not protocol-compatible after either maintenance cutover; fix forward with a
compatible new image. Deleting the ledger would orphan provider resources.

## Alert contract

The default Helm `PrometheusRule` now includes:

- `OpenGeniSandboxRotationOverdue`;
- `OpenGeniSandboxCheckpointDeletionFailed`;
- `OpenGeniRetainedProcessTerminalOwnerBacklog`;
- `OpenGeniSandboxDrainExpired`.

The underlying fixed-label metrics also expose:

- artifacts by lifecycle state and operation outcome;
- requested/overdue/turn-blocked/direct-blocked/process-blocked rotations;
- retained processes by owner state and terminal-owner backlog growth;
- expired draining leases by fixed age bucket.

## Acceptance evidence required before deploy

- all 23 TypeScript projects;
- formatting, lint, diff hygiene, and Ultimate Bug Scanner;
- runtime native/tar/legacy restore suites;
- worker routing, turn recovery, reaper, metrics, and retained-process suites;
- real PostgreSQL migrations 0138, 0140, and 0142, lease/RLS,
  acquire-vs-reaper concurrency, checkpoint-capture-vs-command concurrency, and
  dedicated-schema replay;
- Helm render with all four sandbox alerts;
- isolated live Modal create, hardlink/content snapshot, restore, receipt-bound
  Image deletion, and cleanup.

The release must not be called production-ready if any real-service suite skips
under `OPENGENI_REQUIRE_REAL_DB=1`, if the isolated Modal artifacts are not
cleaned up, or if Linear/master-agent coordination is stale.

Production preflight also found the API's former 512 MiB request / 1 GiB limit
unsafe when a large historical session caused a burst of draft reconciliations.
The client-side event cursor fix removes that burst; the chart now requests
1 GiB and caps at 2 GiB so one malformed or stale client cannot immediately
turn ordinary API pressure into a two-replica OOM loop.
