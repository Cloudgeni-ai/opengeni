# Opengeni compute (`compute` sandbox backend)

`compute` runs managed sandboxes as Firecracker microVMs on Opengeni compute
(`compute/`). It is opt-in: `OPENGENI_SANDBOX_BACKEND` keeps its default, and a
session uses compute only when compute is selected for it.

A compute sandbox is a **managed sandbox whose provider session is the machine
agent**. Opengeni treats it like Modal for leases, groups, workspace setup,
repositories, Git credentials, secrets and usage, and talks to it exactly like
a Connected Machine: op-stream exec, files and Git over NATS, PTY and desktop
frames over the relay. Transport points key on `usesAgentTransport`
(`selfhosted` or `compute`); lease and provisioning points treat compute as
managed.

## How the agent is reached

The agent inside the sandbox holds no credential and never dials Opengeni. It
talks to its host over vsock; the compute host keeps one WebSocket link to the
**agent gateway** in the API (`OPENGENI_COMPUTE_LINK_URL`, subprotocol
`opengeni.agent-link.v1`) carrying one session per sandbox. The wire contract
is `compute/docs/agent-link.md`; the design is ADR 21 in `compute/docs/adr/`.

The gateway (`apps/api/src/sandbox/compute-gateway.ts`) verifies the host token
and each sandbox ticket (EdDSA, keys from the control service's `/v1/link/keys`),
fences sessions by the control service's owner epoch, claims the agent's connection
instance as the NATS auth callout does, bridges `sub`/`pub`/`msg` with exactly
the agent's NATS permissions, mints relay producer tokens, and renews the claim
every 5 s while the session is open, asleep or not. A sleeping sandbox stays
reachable: a request (a message with a reply subject) makes the host wake it,
and any other message (acks, receipts) waits on the host until the agent next
runs.
A session acts only within its last confirmed lease: when renewals keep
failing past it, the gateway ends the session as `lost` (the host opens it
again) and forwards nothing and mints no relay credential for it meanwhile.
An open that a later epoch overtook while it was in flight is refused as
`stale_epoch` and never evicts the newer session.

Nothing in Opengeni may send a compute agent requests on a timer: every
request wakes the sandbox. Liveness comes from the gateway's session and claim. A
background command on a compute sandbox settles from the agent's pushed
completion; the reconciler claims it only after that push or once it is
retired (connection replaced, enrollment revoked), never to poll it (0860).
A stopping command (Stop, Pause or Cancel) is still claimed, because that
claim delivers the cancellation to the agent. A Stop of one command also
sends the cancellation from the API at once, so the process ends without
waiting for the next maintenance pass; the claim delivers it when that
attempt fails.

A finished command's output, foreground or background, is released where it
is stored, while the agent is live from the command: one `OpRelease` for the
stored exit frame, which the agent answers once it has dropped the command
(LOST, reason RELEASED), so the release is settled from that answer. Nothing
about a released command is left for a later pass.

The agent recovers what the storing process could not finish. When that
process dies before it releases an output, or before it stores it, the agent
still holds the completed operation, and while it does it reports its operation
inventory again (about a minute after completion, then backing off). The API
answers in that same exchange: it ends what Opengeni stored and collects what
it did not, which releases it too (see
[connected-machines.md](connected-machines.md)). The agent starts that
exchange, so a sleeping sandbox neither sends nor receives anything for it.
Housekeeping never sends a compute agent anything to release output: the
reaper only rechecks the obligation in the database, and settles it there once
the sandbox's enrollment is revoked or another agent process holds its
connection, because that agent retains nothing.

Every request Opengeni sends on its own behalf (the release itself, the
collection of output an inventory answer kept, and the reconciler's recovery
query) is a no-wake request (`Opengeni-No-Wake: 1`). The host delivers it only
while the sandbox runs and its agent holds the link, and otherwise answers
`Opengeni-Agent-Unanswered` itself, so housekeeping never wakes a sandbox. An
unanswered release or collection records nothing and is left to the agent's
next inventory; an unanswered recovery query defers its command
(`provider_unanswered`) until the agent reports again, so nothing contacts the
sandbox or its host again on a timer. The transport never depends on what the
database says about the runner, so a failed read cannot turn a recovery query
into a waking one. The gateway logs such a request to a
sandbox it last saw asleep at debug, never as a wake.

Every compute agent serves `OpRelease` and reports its operation inventory
(`capabilities.op_release`). A compute
sandbox runs the agent from its image and never updates it in place, and
compute images are built with an agent from this release or later, so compute
has no attach-and-final-ACK release path. A compute agent whose Hello lacks the
capability comes from an image built with the wrong agent: the API logs it as a
version error and the sandbox's operations are refused until the image is
rebuilt; nothing falls back to polling. That older path remains only for
Connected Machines with older agents, which never sleep, so their attach and
final ACK are answered on the first pass.

A released command never runs again. No start for an operation reaches an
agent later than 15 minutes after its first start attempt
(`OP_START_RESEND_HORIZON_MS`), and the agent keeps the id of every operation
that is gone (released, final-acknowledged, evicted or lost to a restart) for
twice that, by time and never by count, and carries those ids across an
in-place update. A late or duplicate start of a released operation is answered
as released.

The only timers that message an agent are the op stream's credit acks and
silence probes, and they run only while a call is attached to a running
command; they stop when the call returns or yields. Screen-control renewal
needs `credential_renew` (false for compute agents), the automatic updater
skips sandbox enrollments, and machine routes list machines only.

## Lifecycle

- **Create** (`ComputeSandboxClient.create`): Opengeni creates the sandbox's
  enrollment itself (kind `sandbox`, keyless, bound to the sandbox group), then
  calls `POST /v1/sandboxes` with that enrollment's id as the request id
  (retried with the same id and body) and
  `init.agent = {workspace_id, agent_id, workspace_root, desktop}`, then waits
  for the agent to answer through its session.
- **Unfinished creates and orphans**: the enrollment is written before the
  create is sent, and every sandbox carries its deployment's gateway URL, its
  workspace, sandbox group and enrollment in its metadata. A failed create
  cleans up at once when it can: `GET /v1/requests/{id}` finds the sandbox its
  request made, which is deleted before the enrollment is revoked (a request
  the control service has never seen counts as proof of no sandbox only once the
  enrollment is ten minutes old). Whatever is left (a lost answer, a failed
  delete, a worker that crashed between create and commit, a workspace deleted
  with everything in it) is the orphan sweep's: every five minutes the worker's
  reaper maintenance lists this deployment's sandboxes on the control service
  (`sweepComputeOrphans`, filtered by its gateway URL) and, for each one
  older than ten minutes that Opengeni's records no longer name, revokes its
  enrollment and then deletes it. A sandbox is named while its enrollment is
  active and its group's lease holds it (its instance id, or the sandbox or
  enrollment id in the lease envelope's `sessionState.providerState`, where
  the worker writes the provider state) or is warming, since a creator may be
  about to commit it (`computeSandboxNamed`).
  The control service's own inventory is the record, so nothing is lost when Opengeni's
  rows go: a failed revoke deletes nothing, and a failed delete leaves a listed
  sandbox for the next pass. The sweep handles eight orphans at a time and
  ends within one minute or when the activity is cancelled. That budget
  starts before the stale-enrollment reconcile below and covers everything:
  each control service request until its body is read, and each database check and
  revoke. PostgreSQL itself enforces the database deadline: the work sets
  the statement timeout to the time left before the workspace lock wait and
  again before its main statement, so a lock wait or slow statement ends on
  the server by the deadline, whatever the connection pool's state, and no
  other connection's work is ever touched. PostgreSQL never times out
  COMMIT, so the work runs its deferred commit-time work (constraint
  triggers) itself under the same limit just before committing. Work that
  finishes after the deadline, or after the activity is stopped, rolls back
  instead of committing late. The call itself returns by its deadline even
  when an answer or COMMIT is held up on the way. A deadline, a stop or a
  lost connection while COMMIT is in flight is reported as an unknown outcome
  rather than a rollback; every
  sweep step is idempotent and re-checked, so the next pass settles it either
  way. Each sandbox's database work gets at
  most five seconds of the pass. One stalled delete or lock
  therefore never holds up the others or the rest of maintenance. Each pass
  resumes after the last sandbox the previous one reached, and a sandbox whose
  cleanup failed sits out ten minutes, doubling up to an hour, so failures at
  the front of the list never starve the sandboxes behind them. This progress
  lives in the worker's memory; a restarted worker starts again at the oldest
  sandbox. It never
  messages an agent, so it wakes nothing. One control service team serves one Opengeni
  deployment's gateway; the gateway tag keeps a misconfigured second
  deployment's sandboxes out of the sweep.
- **Stale enrollments**: an enrollment whose sandbox is already gone (a delete
  whose revoke failed, a create that never made a sandbox) is in no listing from the control service
  listing, so the same maintenance also revokes, from Opengeni's own records,
  every active sandbox enrollment older than ten minutes whose group's lease
  neither names it (`sessionState.providerState.enrollmentId`) nor is warming
  nor holds a live compute sandbox whose envelope does not say which
  enrollment it runs, so a live sandbox is never revoked whatever a capture
  left in its envelope (migration 0862: a cross-workspace inventory
  of ids under the owner-only read capability, then one revoke per enrollment
  under its workspace's RLS that re-checks the condition). An enrollment
  therefore never stays active for a sandbox that is gone. This reconcile
  gets its own fifteen seconds of the pass, so the listing sweep always keeps
  the rest; it revokes eight enrollments at a time, each within five
  seconds, and sets a failed one aside like a failed sandbox. It reads the
  inventory a page of 100 at a time in enrollment-id order, each pass after
  the last enrollment the previous one reached and from the start again
  after the last page, so enrollments that keep failing never hide the ones
  behind them. One enrollment stuck behind a
  workspace lock therefore delays neither the others nor the sweep.
- **Resume**: re-address the same sandbox by id; no wake is needed. If a request
  finds no responder (no host serves the sandbox, for example mid-move),
  `ComputeWakingControlRpc` asks the control service to wake it and resends under the
  same request id until the agent answers. Every operation re-resolves the
  agent's connection instance. A request bound to a connection instance
  that is no longer the enrollment's live one never wakes the sandbox,
  whether it comes from a turn, a direct request, the API's Stop or the
  reconciler: each transport checks the live instance before it wakes, and
  stops instead. The check reads the enrollment from the database every time
  (nothing is cached in the process), so a new connection recorded by the
  gateway on any API pod ends the old request on every other one. A stop for
  a command bound to a replaced instance never reaches the transport: the
  reconciler's claim settles it by runner retirement.
- **Restart**: when a sandbox's VM dies, the host boots it fresh on its disk
  (programs lost, files kept), and its agent comes back on a new connection
  instance. A request still bound to the old instance ends as soon as the new
  one is live, as on a Connected Machine ("Control transport recovery" in
  `docs/connected-machines.md`): a command that started, or may have, is
  handed to the session's command ledger with a stop request and reported
  with an unknown outcome, a read is read again from the new agent, and the
  request is never moved to the new connection. The reconciler settles the
  handed-over command as lost once the enrollment shows the new connection
  instance; compute runs at most one VM per sandbox (ADR 18), so the old
  agent is gone. Abandoned work therefore neither keeps the lease warm nor
  holds up deleting the chat: a command already asked to stop on the chat's
  own sandbox does not hold the deletion, because ending the group deletes
  the sandbox and the deletion waits for that. A terminal exec whose own
  deadline passes meanwhile gives that same unknown outcome: it reports exit
  124 only when its deadline provably ended the command.
- **Host loss**: compute never brings an agent back rewound. After a host
  loss the sandbox boots fresh on another host from its newest stored copy's
  files (programs end; the guest flushes its disk before each capture, so the
  files are as the guest last wrote them before that copy), and its agent is a
  new process on a new connection instance, exactly as after a VM crash (see
  Restart). A copy handed over by a move or a drain is current, so that
  sandbox keeps its memory and its agent keeps its connection. The agent's
  replay journal therefore makes a request run at most once per agent
  connection instance, and nothing in this backend assumes that an instance
  survives a host loss: a request that may have reached the lost agent ends
  with an unknown outcome once the new instance is live, and only one that
  provably reached no agent is sent to the new one.
- **Link loss**: a request forwarded into a session whose host link then ends
  is not left waiting. When any session ends (its link closed, its lease
  lost, superseded or revoked), the gateway that held it answers every
  request the agent had not yet answered with an empty reply carrying
  `Opengeni-Agent-Link-Lost: 1`, and so does a request it cannot forward
  because its session has ended or the forward fails. The requester takes
  that as a lost attempt, whichever API pod it runs on: a replayable request
  is delivered again under the same delivery identity, to the same connection
  instance (the instance is part of the subject), so it reaches that agent
  wherever its link returns, waking the sandbox if no host serves it yet, and
  it ends as an unknown outcome if that instance has been replaced; a one-shot
  request ends with an unknown outcome, never as unsent. Only a gateway sends
  the marker: it drops the header from anything an agent publishes, and a
  requester reads it only on the reply to its own request (a Connected
  Machine's agent that sent it would only end its own request early, which it
  can already do by not answering). Each session remembers at most 4,096
  unanswered requests; one past that is not forwarded and is told at once, so
  its requester delivers it again; an answer removes its request, and the set
  goes with the session. A stop that reaches the agent before the start it
  stops leaves a tombstone, and the command settles as cancelled with no
  output ("Control transport recovery" in `docs/connected-machines.md`). A
  gateway pod that dies outright sends no such reply; its requests end at
  their own timeout.
- **Request epoch**: compute requests are machine-addressed (epoch 0), like
  `run_on`. The agent in a sandbox has no session route epoch: nothing
  acknowledges its Hello with one, so it holds 0, and a nonzero epoch (the
  lease's or an invented one) would fence nothing there. Ownership is checked
  before each request is sent instead: every operation re-resolves the
  sandbox's active enrollment and live connection, deleting the sandbox
  revokes that enrollment (so a stale session reaches no agent), the gateway
  closes a revoked or superseded session, and the lease's epoch and capture
  fence decide which holder may use or end the box. On the agent, each
  transactional write stays pinned to its exact connection and epoch. Writes
  above 256 KiB need the agent's `transactional_fs_write_machine` capability.
- **Idle**: when the last holder releases a compute lease, nothing is
  captured or deleted. Compute sleeps the sandbox by its own rules and
  keeps memory and disk; Opengeni never drains a compute lease for being idle
  (migration 0859 and the drain points in `packages/db/src/index.ts`). The
  next turn finds the same sandbox and its first request wakes it.
- **Group end**: deleting the chat or workspace marks the lease
  (`group_end_requested_at`, migration 0861) and drains it at once. The reaper
  then deletes the sandbox through the control service without a tar capture and revokes its
  enrollment (after the delete, so a failure leaves it on record for
  the retry). Whether to delete without a capture is read from the lease the
  capture claim returns and checked again under the lease's row lock just
  before the delete (`persistDrainSnapshot` with `groupEndDiscard`): a
  rotation that committed after the reaper read the lease gets its capture,
  and an ineligible delete gives its claim back for the next sweep. The
  lease's capture fence still decides who may terminate the box, and a fence
  loss leaves it for its new owner. The marker is cleared when the lease
  re-arms or goes cold. A browser or desktop an agent left open on the
  sandbox does not keep the group: it stays open while the sandbox sleeps, so
  only the deletion can end it. When nothing else holds the lease and none of
  those resources is mid-operation or mid-transition, the deletion marks them
  lost (`sandbox_deleted`), releases their holders and ends the group in the
  same transaction; otherwise it refuses and the caller retries. It locks
  those browsers and desktops before it decides, so one that begins a
  suspend, resume or end while the deletion waits keeps the group.
- **Capture**: a portable tar only, to move a workspace to another backend
  (rotation and archive capture still drain with a capture). There are no
  warm checkpoints: compute persists the sandbox itself, so the turn-end
  and interval checkpoints other tar backends take are skipped
  (`warmCheckpoints: "forced_only"` in the capture policy; only a forced
  rotation checkpoint runs), and a turn neither reads the workspace nor keeps
  the sandbox awake to do so.
- **Metering**: warm seconds count only while the sandbox is awake. The
  gateway records each `state` change (`recordComputeSandboxPower`): asleep
  stamps `compute_asleep_since`, which caps accrual; awake moves the meter
  cursor past the time asleep. Only the agent's exact current claim reports:
  the enrollment must be active with the session's epoch, connection instance
  and a live claim lease, so a report delayed past a newer epoch's open, or
  one after a revocation, changes nothing. The gateway keeps the host's latest
  reported state apart from the last committed one and writes again on the
  next 5 s tick after a failure, without messaging the agent. A tick that
  accrued before the asleep frame arrived may bill at most one tick of sleep,
  and a write that waits on a failure bills (or skips) the time until it
  lands.

Request windows on compute are at least 130 s, because the host holds a
message up to 120 s while a sandbox wakes from disk.

## Desktop and terminal

`init.agent.desktop` starts the agent with its own virtual desktop, so the
display exists from its first Hello; nothing runs `ensureDisplayStack` over
exec. The viewer mints relay PTY and relay desktop-frame cells against the
group box, fenced by the lease epoch (`apps/api/src/sandbox/viewer.ts`).
BrowserSessions and ComputerSessions on a compute home sandbox use the agent's
native controller, as on a Connected Machine; no controller URL is cached on
the lease (`controllerHasCacheableDataPlane`).

The durable PTY API (`POST .../terminal/pty`, a provider process retained
under the session-home lease) refuses compute sessions with a 409 before any
PTY is opened, as it does for Connected Machines: their terminals are the
viewer's relay PTY streams.

## Ports

Opengeni has no user-facing preview-port feature on any backend. On Modal,
Daytona and Blaxel, tunnels serve only Opengeni's own controller ports (the
browser controller and the desktop's noVNC on 6080; see
`apps/api/src/controller-data-plane.ts` and `viewer.ts`). On compute, the
terminal, desktop and in-sandbox browser reach the agent through relay
streams, so no sandbox port is exposed. Opening one wakes the sandbox, and
its traffic keeps it awake (the agent counts streams with recent traffic as
in use). A future preview-port feature would add a gateway route, not a
change to compute.

## Configuration

| Setting | Meaning |
| --- | --- |
| `OPENGENI_COMPUTE_API_URL`, `OPENGENI_COMPUTE_API_KEY` | Control service API (HTTPS outside local/test) and its key |
| `OPENGENI_COMPUTE_LINK_URL` | The gateway's public `wss://` URL, also the JWT audience |
| `OPENGENI_COMPUTE_IMAGE`, `OPENGENI_COMPUTE_DESKTOP_IMAGE` | Headless and desktop image refs (control service default when unset) |
| `OPENGENI_COMPUTE_VCPUS`, `OPENGENI_COMPUTE_MEMORY_MIB` | Shape; optional `..._MEMORY_REQUEST_MIB` (all of the memory when unset) and `..._CPU_REQUEST_MILLIS` (a tenth of each vCPU when unset), what each sandbox is guaranteed while awake |
| `OPENGENI_COMPUTE_AGENT_READY_TIMEOUT_MS` | How long create and wake wait for the agent |

Defaults are unchanged. Boot fails with a list of the missing settings only
when compute is the deployment backend, and building a compute client fails
the same way when a session selects compute. When the API and link URLs are
set but something else is missing, the gateway logs
`compute_gateway_misconfigured` and stays off. Compute also needs the relay
and NATS like Connected Machines.

## Run as another user

The agent runs as root in the guest, so the descriptor sets `supportsRunAs`.
Each request still gates on the live agent's Hello `capabilities.run_as`,
decided on the exact connection the request is dispatched on. Unlike a
Connected Machine, where an older agent runs commands and reads as its own
account, a compute session refuses any request that names a user when that
connection's agent does not advertise run-as: acting as root instead would
elevate. A reconnect to such an agent between a capability check and the
dispatch therefore ends in a refusal, never a dropped user. This holds for
every request of a transactional upload too: each one, the begin included, is
checked against the admission it is sent with. See "Run as another
local user" in `docs/connected-machines.md`.

## Not yet supported

- A disk size in the create request.

Canonical code: `packages/runtime/src/sandbox/compute/`,
`packages/runtime/src/sandbox/providers/compute.ts`,
`packages/core/src/sandbox/compute-plane.ts`,
`apps/api/src/sandbox/compute-gateway*.ts`, migrations 0858 to 0863.
