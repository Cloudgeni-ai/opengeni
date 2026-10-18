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

Nothing in Opengeni may message a compute agent on a timer: every message
wakes the sandbox. Liveness comes from the gateway's session and claim. A
background command on a compute sandbox settles from the agent's pushed
completion; the reconciler claims it only after that push or once it is
retired (connection replaced, enrollment revoked), never to poll it (0841).

## Lifecycle

- **Create** (`ComputeSandboxClient.create`): Opengeni creates the sandbox's
  enrollment itself (kind `sandbox`, keyless, bound to the sandbox group), then
  calls `POST /v1/sandboxes` with a request id (retried with the same id and
  body) and `init.agent = {workspace_id, agent_id, workspace_root, desktop}`,
  then waits for the agent to answer through its session. A lost create answer
  is resolved by `GET /v1/requests/{id}` and the sandbox deleted.
- **Resume**: re-address the same sandbox by id; no wake is needed. If a request
  finds no responder (no host serves the sandbox, for example mid-move),
  `ComputeWakingControlRpc` asks the fabric to wake it and resends under the
  same request id until the agent answers. Every operation re-resolves the
  agent's connection instance.
- **Idle**: the fabric sleeps the sandbox and keeps memory and disk. Opengeni
  never drains a compute lease for being idle (migration 0840 and the drain
  points in `packages/db/src/index.ts`); it stays warm without holders.
- **Group end**: deleting the chat or workspace drains its idle compute lease
  at once; the reaper deletes the sandbox and revokes its enrollment, and the
  deletion succeeds on retry. Rotation and archive capture still drain.
- **Capture**: a portable tar only, to move a workspace to another backend.

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

## Not yet supported

- `runAs`: the descriptor keeps it off until the agent advertises
  `agent_capabilities.run_as`.
- A disk size in the create request.

Canonical code: `packages/runtime/src/sandbox/compute/`,
`packages/runtime/src/sandbox/providers/compute.ts`,
`packages/core/src/sandbox/compute-plane.ts`,
`apps/api/src/sandbox/compute-gateway*.ts`, migrations 0839 and 0840.
