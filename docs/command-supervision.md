# Managed command supervision

The `native-subreaper-v1` protocol covers stock Linux Modal non-PTY commands
without `runAs`. `native-subreaper-pty-v1` adds inherited controlling-terminal
ownership and genuine shell job control. Both prove ordinary descendant quiescence while
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

Migration `0496` introduces canonical database fences for supervised processes.
The adapter's own terminal check is not the authority: natural completion,
foreground reads, reconciliation, late callbacks, and old writers must all meet
the same database gate before releasing the process, parent admission, or holder.
Immutable supervision identity cannot be stripped to select legacy settlement.
Legacy idle containment excludes every active supervision-key-bearing command,
including malformed metadata, and the containment inventory skips any lease that
holds one. Idle containment records no supervised cancellation intent: the
intent reasons stay `provider_deadline` and `explicit_stop`, and an idle
supervised command keeps its box until one of those paths settles it with proof. Enrollment, capture claims/replacement, publication
and already-published teardown retries recheck this boundary. The one capture a
running supervised command allows is a warm point-in-time checkpoint that runs
around it on its own box (turn heartbeat or idle checkpoint sweep): the claim is
marked concurrent, only the warm fold publishes it one generation behind the
workspace, and the box and command keep running. It never terminates the box or
settles the command, and the receipt stays in the supervisor's memory, not in
the snapshot. The database lease guard (`supervised_command_capture_guard`,
narrowed by migration 0685) admits exactly that claim and fold and still fences
every drain claim, enrollment, publication stamp and other archive change by
older control writers; readiness requires that guard before new launches. Only normal authenticated terminal settlement or exact typed
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
turns preserve adopted background commands. `runAs`, legacy locators, provider
disappearance, unsupported native primitives, and missing proof never inherit a
lossless-supervision claim or receive an invented descriptor.

Optional adopted-command launches require both `OPENGENI_MODAL_COMMAND_SUPERVISION_ENABLED=true`
(default false) and the database readiness gate before provider start. Disabling
new launches does not disable reconciliation of already supervised commands.
Bare stdin-driven shells are permanently turn-owned and require native ownership
before Start independently of that background-launch flag. Trusted turn context
selects the PTY protocol for a PTY shell, or v1 for a pipe-mode shell. This does
not adopt them as session background commands. Their exact-instance capability
and canonical database fences must pass before mutation admission; missing or
old helpers reject the call, never fall back to a process-group wrapper.
Maintenance migration `0693` extends the immutable initial-retention guard to PTY descriptors.
PTY readiness also checks the guard's protocol version, since the five older
trigger names alone certify only v1. Drain old writers before applying it and
start compatible readers with the exact native image before sending these calls;
old warm boxes are not retrofitted by an image-pin update.

## Operator-qualified new groups

Maintenance migration `0694` adds an owner-only qualification ledger. It has no
public session field or model override. Before enrollment, the operator supplies
one reviewed `NativeCommandQualification` to
`publishNativeCommandQualification` in `packages/db/src/native-command-qualification.ts`:
the qualification UUID, exact account/workspace UUIDs, the authenticated human
`creatorSubjectId`, one exact canonical `createIdempotencyKey`, positive activation
generation, immutable server source SHA, exact stock desktop image digest,
the actual immutable Modal `providerImageId` returned by its authenticated
registry preparation, the exact authenticated `providerBindingKey`, both
native protocol names, acceptance evidence SHA-256, and `enrollmentEnabled`.
The handle must own the ledger. Runtime roles receive only the two scoped read
RPCs and cannot publish, enable, modify, or directly read qualification rows.
Startup readiness and every qualification publication/read verify all six
enabled trigger bindings, including the birth, physical enrollment, and private
ledger guards. Missing, disabled, or wrongly bound triggers block admission;
they cannot turn an absent birth receipt into a legacy decision.

A qualification applies only to the new explicit Modal self-group whose
canonical session INSERT has creator kind `subject`, the selected authenticated
subject and the exact selected create key. Other humans, service actors and
probe keys in the same workspace remain outside the cohort. The immutable birth
receipt copies those original creator/key facts and binds them to the owner row;
later session key edits cannot enroll or requalify a group. Canonical keyed
replay after disabling enrollment retains the original birth. Existing groups,
inherited/shared groups, old warm boxes and restored legacy groups never enroll
retrospectively.
The first physical create retains a server-generated qualification descriptor
in the original `provider_create_attempt` before provider dispatch.
API cold attachment and worker creation paths both record this intent at the
original Modal wire boundary and attribute its exact operation before setup.
Lost replies retain the unresolved create receipt and never permit redispatch.
Unknown setup starts after attribution preserve the box and warming fence until
the original invocation can be reconciled; API failure cleanup uses the same
conservative predicate as the Modal runtime.
The actual warming-to-warm transition binds that exact create operation and
immutable qualification to its provider instance and warm epoch. Fresh creates require
the original canonical selector/build preparation and its actual wire image ID
to match the operator's provider-image pin and namespace. A copied intent,
configured `modalImageId`, arbitrary Image object or matching digest text cannot
qualify a fresh box. Old creators without this proof fail before provider I/O.

A filesystem restore uses only the exact currently selected checkpoint image.
Its immutable artifact must match the canonical rematerialization/revision and
link its original lease, epoch and instance to an already qualified predecessor
in the same workspace, group and authenticated namespace. Directory snapshots
also require qualified predecessor lineage while their new box uses the pinned
stock registry image. Invalid or unsupported lineage fails before create
dispatch, preserving the archive and checkpoint reference; it never switches
to a fresh image to bypass the selected snapshot. Each subsequent rotation
retains the same qualification through a fresh physical create receipt.

Every new turn command in a born-qualified group requires native ownership,
including commands later durably adopted in the background. API/core and worker
routing inspect the same birth and physical binding and compare the server's
baked source identity, then probe the exact instance/task for the required
protocol before admission. Missing source, mismatched image/create/epoch or an
incompatible native helper blocks the call without a legacy fallback. Ordinary
durable adoption remains available after its existing ownership transaction.
The global background-launch flag stays false for this cohort path.

`disableNativeCommandEnrollment` disables new births only. Frozen births keep
their qualification; replacement boxes require fresh exact physical binding,
and existing native commands remain reconcilable. Operator qualification and
activation are separate actions from source deployment and image publication.
Record the exact native provider evidence before enabling enrollment; local
kernel, adapter and database tests alone do not qualify an image or cohort.
Before mutation admission, the resolved instance must also run the bounded
native `capabilities` command successfully over the authenticated task router.
It exercises the same subreaper, pidfd, SIGCHLD, all-child wait and procfs checks
as launch without creating a child or control socket, then returns the protocol.
The checked sandbox/task identity must equal the subsequently reserved command.
Missing/old helpers, unavailable primitives, nonzero exit and malformed responses
reject the call before admission; there is no silent legacy fallback.
For PTYs the capability helper itself runs under the same Modal PTY shape and
must return `native-subreaper-pty-v1`. Native launch puts the child in its own
foreground process group before allowing exec, preserving interactive Bash job
control. Cancellation signals native-owned children through pidfds; it never
signals the supervisor's group or enumerates numeric session IDs.
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

## Exit observation for router commands

A native router page reads stdout, stderr and the provider exit poll together.
The poll is a point-in-time status, so it can answer "running" just before the
command exits while both stream reads then reach EOF. When both streams are at
EOF and the exit is still unknown, the same page polls again within its existing
read budget. EOF alone is never exit proof: an exhausted budget or a failed
re-poll keeps the bytes and leaves the exit unknown for the next page.
Internal callers that read once (file writes, Skill checkout) therefore see a
finished command's exit in that read instead of a stale running answer.

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

## Descriptor-free commands

Already unsupervised commands cannot acquire retrospective native ownership.
Empty stdin does not cancel a non-PTY process; Ctrl-C is terminal input only for
an exact PTY. A legacy wrapper's process-group absence is not complete descendant
quiescence when job control, `setsid`, or double fork can escape the group.
These paths have no lossless native claim. Qualification and acceptance must
identify the actual source, image, group, invocation and protocol exercised;
a qualified isolated invocation does not prove prevention for the legacy fleet.
