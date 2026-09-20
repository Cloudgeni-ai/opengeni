# Managed command supervision

The `native-subreaper-v1` protocol is deliberately scoped to stock Linux Modal
non-PTY commands without `runAs`. It proves ordinary descendant quiescence while
the native supervisor survives. It is not hostile same-user code containment,
and it does not cover work delegated to an already running external daemon.
Every other registered writer still needs its own settled authority before a
checkpoint can publish.

## Protocol and ownership

`ModalCommandControl` allocates the invocation UUID, control nonce, socket path,
and client-chosen Modal router execution ID before dispatch. The native executable
starts **idle**, with subreaping enabled before any user code. Its immutable
descriptor is stored with initial process retention. Only a subsequent exact
durable locator read permits `release`. Ambiguous starts are not replayed;
an unretained idle supervisor cannot launch user code or write the workspace.

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

Migration `0493` introduces canonical database fences for supervised processes.
The adapter's own terminal check is not the authority: natural completion,
foreground reads, reconciliation, late callbacks, and old writers must all meet
the same database gate before releasing the process, parent admission, or holder.
Immutable supervision identity cannot be stripped to select legacy settlement.

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
Roll out the descriptor-aware readers and database fences before activating
launches with that flag. Keep the exact tested stock image and native executable together with
the runtime; no PGID fallback is permitted if the executable is missing. Any
separate recovery migration's maintenance requirements still apply independently.
Existing warm boxes must also contain the compatible executable before activation;
changing an image selector does not retrofit a resumed box. A missing binary or
unsupported kernel primitive intentionally leaves that invocation blocked.

Reaper metrics use `opengeni_command_supervision_total` with bounded `outcome`
labels: cancellation intent, retained/missing proof, provider failure, and blocked
checkpoint. Invocation IDs, socket paths, credentials, and command text are not
metric labels.

## Validation boundary

Native failure tests cover descendant adoption, leader-first exit, signal
disposition, clone children, concurrent descendant creation, unsupported
primitives, supervisor crash, and stale handles. Adapter durability tests cover
retention failure, proof/ACK loss, terminal-before-proof, output capture failure,
and reconstruction. Database tests must exercise old SQL writers and cancellation
races, not just adapter mocks.

Shipping additionally requires the isolated exact-image Modal canary: completed
turn with an adopted non-PTY preview server, writes after the previous checkpoint,
deadline cancellation, exact-generation publication and restored-file verification
through two complete rotations. Local native and database tests do not substitute
for that provider conformance evidence.