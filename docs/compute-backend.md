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
- **Unfinished creates**: because the enrollment is written before the create
  is sent, an active sandbox enrollment is the durable record that the fabric
  may hold a sandbox for it. It is revoked only after `GET /v1/requests/{id}`
  proves no sandbox exists (deleting a live one first); a request the fabric
  has never seen counts as proof only once the enrollment is ten minutes old,
  since its create may still be in flight. A failed create cleans up at once
  when it can; otherwise the group's next create (the unique cold-to-warming
  owner, which holds no box) reconciles every active enrollment of the group,
  and deleting the group's sandbox reconciles the older ones. So a lost answer,
  a failed delete or a crashed worker never loses track of a sandbox.
- **Resume**: re-address the same sandbox by id; no wake is needed. If a request
  finds no responder (no host serves the sandbox, for example mid-move),
  `ComputeWakingControlRpc` asks the fabric to wake it and resends under the
  same request id until the agent answers. Every operation re-resolves the
  agent's connection instance.
- **Request epoch**: every compute request carries `COMPUTE_AGENT_EPOCH`
  (1). The agent in a sandbox never adopts an epoch, so this fences nothing,
  but its file-write transactions require a nonzero epoch repeated on every
  step. Compute is fenced by its lease and the gateway's owner epoch.
- **Idle**: when the last holder releases a compute lease, nothing is
  captured or deleted. The fabric sleeps the sandbox by its own rules and
  keeps memory and disk; Opengeni never drains a compute lease for being idle
  (migration 0843 and the drain points in `packages/db/src/index.ts`). The
  next turn finds the same sandbox and its first request wakes it.
- **Group end**: deleting the chat or workspace marks the lease
  (`group_end_requested_at`, migration 0845) and drains it at once. The reaper
  then deletes the sandbox on the fabric without a tar capture and revokes its
  enrollment; the lease's capture fence still decides who may terminate it,
  and a fence loss leaves the box for its new owner. The marker is cleared
  when the lease re-arms or goes cold, and the deletion succeeds on retry.
- **Capture**: a portable tar only, to move a workspace to another backend
  (rotation and archive capture still drain with a capture).
- **Metering**: warm seconds count only while the sandbox is awake. The
  gateway records each `state` change (`recordComputeSandboxPower`): asleep
  stamps `compute_asleep_since`, which caps accrual; awake moves the meter
  cursor past the time asleep. A tick that accrued before the asleep frame
  arrived may bill at most one tick of sleep.

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
Each request still gates on the live agent's Hello `capabilities.run_as`:
commands, file operations and manifest materialization carry `runAs` only when
the agent advertises it, and a manifest applied as another user is refused
otherwise. See "Run as another local user" in `docs/connected-machines.md`.

## Not yet supported

- A disk size in the create request.

Canonical code: `packages/runtime/src/sandbox/compute/`,
`packages/runtime/src/sandbox/providers/compute.ts`,
`packages/core/src/sandbox/compute-plane.ts`,
`apps/api/src/sandbox/compute-gateway*.ts`, migrations 0842 to 0845.
