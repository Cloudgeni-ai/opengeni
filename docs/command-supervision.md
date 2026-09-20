# Managed command supervision

The `native-subreaper-v1` protocol is deliberately scoped to stock Linux Modal
non-PTY commands without `runAs`. It proves ordinary descendant quiescence while
the native supervisor survives. It is not hostile same-user code containment,
and it does not cover work delegated to an already running external daemon.
Every other registered writer still needs its own settled authority before a
checkpoint can publish.

## Protocol and ownership

`ModalCommandControl` allocates the invocation UUID, control nonce, socket path,
and client-chosen Modal router execution ID before dispatch. The exact retained
process, immutable descriptor, parent admission and non-TTL holder commit **before**
the provider start RPC. Reservation failure prevents dispatch. The native
executable starts **idle**, with subreaping enabled before any user code. Only the
original successful dispatch path may request `release` after rereading its
committed locator. Ordinary reads/reapers use `status`, never `release`, so a
worker crash before dispatch returns cannot later launch abandoned user code.
The retained-process reaper can cancel that same idle invocation at its provider
deadline. Ambiguous starts are not replayed. A reservation whose provider start
never happened remains truthful incomplete evidence, not fabricated quiescence.

The supervisor uses a single spawning/reaping loop, explicit `SIGCHLD` semantics
without `SIG_IGN` or `SA_NOCLDWAIT`, and pidfds opened before child reaping. There
is no numeric-PID signal fallback. An exited leader does not end supervision:
ordinary double-fork and `setsid` descendants are adopted and drained too. Only
an all-child `waitpid(-1, ..., __WALL | WNOHANG)` returning `ECHILD` permits proof;
an empty process listing, elapsed timeout, shell exit, or successful signal is
not proof.

The Unix control endpoint lives outside `/workspace`. Children do not inherit
control descriptors. A separate authenticated Modal execution runs the installed
native control helper for `release`, `cancel`, `status`, and `ack`. Helper JSON
is not mixed with user stdout/stderr/stdin. The invocation nonce is a credential:
never log it, expose it through command output, or add it to metric labels.

On all-child quiescence, the supervisor closes launch permanently and serves one
immutable invocation-bound receipt. The adapter persists it in PostgreSQL before
ACK. Only ACK allows supervisor exit; the shell exit result is retained in the
receipt separately from provider process termination. A lost proof write can
re-read the receipt; a lost ACK can retry it. After ACK, authenticated router
termination and all remaining output bytes must still be captured. Supervisor
crash or unavailable control without a retained receipt leaves settlement fenced.
Output remains readable during those failures.

## Durable settlement and deadline rotation

Migration `0495` introduces canonical database fences for supervised processes.
The adapter's own terminal check is not the authority: natural completion,
foreground reads, reconciliation, late callbacks, and old writers must all meet
the same database gate before releasing the process, parent admission, or holder.
Immutable supervision identity cannot be stripped to select legacy settlement.
Legacy idle containment excludes every active supervision-key-bearing command,
including malformed metadata. Enrollment, capture claims/replacement, publication
and already-published teardown retries recheck this boundary. The database lease
guard also fences older control writers; readiness requires that guard before
new launches. Only normal authenticated terminal settlement or exact typed
provider loss releases supervised blockers, never observation-error counts.

Exact provider disappearance is a separate typed `lost` transition, not successful
supervision. A transaction-local original-provider binding and deferred database
guard require matching cold/missing-provider recovery truth at commit. Loss keeps
the descriptor, incomplete output and checkpoint generations intact, rejects
affected admissions, and releases only the matching lost process holders. A
separate pristine-invocation path settles authenticated never-started rejection;
it does not assert that the sandbox disappeared. Neither path invents a quiescence
receipt, EOF, exit success, or a fresh checkpoint. Generic late `lost` callbacks
cannot bypass these gates.

Cancellation intent survives claim expiry. It rejects new stdin reservations and
child mutation admissions; existing admitted writes must settle. Reconciliation
requests cancellation for an exact provider-deadline rotation or explicit
background stop, using the original retained provider binding. Ordinary completed
turns preserve adopted background commands. PTY, `runAs`, legacy locators, provider
disappearance, unsupported native primitives, and missing proof never inherit a
lossless-supervision claim or receive an invented descriptor.

New protocol launches require both `OPENGENI_MODAL_COMMAND_SUPERVISION_ENABLED=true`
(default false) and the database readiness gate before provider start. Disabling
new launches does not disable reconciliation of already supervised commands.
Before mutation admission, the resolved instance must also run the bounded
native `capabilities` command successfully over the authenticated task router.
It exercises the same subreaper, pidfd, SIGCHLD, all-child wait and procfs checks
as launch without creating a child or control socket, then returns the protocol.
The checked sandbox/task identity must equal the subsequently reserved command.
Missing/old helpers, unavailable primitives, nonzero exit and malformed responses
reject the call before admission; there is no silent legacy fallback.
Classified sandbox disappearance during preflight uses the same exact-backend
loss transition and stale-route invalidation as an ordinary provider operation,
without admitting or replaying user work. A missing helper alone is not proof
that the sandbox disappeared.
Roll out the descriptor-aware readers and database fences before activating
launches with that flag. Keep the exact tested stock image and native executable together with
the runtime; no PGID fallback is permitted if the executable is missing. Any
separate recovery migration's maintenance requirements still apply independently.
Existing warm boxes must also contain the compatible executable before activation;
changing an image selector does not retrofit a resumed box. Authenticated definite
Start rejection is distinct from ambiguous transport failure and never becomes
a running receipt. Unknown/timeout/cancelled transport outcomes retain the exact
reservation for reconciliation rather than replaying the launch.

Reaper metrics use `opengeni_command_supervision_total` with bounded `outcome`
labels: cancellation intent, retained/missing proof, provider failure, and blocked
checkpoint. Invocation IDs, socket paths, credentials, and command text are not
metric labels.

## Validation boundary

Native failure tests cover descendant adoption, leader-first exit, signal
disposition, clone children, concurrent descendant creation, unsupported
primitives, supervisor crash, and stale handles. Adapter durability tests cover
retention failure, proof/ACK loss, terminal-before-proof, output capture failure,
and reconstruction. A real SIGKILL regression kills a separate worker after native
launch acceptance but before its start call returns: PostgreSQL already contains
the exact reservation, user code remains idle, and the reaper cancels and settles
the same native invocation. Database tests must exercise old SQL writers and
cancellation races, not just adapter mocks.

Shipping additionally requires the isolated exact-image Modal canary: completed
turn with an adopted non-PTY preview server, writes after the previous checkpoint,
deadline cancellation, exact-generation publication and restored-file verification
through two complete rotations. Local native and database tests do not substitute
for that provider conformance evidence.