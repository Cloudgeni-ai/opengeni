# Opengeni compute (`compute` sandbox backend)

`compute` runs managed sandboxes on Opengeni's own Firecracker sandbox fabric
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
talks to its host over vsock; the fabric host keeps one WebSocket link to the
**agent gateway** in the API (`OPENGENI_COMPUTE_LINK_URL`, subprotocol
`opengeni.agent-link.v1`) carrying one session per sandbox. The wire contract
is `compute/docs/agent-link.md`; the design is ADR 21 in `compute/docs/adr/`.

The gateway (`apps/api/src/sandbox/compute-gateway.ts`) verifies the host token
and each sandbox ticket (EdDSA, keys from the fabric's `/v1/link/keys`),
fences sessions by the fabric owner epoch, claims the agent's connection
instance as the NATS auth callout does, bridges `sub`/`pub`/`msg` with exactly
the agent's NATS permissions, mints relay producer tokens, and renews the claim
every 5 s while the session is open, asleep or not. A sleeping sandbox stays
reachable; a message to it makes the host wake it.
A session acts only within its last confirmed lease: when renewals keep
failing past it, the gateway ends the session as `lost` (the host opens it
again) and forwards nothing and mints no relay credential for it meanwhile.
An open that a later epoch overtook while it was in flight is refused as
`stale_epoch` and never evicts the newer session.

Nothing in Opengeni may message a compute agent on a timer: every message
wakes the sandbox. Liveness comes from the gateway's session and claim. A
background command on a compute sandbox settles from the agent's pushed
completion; the reconciler claims it only after that push or once it is
retired (connection replaced, enrollment revoked), never to poll it (0844).
A stopping command (Stop, Pause or Cancel) is still claimed, because that
claim delivers the cancellation to the agent.

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
  the fabric has never seen counts as proof of no sandbox only once the
  enrollment is ten minutes old). Whatever is left (a lost answer, a failed
  delete, a worker that crashed between create and commit, a workspace deleted
  with everything in it) is the orphan sweep's: every five minutes the worker's
  reaper maintenance lists this deployment's sandboxes on the fabric
  (`sweepComputeOrphans`, filtered by its gateway URL) and, for each one
  older than ten minutes that Opengeni's records no longer name, revokes its
  enrollment and then deletes it. A sandbox is named while its enrollment is
  active and its group's lease holds it (by sandbox or enrollment id) or is
  warming, since a creator may be about to commit it (`computeSandboxNamed`).
  The fabric's own inventory is the record, so nothing is lost when Opengeni's
  rows go: a failed revoke deletes nothing, and a failed delete leaves a listed
  sandbox for the next pass. The sweep handles eight orphans at a time and
  ends within one minute or when the activity is cancelled. That budget
  starts before the stale-enrollment reconcile below and covers everything:
  each fabric request until its body is read, and each database check and
  revoke under a statement timeout that also ends lock waits (a stopped call
  returns at once and its transaction rolls back). One stalled delete or lock
  therefore never holds up the others or the rest of maintenance. Each pass
  resumes after the last sandbox the previous one reached, and a sandbox whose
  cleanup failed sits out ten minutes, doubling up to an hour, so failures at
  the front of the list never starve the sandboxes behind them. This progress
  lives in the worker's memory; a restarted worker starts again at the oldest
  sandbox. It never
  messages an agent, so it wakes nothing. One fabric team serves one Opengeni
  deployment's gateway; the gateway tag keeps a misconfigured second
  deployment's sandboxes out of the sweep.
- **Stale enrollments**: an enrollment whose sandbox is already gone (a delete
  whose revoke failed, a create that never made a sandbox) is in no fabric
  listing, so the same maintenance also revokes, from Opengeni's own records,
  every active sandbox enrollment older than ten minutes whose group's lease
  neither names it nor is warming (migration 0846: a cross-workspace inventory
  of ids under the owner-only read capability, then one revoke per enrollment
  under its workspace's RLS that re-checks the condition). An enrollment
  therefore never stays active for a sandbox that is gone.
- **Resume**: re-address the same sandbox by id; no wake is needed. If a request
  finds no responder (no host serves the sandbox, for example mid-move),
  `ComputeWakingControlRpc` asks the fabric to wake it and resends under the
  same request id until the agent answers. Every operation re-resolves the
  agent's connection instance.
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
  captured or deleted. The fabric sleeps the sandbox by its own rules and
  keeps memory and disk; Opengeni never drains a compute lease for being idle
  (migration 0843 and the drain points in `packages/db/src/index.ts`). The
  next turn finds the same sandbox and its first request wakes it.
- **Group end**: deleting the chat or workspace marks the lease
  (`group_end_requested_at`, migration 0845) and drains it at once. The reaper
  then deletes the sandbox on the fabric without a tar capture and revokes its
  enrollment (after the fabric delete, so a failure leaves it on record for
  the retry). Whether to delete without a capture is read from the lease the
  capture claim returns and checked again under the lease's row lock just
  before the delete (`persistDrainSnapshot` with `groupEndDiscard`): a
  rotation that committed after the reaper read the lease gets its capture,
  and an ineligible delete gives its claim back for the next sweep. The
  lease's capture fence still decides who may terminate the box, and a fence
  loss leaves it for its new owner. The marker is cleared when the lease
  re-arms or goes cold.
- **Capture**: a portable tar only, to move a workspace to another backend
  (rotation and archive capture still drain with a capture).
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
fabric change.

## Configuration

| Setting | Meaning |
| --- | --- |
| `OPENGENI_COMPUTE_API_URL`, `OPENGENI_COMPUTE_API_KEY` | Fabric API (HTTPS outside local/test) and its key |
| `OPENGENI_COMPUTE_LINK_URL` | The gateway's public `wss://` URL, also the JWT audience |
| `OPENGENI_COMPUTE_IMAGE`, `OPENGENI_COMPUTE_DESKTOP_IMAGE` | Headless and desktop image refs (fabric default when unset) |
| `OPENGENI_COMPUTE_VCPUS`, `OPENGENI_COMPUTE_MEMORY_MIB` | Shape; optional `..._MEMORY_REQUEST_MIB`, `..._CPU_REQUEST_MILLIS` |
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
`apps/api/src/sandbox/compute-gateway*.ts`, migrations 0842 to 0846.
