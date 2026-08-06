# Connected Machines (bring-your-own-compute)

A **Connected Machine** is one of a session's compute targets — your own
computer (a laptop, a workstation, a CI box, even a macOS machine) connected to
a workspace and driven by the agent directly. It is a **first-class, co-equal
primary compute target**, not a backend variant layered on top of a managed
box.

This guide is embedder-facing: it shows how to create a session on a machine,
discover the enrolled machines and their metrics, swap a session's active
sandbox, connect a machine (zero-click token or the interactive device flow), and
revoke/detach — all through the typed [`@opengeni/sdk`](../packages/sdk/README.md)
client. The matching UI ships in
[`@opengeni/react/machines`](../packages/react/README.md).

> Terminology: **Connected Machine** is the product term used throughout. The
> internal `SandboxBackend` enum value for one is `"selfhosted"` — you will see
> it in `MachineView.kind` (`"selfhosted"` vs `"modal"`) and in negotiated
> capability reasons.

## The two compute targets

| | Managed Sandbox | Connected Machine |
| --- | --- | --- |
| Ownership | platform-owned, ephemeral | user-owned, persistent |
| Provisioning | platform provisions + tears down | platform **attaches** to what's already there |
| Repos | cloned into `/workspace` | **not cloned** — the machine uses its own git auth |
| Working dir | `/workspace` (virtual root) | a real host path you pass per session |
| Backend enum | `docker`/`modal`/`local`/… | `selfhosted` |

The model that follows from this: a machine-bound session has **no phantom Modal
"home box"**, **no OpenGeni git token is distributed to the machine** (it uses
its own ssh / `gh` / credential helper), repos are **not cloned onto it**, and
the agent runs under a **per-session working directory** (making its own
worktrees under that path as it needs them).

OpenGeni does not mint, seed, renew, or advertise Toolspace credentials on a
Connected Machine. It sends no Toolspace URL, token-file pointer, package hint,
or other manifest environment to machine commands. If an operator wants a
machine-local integration, they may provision and store an ordinary API
credential themselves; that credential remains machine-owned and outside the
Connected Machine lifecycle.

Machine availability is also not a turn-admission dependency. A text-only turn
can start while the selected machine is offline. If the model invokes a machine
operation, the typed offline/timeout result returns to the model in-band so it
can explain the outage, choose another available tool or compute target, or help
recover the machine. The transport failure must not replace the agent loop.

## Create a session on a machine

`createSession` grows two fields for a Connected-Machine target:

- **`targetSandboxId`** (uuid) — the enrolled machine to run the session on (a
  `MachineView.sandboxId` from `listMachines`). It **seeds the active-sandbox
  pointer at creation**, so the very first turn lands on that machine.
- **`workingDir`** (host path) — the directory the agent runs the session under
  (its cwd base for exec, terminal, and the file dock). A launch-root-relative
  subdir, an absolute machine path, or the current agent user's `~` / `~/...`
  path both work. Other shell/environment expansion is intentionally not applied.

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({ baseUrl, apiKey });

// Pick a machine from the workspace fleet…
const { machines } = await client.listMachines(workspaceId);
const box = machines.find((m) => m.kind === "selfhosted" && m.state === "online");

// …and run the session on it.
const session = await client.createSession(workspaceId, {
  initialMessage: "Run the test suite and fix what's red",
  targetSandboxId: box!.sandboxId, // seeds the active-sandbox pointer at create
  workingDir: "/home/me/projects/app", // the agent's cwd on the machine
});
```

Rules to keep in mind:

- **`workingDir` requires `targetSandboxId`.** Sending `workingDir` alone (with
  no machine target) is a **422** — a bare working directory has no machine to
  resolve it against.
- Omit `workingDir` and the session runs under the machine's **default workspace
  root** (the agent's launch dir).
- Session detail responses echo the resolved configuration as `workingDir`
  (`null` when the launch root is in use), so operators can diagnose placement
  without querying storage directly.
- **Repos are not cloned** onto a machine target. `resources` you attach are
  available for context, but the platform never `git clone`s onto the user's
  real filesystem — the machine uses its own git auth.
- `sandboxBackend` selects the backend for a **managed** sandbox; for a machine
  target the backend is the machine itself, so leave it off (or `"none"`) and
  point at the machine with `targetSandboxId`.

## Discover machines + metrics

`listMachines` returns the workspace fleet plus the active-sandbox pointer. Pass
`sessionId` for an in-session view, which also folds in that session's synthetic
Modal group box and the session's active-sandbox pointer.

```ts
const res = await client.listMachines(workspaceId, { sessionId });
// res.activeSandboxId — the session's currently-active sandbox (null ⇒ the
//                       session's own group box is active)
// res.activeEpoch     — monotonic fence for the pointer (see "swap" below)
// res.machines        — MachineView[]
```

Each `MachineView` carries the fields a dashboard needs:

```ts
type MachineView = {
  sandboxId: string;            // the id you pass as targetSandboxId / swap target
  enrollmentId: string | null;  // the enrollment id for metrics + revoke
  name: string;
  kind: "modal" | "selfhosted";
  state:                        // derived liveness + consent/display/enrollment state
    | "online" | "reconnecting" | "offline"
    | "consent_required" | "display_unavailable" | "enrolling";
  active: boolean;              // is this the session's active sandbox?
  isSessionGroup: boolean;      // the synthetic Modal group box (not a real machine)
  os: string;
  arch: string;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  sharedSessionCount: number;   // live sessions sharing this whole-machine lease
  lastSeenAt: string | null;
  metrics: MetricSample | null; // latest point-in-time sample
};
```

For a time series (the dashboard's charts), read the downsampled (~1/min)
per-machine history over a window. Samples are oldest-first (left-to-right):

```ts
const samples = await client.machineMetricsSeries(workspaceId, enrollmentId, {
  window: "1h", // "15m" | "1h" (default) | "6h" | "24h"
});
// MetricSample: cpuPct, load1/5/15, memUsedBytes/memTotalBytes,
//   diskUsedBytes/diskTotalBytes, gpuUtilPct|null, gpuMemBytes|null,
//   runQueue, sampledAt (ISO-8601). GPU fields are null when no GPU is present.
```

## Control liveness and backpressure

Machine liveness is independent of accepted host operations. The supervisor
answers `ping` and publishes heartbeats outside command execution. Production
admission has no ordinary fixed concurrency or queue-wait limit: its only
circuit breakers are derived from host file-descriptor and process headroom and
sit above normal workloads (including 100 concurrent command requests). Linux
puts the supervisor and each operation in separate cgroup-v2 leaves for fate
isolation and accounting. The generated systemd unit enables accounting without
a parent `MemoryHigh`, and the default operation leaf has no memory maximum or
throttle. At spawn, the agent stops the command's process group, moves its direct
roots, then repeatedly drains any same-group descendants still inherited in the
supervisor leaf into the same operation leaf before resuming it. Correctness does
not depend on synchronous stop-signal delivery: after a parent moves, future
children inherit its operation leaf. This closes the post-spawn fork race. A
same-group fork storm that keeps creating escaped descendants during this tiny
pre-containment window is terminated only after crossing a PID breaker derived
from that machine's process ceiling; it cannot wedge command admission forever.
Commands therefore have the same machine resources and authority as commands
launched by an unrestricted local agent; the OS scheduler owns contention,
while a pathological breaker trip is loud and typed.

Operators can opt into local per-operation limits with
`OPENGENI_AGENT_OP_MEMORY_MAX` and `OPENGENI_AGENT_OP_MEMORY_HIGH`; unset is the
authoritative unlimited default. A future centrally managed per-machine memory
policy must project onto these operation leaves (or a machine-scoped command
parent), remain explicitly `unlimited` by default, and never constrain the
supervisor leaf or install an implicit service-wide `MemoryHigh`.

Exec duration is unbounded by default. `timeout_ms=0` and op-stream
`deadline_ms=0` schedule no process kill; a positive
`OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS` is an explicit operator choice.
Pause/Steer/cancellation still terminates the exact POSIX process group or
Windows Job Object, including ordinary descendants spawned by a shell. A
connection blip detaches the stream without killing the command; replay collects
the retained output after reconnect.
The session shell capability also preserves an explicit `exec_command.shell`
selection: OpenGeni sends that shell as direct argv, with the requested login or
non-login semantics, instead of silently substituting the machine service's
ambient default shell. Calls that omit `shell` intentionally retain the
machine-owned `$SHELL`/`ComSpec` default.
On Unix a private unreaped group anchor fences the PGID until cleanup has been
issued, so cancellation cannot signal a recycled group and the requested command
cannot exit and leave invisible same-group work behind.
An oversized reply is likewise returned as typed `PAYLOAD_TOO_LARGE`; neither
backpressure nor a reply-size failure changes the machine's heartbeat state.

The agent-facing `run_on` MCP tool is intentionally a one-off side channel to a
specific enrolled machine and never changes the session's active route. Its
`exec` receipt reports the exact `exitCode`, typed `timedOut`, and effective
`deadlineMs` (`0` means none). A process killed at an explicitly configured
deadline, or a response with no terminal
exit proof, is never reported as `ok: true`; a transport loss after dispatch is
ambiguous and is not replayed. `run_on` uses the deployment's separate
`OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS` and
`OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS` settings (30 seconds and no exec
deadline by default), while preserving the active sandbox pointer and epoch.

### Streaming exec (op-stream)

Runners that advertise the `op_stream` capability serve exec over the
op-stream protocol when `OPENGENI_AGENT_OP_STREAM_ENABLED=true` (default on).
This is required for the default unbounded-duration mode. An older runner may
still use legacy request/reply only when the deployment explicitly configures a
positive exec timeout; otherwise OpenGeni refuses before starting the command
instead of launching work whose caller can later disappear ambiguously. Output
streams as sequenced, credit-flowed frames the runner retains
for replay: a connection blip mid-command detaches instead of killing the
child, and the server re-attaches and collects the complete output byte-exact
(blake3-verified). Each exec carries a durable op id derived from the model's
tool call, and starting an op is idempotent by that id — a worker-death
re-dispatch that re-executes the same tool call attaches to the
already-running or completed op instead of re-running the command. The
oversized-reply wall does not apply on this path; output is instead bounded by
the runner's retention quotas, and exceeding them fails typed with exact
counters, never silently truncated.

The server's out-of-order frame stash is only a disposable replay cache, bounded
in bytes to two negotiated flow windows per operation. Overflow drops that cache
and re-attaches to the runner's authoritative retention log; it never limits or
truncates command output. Completed stdout/stderr are assembled once for the
tool result, and source frame references are then released.

## Swap the active sandbox

A session points at one active sandbox at a time. `swapActiveSandbox` re-points
it — the user-authenticated equivalent of the agent's `sandbox_swap` MCP tool.

```ts
// Point the session at a machine…
const swap = await client.swapActiveSandbox(workspaceId, sessionId, {
  target: box.sandboxId, // a MachineView.sandboxId
});
// …or swap back to the session's own managed group box:
await client.swapActiveSandbox(workspaceId, sessionId, { target: "session" });
// ("session" and "default" both mean "the session's own group box".)

// swap.swapped        — true on a successful repoint OR a no-op (already there)
// swap.activeSandboxId — the resulting pointer
// swap.activeEpoch    — the new fence value
// swap.reason         — set when swapped:false (unowned/offline target, or a
//                       lost epoch fence)
```

Validation (ownership, liveness, epoch fence) is server-side; a rejected target
comes back as `swapped: false` with a `reason` rather than throwing. The next
turn runs on whatever the pointer resolves to.

## Connect a machine

Enrollment turns a user's machine into a `selfhosted` sandbox in the workspace.
The machine agent is multi-connection: installing it once and connecting another
workspace—even on a different OpenGeni deployment—adds an independent link and
preserves all existing links. There are two enrollment paths. Both require the
caller to hold `enrollments:manage`.

The universal Machines-page one-liner installs or updates the binary and runs
`opengeni-agent connect` for that deployment. A running v0.1.10+ foreground or
service agent detects the new owner-only connection file automatically. When the
command upgrades an older running process, restart that process once; subsequent
connections load live.

Because the binary is shared, the current installer refuses to replace a newer
installed agent with an older verified release from a lagging deployment. Set
`OPENGENI_ALLOW_DOWNGRADE=1` only for an intentional rollback.
Operators can inspect or remove local links with:

```sh
opengeni-agent connections
opengeni-agent disconnect <connection-id-or-prefix>
```

`disconnect` stops only the local link. The enrollment remains visible offline
in that workspace until a workspace administrator removes/revokes it. This is
intentional: possessing the machine credential does not grant workspace-admin
authority.

### Zero-click token (fleet / headless)

Mint a short-TTL enroll token and hand it to the machine's installer. The token
is **secret** — surface it once with a copy-now warning; it cannot be re-read.

```ts
const { token, expiresAt, expiresInSeconds } =
  await client.mintEnrollToken(workspaceId, {
    allowScreenControl: false, // bake screen-control consent into the token
  });
// Run on the machine (the installer dials OpenGeni and exchanges the token for
// its own long-lived agent credentials — the token exchange happens on the
// machine, not through this client):
//   OPENGENI_API_URL=https://… OPENGENI_ENROLL_TOKEN=<token> \
//     sh -c 'curl -fsSL "$OPENGENI_API_URL/install.sh" | sh'
```

`allowScreenControl` bakes the (optional) screen-control consent into the token;
whole-machine access — exec, files, terminal — is implicit and mandatory for any
enrollment.

### Device flow (interactive, in-session)

When a user runs the installer with no token, the machine's agent starts a
device flow and prints a short **`userCode`** plus a **`verificationUri`** (the
device-flow start/poll is done by the machine's agent, not this client). Your
app renders an approve page. Resolve the pending flow by its code — note there is
**no workspace in the path**; the server resolves the workspace from the
(globally-unique-among-pending) code and authorizes the caller against it
(`enrollments:read`):

```ts
const pending = await client.lookupDeviceEnrollment(userCode);
// pending.workspaceId, pending.userCode, pending.expiresAt
// pending.machine: { machineName, os, arch, canOfferDisplay, requestsScreenControl }
```

Then approve (the loud whole-machine consent) or deny:

```ts
const approved = await client.approveDeviceEnrollment(pending.workspaceId, {
  userCode,
  allowScreenControl: true, // the authoritative screen-control consent
});
// approved.enrollmentId, approved.sandboxId, approved.allowScreenControl

// or, the explicit "no":
await client.denyDeviceEnrollment(pending.workspaceId, { userCode });
```

Approving lands an enrollment plus a `selfhosted` sandbox and unblocks the
agent's poll; `sandboxId` is immediately usable as a `targetSandboxId` or a swap
target.

## Revoke / detach

- **Reject a pending enrollment** at the approve page:
  `client.denyDeviceEnrollment(workspaceId, { userCode })`.
- **Detach a machine from a session** without un-enrolling it: swap the active
  sandbox back to the session's own box —
  `client.swapActiveSandbox(workspaceId, sessionId, { target: "session" })`.
  Subsequent turns run on the managed box; the machine stays enrolled for other
  sessions.
- **Permanently un-enroll** a machine (so it can never be attached again) is a
  workspace administration action; it is not wrapped as a typed method on the
  `@opengeni/sdk` client as of 0.5.0.

## React components

`@opengeni/react/machines` renders all of the above:

- **`useMachines`** — the fleet hook: polls `listMachines`, exposes
  `attach(sandboxId)` (wired to `swapActiveSandbox` when a `sessionId` is in
  scope), `fetchSeries`, and `activeSandboxId`/`activeEpoch`.
- **`MachinesDashboard`** / **`MachineCard`** / **`MachineMetrics`** — the fleet
  grid with per-machine meters and an attach/swap affordance.
- **`MachineDockBar`** — a slim bar over the Files/Terminal/Desktop dock that
  names which machine those surfaces are bound to and its connection status.
- **`EnrollmentDeviceFlow`** — the in-session panel that shows the `userCode` +
  `verificationUri` and the pending → authorized/denied/expired progression.
- **`EnrollmentConsent`** — the loud whole-machine approve page for the device
  flow.
- **`MachineStatusPill`** / **`ConnectionStatusPill`** — the status chips.

See the [`@opengeni/react` README](../packages/react/README.md) for wiring.
