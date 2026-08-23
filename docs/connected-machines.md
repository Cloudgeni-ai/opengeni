# Connected Machines (bring-your-own-compute)

A **Connected Machine** is one of a session's compute targets — your own
computer (a laptop, a workstation, a CI box, even a macOS machine) connected to
an organization, workspace, or organization user and driven by the agent directly. It is a **first-class, co-equal
primary compute target**, not a backend variant layered on top of a managed
box.

Human device-flow approval defaults to user ownership. A user-owned machine follows
its owner across same-organization workspaces they can currently access; workspace
ownership limits it to the approving workspace, and organization ownership requires
account-admin approval. Only the owner may attach a user machine. Using it from an
exact agent attempt additionally requires an explicit `connected_machine.use` grant
for that session visibility/context. Once/session/always grants use the common
personal-resource lifecycle; every operation revalidates the exact attempt, owner
membership revision, target-workspace access, authority epoch, resource/grant
generation, interruption state, and current machine selection immediately before
the machine transport is used. Revocation advances the machine and common authority
generation and invalidates existing grants.

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

|              | Managed Sandbox                  | Connected Machine                                  |
| ------------ | -------------------------------- | -------------------------------------------------- |
| Ownership    | platform-owned, ephemeral        | user-owned, persistent                             |
| Provisioning | platform provisions + tears down | platform **attaches** to what's already there      |
| Repos        | cloned into `/workspace`         | **not cloned** — the machine uses its own git auth |
| Working dir  | `/workspace` (virtual root)      | a real host path you pass per session              |
| Backend enum | `docker`/`modal`/`local`/…       | `selfhosted`                                       |

The model that follows from this: a machine-bound session has **no phantom Modal
"home box"**, **no OpenGeni Git token is distributed to the machine** (it uses
its own SSH / `gh` / credential helper), repos are **not cloned onto it**, and
the agent runs under a **per-session working directory** (making its own
worktrees under that path as it needs them). Structured cwd/fs ops rewrite the
virtual `/workspace` frame via `toMachinePath`. Model-facing shell paths are
cwd-relative (`.opengeni/files/...`); durable receipts and `sandbox:` UI links
keep `/workspace/...`. `execCommand` returns the SDK banner with combined
stdout/stderr and exit code.

The exact model-visible tool catalog remains available through Codemode without
installing a machine credential. OpenGeni sends no Codemode manifest pointer or
token file. Instead, the worker snapshots a renewable exact-attempt URL/bearer
only into each new child exec. It is never written to disk or stable machine
state. The installed binary exposes its absolute path to that authorized child,
so `"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode list|call` works even without
Bun/Node/`ogtool`. It reaches the same journal/executor as model MCP; the machine
still owns every ordinary credential and ambient environment.

This authority follows the session's **active** execution path. The fleet
`run_on` tool is a separate API-side, one-off route to a non-active machine. An
agent call still authorizes and snapshots the frozen initiating human's exact
accepted attempt and revalidates its visibility-keyed grant immediately before
dispatch; it does not change the active pointer or inject Codemode credentials.
Swap the session to that machine, or create the session there, before running
Codemode on it.

For source development, build or run the complete host-native runtime with:

```sh
bun run agent:local-runtime
bun run agent:local-runtime:run
```

The command builds browserd, the pinned agent-browser driver, and
computer-native first, hashes them into one development generation, then embeds
that exact closure in the Rust agent. On macOS it also enables the same real
ScreenCaptureKit/CGEvent desktop feature as the release build. This is the supported local path: copying
an agent binary next to arbitrary helpers can create a protocol-skewed runtime
that production installation and managed updates deliberately forbid.

Attached Chrome profiles are a separate physical placement. Inventory reports a
`connectionGeneration` that becomes the BrowserSession/ComputerSession
`placementInstanceId`. When that generation changes, OpenGeni marks the exact
device's still-live sessions `lost` with `controller_transition_expired` and
never rebinds the old controller token. In-flight `/end` (`ending`) is left
to finish physical teardown instead of being rewritten to `lost`. Heartbeats
must prove the live generation before they pulse. `/end` still talks to the
live agent with that original fence so the Mac helper can `stopCapture` and
exit; otherwise ScreenCaptureKit leaves `replayd` and multiple
`opengeni-computer-native` processes running. A new shared-seat
ComputerSession displaces the previous helper. Open a replacement through
**Browser → New browser → Connected Chrome**; generic New desktop does not
infer the Chrome device.

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
const box = machines.find(
  (m) => m.kind === "selfhosted" && m.state === "online",
);

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
  target the backend is the machine itself, so leave it off and point at the
  machine with `targetSandboxId`.
- **A child spawn with `targetSandboxId` / `machineTarget` is an own-box
  machine-primary home**, even when the parent is `backend: none`. Omitted
  `sandbox` still shares the creator's box only when no machine is named.
  Explicit `sandbox: "shared"` or `{ groupId }` plus a machine target is a
  **422**.

The model-facing first-party `session_create` tool makes the dependency
structural: it accepts an optional `machineTarget` object containing required
`targetSandboxId` plus optional `workingDir`, then maps that object to the stable
flat REST/SDK fields above. Consequently the model cannot generate a standalone
`workingDir`. This is a model-contract hardening only; existing REST/SDK callers
continue to use the flat fields.

For the web new-session composer, the actor-private backend draft remembers
only successful creates: the last project, that project's last managed or
machine target, and the last working directory for every project+machine pair.
Switching projects or machines restores the matching nested choice. Absolute
host paths remain tied to the exact machine id and are never reused on another
machine.

## Discover machines + metrics

`listMachines` returns the workspace fleet plus the active-sandbox pointer. Pass
`sessionId` for an in-session view, which also folds in that session's synthetic
home group box when one exists and the session's active-sandbox pointer. A
`backend:none` session has no synthetic home, but its owned Connected Machines
remain visible and attachable.

List `state` is the durable heartbeat cursor (`lastSeenAt`, `wentOfflineAt`),
not a live ControlRpc ping. A fresh heartbeat is online; a clean goodbye or a
stale/missing heartbeat is offline. Attach, capability negotiation, and fleet
tools still ping when they need to know whether a responder is answering now.

```ts
const res = await client.listMachines(workspaceId, { sessionId });
// res.activeSandboxId — the session's currently-active sandbox (null ⇒ the
//                       home box is active, or none is attached for backend:none)
// res.activeEpoch     — monotonic fence for the pointer (see "swap" below)
// res.machines        — MachineView[]
```

Each `MachineView` carries the fields a dashboard needs:

```ts
type MachineView = {
  sandboxId: string; // the id you pass as targetSandboxId / swap target
  enrollmentId: string | null; // the enrollment id for metrics + revoke
  name: string;
  kind: "modal" | "selfhosted";
  state:
    // derived liveness + consent/display/enrollment state
    | "online"
    | "reconnecting"
    | "offline"
    | "consent_required"
    | "display_unavailable"
    | "enrolling";
  active: boolean; // is this the session's active sandbox?
  isSessionGroup: boolean; // the synthetic Modal group box (not a real machine)
  os: string;
  arch: string;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  sharedSessionCount: number; // live sessions sharing this whole-machine lease
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
puts the supervisor and each operation in separate cgroup-v2 memory-accounting
leaves for lifecycle ownership and systemd-oomd selection. Startup enables only
the memory controller: CPU stays ambient until an explicit quota needs it, while
I/O and PID controllers remain untouched. The generated unit also sets
`DelegateSubgroup=supervisor`, so systemd starts every supervisor generation in
that stable leaf and can restart it after the empty service root has delegated
controllers to operation siblings. Startup verifies this topology and reports the
exact delegated controller subset it could use. A custom or older unit without
the supervisor subgroup degrades explicitly to ambient unrestricted execution,
preserving crash restart; configured operation policy fails closed on that incapable
runner. The supervisor stamps its leaf with systemd-oomd's `user.oomd_avoid=1`
marker. systemd-oomd honors the marker only when
the monitored ancestor and candidate cgroup have the same owner, so host policy
must preserve that ownership relationship. Cgroup placement alone does not change
host-wide kernel OOM victim selection: the generated service requests a negative
supervisor `OOMScoreAdjust`, startup reports the effective `/proc` value because an
unprivileged user manager may clamp it. A pre-exec hook gives commands the smallest
valid higher OOM-score bias over the live supervisor: neutral `0` when the
supervisor is negative, otherwise supervisor + 1. If the supervisor is already at
the kernel maximum, no relative preference is representable and both remain 1000.
Work delegated over a socket to an
external privileged daemon (for example, a container build) is not a descendant
of the command: the daemon chooses that workload's cgroup and OOM score. Operators
must configure such delegated workloads so they are not more protected from
global OOM selection than the supervisor. The generated fragment requests an
unlimited service aggregate, but admin drop-ins and ancestor limits still win; the
installer never resets them with runtime `set-property`. A verified self-update
migrates only the byte-identical old generated unit after proving its live MainPID,
canonical fragment, and exact ExecStart, and only on systemd 254+. Custom units are
left untouched with an actionable diagnostic. The default operation leaf has no
memory maximum or throttle. Each leaf sets `memory.oom.group=1`, so a memcg OOM terminates
the complete operation instead of leaving sibling descendants with partial state.
Before user code executes, the agent creates the operation leaf, applies any
explicit policy, pre-opens `cgroup.procs`, and uses an async-signal-safe pre-exec
hook to migrate each direct process into that leaf. Linux cgroup inheritance then
puts even an immediate `setsid` or double-fork descendant in the operation leaf.
After spawn, the agent verifies both direct roots. Once the manager exists, any
leaf creation, policy, pre-open, pre-exec placement, or live-root verification
failure aborts the operation and recursively kills its cgroup; there is no racy
post-spawn fork repair. Daemon-mediated work remains
subject to the external-daemon boundary above. Commands therefore keep the same
machine resources and authority as commands launched by an unrestricted local
agent; the OS scheduler owns contention, while a containment degradation is loud.
Normal completion, cancellation, timeout, and task abandonment all converge on the
same cleanup: the process group is killed and reaped, then the runner removes its
operation leaf. A teardown that races final descendant release waits for the
kernel's `cgroup.events` `populated 0` notification; it does not retain an empty
operation cgroup until service restart.

Workspace operators can opt into a per-enrollment command policy from the
machine detail view or the revision-fenced SDK call:

```ts
await client.updateMachineOperationPolicy(workspaceId, enrollmentId, {
  memoryMaxBytes: 1_073_741_824,
  memoryHighBytes: 805_306_368,
  cpuMaxMillicores: 1_500,
  expectedRevision: machine.operationPolicy.revision,
});
```

All three limits default to `null` (unrestricted). CPU is exact positive uint32
millicores (`1000` = one CPU core). On update, omitting `cpuMaxMillicores`
preserves its current value for older clients, `null` clears it, and a positive
value sets it. Limits apply separately to each newly admitted exec or Git
operation leaf; they are not an enrollment-wide aggregate, so N concurrent 1 GiB
commands may use N GiB. An already-admitted command keeps its immutable policy.
Every provider operation revalidates its exact live connection and any
caller-owned personal-machine authority at the last boundary before dispatch,
even inside a cached, swapped, or pinned multi-day turn. For a personal machine,
that same PostgreSQL snapshot verifies the accepted attempt, immutable admission
snapshot, current visibility-keyed grant, membership/generation fences, and the
runner connection. One-off `run_on` exec/read/write uses the same boundary after
creating its attempt snapshot, so a concurrent revoke cannot reach the provider.
Organization- and user-scoped machines used from another same-organization
workspace retain the machine's origin workspace for their physical control and
relay route; the session workspace remains the authorization target. A refused
op-stream `OpStart` may be retried only after a fresh live admission proves the
exact route and policy are still current, and a proven-unstarted downgrade to
legacy request/reply takes another fresh admission immediately before dispatch.
Exec and Git additionally read the policy revision and enforcement capabilities
from that authoritative admission. Memory enforcement and CPU-quota enforcement
are separately advertised; a configured unsupported limit fails command
admission closed, while saving or clearing policy remains available for
preconfiguration.

The machine owner may also set a process-local ceiling with
`OPENGENI_AGENT_OP_MEMORY_MAX`, `OPENGENI_AGENT_OP_MEMORY_HIGH`, and
`OPENGENI_AGENT_OP_CPU_MAX_MILLICORES`. Unset (or zero for these local environment
variables) is unrestricted. API values use `null` for unrestricted and reject
zero. Connection, local, and ancestor policies compose by taking the tightest
value, so a workspace can never loosen a machine-owner or OS limit. Malformed
values, `memory.high` above an explicit `memory.max`, an unavailable delegated
controller, or a failed per-operation policy write fail clearly instead of
silently running the workload without the requested policy.
CPU is an exact positive integer-millicore ratio. The
runner preserves the inherited `cpu.max` period when exact; otherwise it minimally
lengthens the reduced ratio to satisfy the kernel's 1 ms minimum quota and 1 s
maximum period, so every accepted `uint32` value is representable without rounding.
It leases `+cpu` while limited leaves exist and removes it after the final limited
leaf is killed, empty, and removed. During that lease, the supervisor and all op
siblings temporarily participate in hierarchical CPU scheduling; each limited
leaf still has its own hard quota. For an explicit policy, the runner reads kernel
files back and reports desired/local/leaf/ancestor/combined bounds. Ancestor memory
values are shared aggregate upper bounds, not promised per-command availability
under sibling contention; unknown or unobservable effects remain explicit rather
than being presented as the requested number.

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
personal-machine path requires the same exact accepted-attempt authorization
and current `connected_machine.use` grant as an active route. Its
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

An agent turn that started on a Connected Machine does not pre-lease a managed
home sandbox. If that turn explicitly swaps a managed-home session back to
`"session"`/`"default"`, OpenGeni preserves the successful pointer change,
checkpoints completed model/tool truth, and continues the same logical turn in a
fresh home-primary attempt. The handoff requires no new user message, never
silently runs a post-swap operation on the old machine, and never provisions a
cloud home for machine-only work. Unresolved parallel tool calls are closed as
interrupted/outcome-unknown rather than replayed automatically.

## Connect a machine

Enrollment turns a user's machine into a `selfhosted` sandbox in the workspace.
The machine agent is multi-connection: installing it once and connecting another
workspace—even on a different OpenGeni deployment—adds an independent link and
preserves all existing links. There are two enrollment paths. Both require the
caller to hold `enrollments:manage`.

The universal Machines-page one-liner securely installs or updates the runner
installation, including a generated background-service definition when the
release requires it, runs `opengeni-agent connect` for that deployment, and leaves
the ordinary background service online. A same-version connection is additive and
does not restart the process or interrupt existing commands. A real upgrade
restarts once when activation requires it; subsequent connection files load live.
`opengeni-agent run` is the explicit foreground alternative.

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
const { token, expiresAt, expiresInSeconds } = await client.mintEnrollToken(
  workspaceId,
  {
    allowScreenControl: false, // bake screen-control consent into the token
  },
);
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
  scope: "user", // explicit personal default; "workspace" and "organization" publish wider
});
// approved.enrollmentId, approved.sandboxId, approved.allowScreenControl

// or, the explicit "no":
await client.denyDeviceEnrollment(pending.workspaceId, { userCode });
```

Approving lands an enrollment plus a `selfhosted` sandbox and unblocks the
agent's poll; `sandboxId` is immediately usable as a `targetSandboxId` or a swap
target. The managed consent page always asks for personal, workspace, or
organization access and defaults to personal. Organization publication is
available only to account administrators. Machines and Rigs display the
resulting scope in their list cards so wider publication is never implicit.

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

- **`useMachines`** — the fleet hook: polls `listMachines` (one shared poll per
  workspace+session client), exposes `attach(sandboxId)` (wired to
  `swapActiveSandbox` when a `sessionId` is in scope), `fetchSeries`, and
  `activeSandboxId`/`activeEpoch`.
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
