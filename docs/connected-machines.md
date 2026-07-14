# Connected Machines (bring-your-own-compute)

A **Connected Machine** is one of a session's compute targets — your own
computer (a laptop, a workstation, a CI box, even a macOS machine) enrolled into
a workspace and driven by the agent directly. It is a **first-class, co-equal
primary compute target**, not a backend variant layered on top of a managed
box.

This guide is embedder-facing: it shows how to create a session on a machine,
discover the enrolled machines and their metrics, swap a session's active
sandbox, enroll a machine (zero-click token or the interactive device flow), and
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

## Create a session on a machine

`createSession` grows two fields for a Connected-Machine target:

- **`targetSandboxId`** (uuid) — the enrolled machine to run the session on (a
  `MachineView.sandboxId` from `listMachines`). It **seeds the active-sandbox
  pointer at creation**, so the very first turn lands on that machine.
- **`workingDir`** (host path) — the directory the agent runs the session under
  (its cwd base for exec, terminal, and the file dock). A launch-root-relative
  subdir or an absolute machine path both work.

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

Machine liveness is independent of accepted host operations. The agent
prioritizes heartbeats, answers `ping` outside its bounded host-work pool, and
returns typed retryable `DRAINING` backpressure when that pool is full. A busy
machine therefore remains online and diagnosable instead of turning saturation
into an offline transition.

Exec requests carry a finite agent-side process deadline inside a slightly
larger request/reply deadline. If that deadline or the connection generation
ends, the agent cancels the accepted operation and terminates its POSIX process
group or Windows Job Object, including ordinary descendants spawned by a shell.
On Unix a private unreaped group anchor fences the PGID until cleanup has been
issued, so cancellation cannot signal a recycled group and the requested command
cannot exit and leave invisible same-group work behind.
An oversized reply is likewise returned as typed `PAYLOAD_TOO_LARGE`; neither
backpressure nor a reply-size failure changes the machine's heartbeat state.

### Streaming exec (op-stream)

Runners that advertise the `op_stream` capability can serve exec over the
op-stream protocol instead of the monolithic request/reply, when the server
also sets `OPENGENI_AGENT_OP_STREAM_ENABLED=true` (default off; the legacy
exec remains the permanent fallback wire form and the only form for older
runners). Output streams as sequenced, credit-flowed frames the runner retains
for replay: a connection blip mid-command detaches instead of killing the
child, and the server re-attaches and collects the complete output byte-exact
(blake3-verified). Each exec carries a durable op id derived from the model's
tool call, and starting an op is idempotent by that id — a worker-death
re-dispatch that re-executes the same tool call attaches to the
already-running or completed op instead of re-running the command. The
oversized-reply wall does not apply on this path; output is instead bounded by
the runner's retention quotas, and exceeding them fails typed with exact
counters, never silently truncated.

## Windows support boundary

Foreground `opengeni-agent run` is the supported Windows lifecycle. The binary
does not currently enter the Windows Service Control Manager dispatcher or report
SCM state transitions. Therefore every `opengeni-agent service` action—including
`install --print`, uninstall, status, and logs—returns an explicit unsupported
error before invoking `sc.exe`; no broken service registration is left behind.
Windows compilation/unit tests prove compatibility only. A real service may be
claimed only after a native Windows host demonstrates dispatcher startup, control
handling, state transitions, restart/recovery, logs, uninstall, and foreground-run
regression coverage.

## macOS support boundary

macOS command and service code can be built and unit-tested from another
platform, but that is **compatibility coverage only**. The persistent service is
deliberately a user `LaunchAgent` in the logged-in `gui/<uid>` Aqua domain, never
a system LaunchDaemon: it must share the user's GUI/TCC identity. `service logs`
reads the LaunchAgent's configured user-owned stdout/stderr files; it does not
claim a system-wide logging scope.

The source contains an experimental ScreenCaptureKit/CGEvent backend behind the
`macos-desktop` Cargo feature, but stable releases intentionally leave that feature
off. Stable macOS agents therefore report `display_unavailable` and do not claim
live screen capture/input or prompt for TCC grants. Before enabling it, a
signed/notarized stable bundle identity, a logged-in Aqua user, human Screen
Recording and Accessibility TCC grants, and whole-machine enrollment consent must
all be demonstrated on a real consenting Mac. Cross-compilation and CI cannot
substitute for that human gate.

`opengeni-agent update --check` may discover and verify a macOS candidate. Apply
does not mutate `.app/Contents/MacOS/opengeni-agent`: it fails before any temp or
backup write and directs the user to rerun `<base>/install.sh` with
`OPENGENI_INSTALL_REPLACE_APP=1`, replacing the complete verified app bundle. A
stable Developer ID/designated requirement can preserve TCC identity only when the
whole replacement bundle is signed and verified; an in-place Mach-O swap would
invalidate that claim.

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

## Enroll a machine

Enrollment turns a user's machine into a `selfhosted` sandbox in the workspace.
There are two paths. Both require the caller to hold `enrollments:manage`.

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
//   curl -fsSL https://…/install.sh | sh -s -- --token <token>
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
- **A machine may self-revoke** during a local purge via the exact public
  `POST /v1/enrollments/self/revoke` route and its own `oge_` bearer. This cannot
  revoke another enrollment or cross a workspace. A matching already-revoked row
  returns the normal idempotent no-op response to recover a lost first response,
  but only while the row still has that bearer's credential generation. Every
  re-enrollment atomically increments the generation: the old bearer can neither
  authenticate nor revoke the new generation.

Revocation immediately blocks the next NATS authorization/reconnect; it does not
claim to synchronously disconnect an already-live NATS socket. The user JWT minted
by auth-callout expires at the earlier of the bearer expiry or five minutes from
authorization, so existing NATS access terminates within that bounded interval.

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
