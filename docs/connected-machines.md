# Connected Machines (bring-your-own-compute)

A **Connected Machine** is one of a session's compute targets — your own
computer (a laptop, a workstation, a CI box, even a macOS machine) connected to
an organization, workspace, or organization user and driven by the agent directly. It is a **first-class, co-equal
primary compute target**, not a backend variant layered on top of a managed
box.

Human device-flow approval defaults to user ownership. A user-owned machine follows
its owner across same-organization workspaces they can currently access; workspace
ownership limits it to the approving workspace, and organization ownership requires
account-admin approval. Only the owner may attach a user machine. Moving a running
chat is explicit owner consent for that logical turn, even when another person,
a schedule, or an agent started it. The route changes immediately; the next tool
operation uses the new machine. Already dispatched work is not moved or replayed.
The separate `session_turn_machine_consents` receipt is bound to the current attempt
and to replacement attempts of the same turn (recovery, failover, retry). It does
not change the initiating person, rewrite accepted resource snapshots, expose the
owner's other machines/resources, or authorize another person's future turns.
Only the human move path supplies `consentToCurrentTurn`; session creation and
schedule seeding do not implicitly consent for a running turn. The receipt's
route epoch records which successful move supplied consent and orders successive
clicks; it is not a standing route lock. Metadata resolution does not audit usage
or demand an unchanged pointer, while dispatch checks the current selection and
records usage once. Worker and API-direct browser/computer/file routes share this
authority, including turns without an initiating human.
Without a turn-bound move receipt, an exact attempt still needs an explicit
`connected_machine.use` grant for that session visibility/context.
Once/session/always grants use the common personal-resource lifecycle;
every operation revalidates the exact attempt, owner
membership revision, target-workspace access, authority epoch, resource/grant
generation, interruption state, and current machine selection immediately before
the machine transport is used. Revocation advances the machine and common authority
generation and invalidates existing grants.

### Control transport recovery

The API/worker uses its shared NATS connection for control RPC, operation frames,
and acknowledgements. The native supervisor treats either control- or bulk-lane
loss, including scheduled five-minute user-JWT expiry, as a transport-generation
change: it reconnects, authenticates again, resubscribes, and detaches rather than
restarts accepted commands. The WebSocket/QUIC relay is a separate stream plane;
it does not carry these NATS control requests. Codemode's NATS dispatch is only
a wake-up for its PostgreSQL operation journal; clients re-notify the same
operation, and the worker claims that row before execution.

For control reply recovery, a read-only ping obtains a batch of 64 single-use
tokens and negotiates the NATS response header `Opengeni-Control-Replay: 2`.
The caller caches them by authenticated bus and exact process subject, including
across one-off RPC adapters. Warm calls take a token without another round trip;
at 16 remaining tokens the caller replenishes in the background, sharing one
pending refill across concurrent callers. Cold, expired or exhausted pools wait
for a batch. No idle timer or recurring ping is introduced. The batch window is
twice the requested call timeout plus recovery allowance; the caller discards
tokens without enough remaining headroom, conservatively measured from before
the batch request. The receiver retains each opaque token's deadline on a
suspend-inclusive elapsed clock (Linux BOOTTIME, macOS MONOTONIC_RAW, Windows
GetTickCount64), never civil time. Sleeping does not extend the delivery window.
Supporting callers send the immutable delivery to
`<exact-process-rpc-subject>.replay.<token>.<age-ms>.<lifetime-ms>`, with the unchanged protobuf request
as its payload. Only issued, unexpired tokens can admit work. First admission
binds the payload digest and timing; duplicates join its pending reply or retrieve the exact
retained bytes. Changed payloads or timing are refused. The journal survives
socket/JWT/credential replacement, including removal and re-addition of the same
exact origin/connection/process scope, but is not shared across different scopes.
Receipts and unused tokens are collected after expiry; unknown tokens are never
admitted, so collection cannot license another execution. Neither admission nor
the caller's retry budget reads wall time: clock skew, jumps and corrections do
not poison this transport. The call offset is elapsed caller time since receiving
the batch, anchored at the receiver's issuance time. This conservatively includes
return-path latency in the call budget, but not idle prefetch age. Future offsets
are refused. Receipt expiry is the earlier of the batch deadline and the fixed
call offset plus lifetime. Streamed exec uses its existing relative timeout from
that same call offset; delivery or retries cannot reset the deadline.
The absolute exec deadline remains only for legacy one-shot peers. This does not
change external authentication systems' clock requirements.

Private batch allocation avoids distributing the same single-use token to several
workers through a broadcast hello. It also avoids estimating wall-clock offsets
from heartbeats, which can become stale when a clock jumps. Long machine sleep can
expire already-prefetched tokens: the first refused call is not silently retried
under a fresh identity; the caller discards its pool and refreshes for the next
call. An unknown token never grants fresh execution.

The requester retries transient transport failures within the operation's request
timeout plus a two-minute recovery allowance, preserving the delivery identity
and bytes. It subscribes to the exact process's existing `.hello` subject before
sending a journaled delivery (or its safe negotiation ping). A hello, or recovery
of the requester's own NATS connection, immediately resends that same delivery to
the same reply inbox, without waiting for the operation timeout or resetting its
deadline. The supervisor sends hello only after both transport lanes and its
subscriptions are established. Resend observers and reply subscriptions are
removed when the request settles. This continuity requires the runtime deployment
and agent readiness ordering; older agents remain wire-compatible, and mutations
without negotiated journal support remain one-shot.

It never retries a received tool error. Rejected expired/unknown or conflicting
deliveries return a non-retryable protocol error promptly, explicitly preserving
an unknown prior outcome instead of silently timing out. A later no-responder cannot
erase uncertainty from an earlier send. Accepted physical work and any unflushed
reply retain the existing update-drain reservation until a successful socket
publication or receipt expiry; independent physical producers retain their own
reservations until they settle. This is transport proof,
not proof that a caller consumed the reply.

The guarantee requires both the updated server runtime and a native agent with
the v2 journal. Mixed versions (including a v1 journal) use the existing
conservative one-shot mutation behavior. An old caller with a cached v1
negotiation receives an explicit unknown-receipt error from a v2 receiver, never
fresh execution. Native process replacement, revoked
authority, genuine tool errors, and outages beyond the recovery deadline are not
transparent successes: the existing failure/unknown-outcome semantics remain,
and ambiguous mutations are never automatically reissued as fresh deliveries.
No tool schema or previously sent history changes. Protocol rejection messages
can reach tools and therefore require model-facing review.

Retrying stops early when the agent process a request was sent to is replaced.
While an attempt waits for its reply (every second, from Opengeni's own records,
never by contacting the agent) and after each failed attempt, the requester
checks the enrollment's live connection instance (an unknown answer counts as
unchanged), so a request a host holds for an agent that no longer holds the
connection ends too. Once a new connection has replaced the request's (the
agent restarted, a second process took over, or a compute sandbox's VM booted
fresh), the request ends at once with `agent_offline`: "The machine's agent was
replaced before this request reached it, so it did not run." when no attempt
reached a responder, otherwise "The machine's agent was replaced while this
request was in flight, so its outcome is unknown." The texts say "replaced",
not "restarted": a new connection does not tell which happened. A request that reached no responder is re-admitted to the new
connection like any never-sent request, and a read whose outcome is unknown is
read again; nothing else is re-sent, and the old subject is never rebound to the
new connection. A replaced connection does not prove the old agent process
exited: an agent keeps its operations across a disconnect, and once the new
connection's lease expires the old process can hold the connection again. So a
streaming exec that was started, or may have been, is not settled by the
requester. It is handed to the session's command ledger with a stop request
bound to its exact enrollment, connection instance and operation (the same
adoption used when a machine stops answering), and the exec ends with
`agent_offline`. Once an agent had acknowledged the command (accepted its
start, or reported its status, also to an earlier read through the same
connection), the text is "The machine's agent was replaced while this command
was running, so its outcome is unknown: it may still be running, or it may have
finished." Otherwise it is "The machine's agent was replaced before this
command's outcome was known: it may not have started, may still be running, or
may have finished." Either ends with " A stop has been requested for it." only
once the ledger has recorded that stop. A turn records it through its own
adoption; a direct terminal or file request records it in the same ledger
without a turn. If recording fails, the caller keeps custody and goes on
stopping it, as for a machine that stopped answering, and the text claims no
stop. A direct terminal exec whose own deadline passes meanwhile ends with that
same answer, not exit 124: it reports 124 only when its deadline provably ended
the command. The reconciler alone decides the outcome: it delivers the stop if the old
runner answers again, and settles the command as lost once the enrollment
retires that runner (revoked, a different connection instance, or a stopped
connection). The exec's own timeout also covers its
start and first attach, so an exec whose agent never answers ends at that
timeout; a start that timeout abandoned is never sent afterwards, every retry
of a start keeps the one absolute deadline fixed when the exec began (neither
subscription setup nor a retry extends it, and no start is sent once it has
passed), and a start re-admitted to a new connection is sent only the time
left. A start that timeout or deadline ended before any OpStart was sent fails
as never sent, so nothing keeps custody of it or waits on its agent.

A runner reports what it still runs or retains, and Opengeni answers which of
those to end. Every OpStart carries the connection generation Opengeni
dispatched it under (the enrollment's generation moves only when a different
process claims the connection), and the agent stores it with the operation when
it admits it, so no operation's generation is ever inferred later. On every
connection, and again while it holds a completed operation whose output nobody
released (about a minute after completion, then backing off to ten minutes,
and only while such output remains), the agent reports its operations. The API
answers each page in the same exchange, and only to the process that holds the
connection:

- An operation with a command of that exact process is decided by the command.
  One in flight is kept. One that exited is ended once Opengeni has stored its
  output (the release is recorded before the answer is sent) or recorded it
  unavailable, and a lost one is ended. Output Opengeni has not stored is never
  ended: the API keeps it and collects it while the agent is talking, and
  collecting releases it in the same exchange.
- An operation without a command (foreground work, or a command deleted with
  its chat) is ended when it started under an earlier generation than the
  current one, because its requester can no longer address it. Otherwise it is
  kept, running or completed, however long ago it completed: no durable record
  shows that a foreground requester finished with its output, and age never
  shows it either, so the agent's own retention bound limits what it keeps. One
  an older Opengeni started carries generation 0 and is kept.

The agent cancels what it runs and drops what it retains; none of it runs again
or writes into a settled record. So a process that comes back after another
process took its connection stops what Opengeni settled meanwhile, whatever
happened to the chats. The agent starts every such exchange, so none reaches an
agent that is not talking, such as a sleeping compute sandbox. An agent that
does not report keeps the earlier behaviour.

Requests Opengeni sends on its own behalf rather than for a call (the release
of stored output, the collection of output an inventory answer kept, and the
reconciler's recovery query for a running command, to any runner) carry the
`Opengeni-No-Wake` header. A compute host delivers such a request only while
the sandbox runs and its agent holds the link, and otherwise answers it itself
with `Opengeni-Agent-Unanswered` (`asleep`, `away` or `busy`) without waking
the sandbox; a Connected Machine agent simply receives it. When such a request
goes unanswered (that header, no responders, a lost link or a timeout),
Opengeni records nothing and leaves the work to the agent's next inventory. The
reconciler asks a runner that reports its inventory, compute or Connected
Machine, once: after one unanswered query it defers the command (outcome
`provider_unanswered`) and does not claim it again until the agent reports it,
the command is stopped, or its runner is retired. A runner that does not report
its inventory is asked again on a later pass, as when it is offline, and when
the reconciler cannot read which kind of runner it is, it leaves the command
for a later pass and records nothing. A Connected Machine never sleeps, so its
answered queries continue on each pass as before.

A stop can reach an agent before the start it stops, for example when the
start sat on a link that ended and is delivered again. The agent then refuses
the start and keeps a tombstone for the operation: a query or attach answers
`COMPLETE` with a cancelled exit and no output. The requester treats that
answer as the command's end (cancelled, exit code -1, no output, nothing
proven to have run) and never waits for frames from it, so the stop settles and
nothing keeps custody of the command.

### Enrollment maintenance boundary

Migration `0498_enrollment_membership_fence.sql` repairs user-owned device approval
under a non-superuser, non-bypass migration owner. Stop every old API/control/turn
worker and supply the exact application-role list before applying it; the migration
refuses live listed connections. Start only the matching binaries afterward—do not
restart pre-0498 approval writers. This is not a rolling or application-rollback-safe
cutover, and preparing the migration does not authorize deployment.

User approval takes the organization membership fence before RLS workspace-tenancy
entry, pending-request locks, and enrollment writes. Both the public wrapper and
SQL finalizer fail closed with `55P03` on fence contention rather than waiting while
an unknown caller may hold a reverse-order lock. Retry the complete transaction
after the membership change settles; no failed approval is automatically replayed.
The finalizer rereads exact active organization membership under that fence and
retains workspace membership `FOR KEY SHARE` to exclude direct runtime DELETEs.
Direct workspace-removal preparation takes the same early nonblocking fence before
downstream rows; its command keeps the existing organization/tenancy prefix.
Workspace token enrollment retains its existing workspace-owned authority
contract. A personal (`enroll_user`) token takes the same organization membership
fence and `finalize_scoped_enrollment` path as a personal approval, with the
token's signed owner as the transaction subject; see the zero-click token section.

Known separate boundary: `scoped_compute_actor_membership` still uses an
organization-membership `FOR SHARE` that can be blinded by FORCE-RLS under this
owner posture. Its list/rig/attach consumers—including `list_scoped_enrollments`,
`get_scoped_sandbox`, and `authorize_scoped_sandbox_attach`—are not repaired here.
Successful enrollment does not establish a complete Connected Machine availability
fix or prove that those downstream paths work.

Device-code lookup is another unresolved boundary: the migration-0025
`opengeni_private.resolve_device_enrollment_request` SECURITY DEFINER resolver can
return no row under the tested non-bypass owner/FORCE-RLS posture because it lacks
the required context. Independent tests reproduced the same three
`getDeviceEnrollmentRequestByDeviceCode` failures before and after 0498. The legacy
suite's historical 0025 replay recreates this resolver through a superuser, so a
pass after that replay does not validate non-bypass device-code lookup. The 0498
approval/finalization tests do not certify end-to-end device-flow availability;
this migration does not repair the resolver.

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
| Working dir  | `/workspace`                    | the agent-reported absolute host root, optionally narrowed per session |
| Backend enum | `docker`/`modal`/`local`/…       | `selfhosted`                                       |

An Opengeni compute sandbox (`compute`) is a managed sandbox that runs this same
agent. Its enrollment has kind `sandbox`: Opengeni creates it, it has no key or
bearer, and it is never listed, offered, attached or granted as a machine; its
lease authorizes its use, and it is revoked when the sandbox is deleted. The
agent reaches NATS through its host's link to the API's agent gateway.
See [compute backend](compute-backend.md).

The model that follows from this: a machine-bound session has **no phantom Modal
"home box"**, **no Opengeni Git token is distributed to the machine** (it uses
its own SSH / `gh` / credential helper), repos are **not cloned onto it**, and
the agent runs under a **per-session working directory** (making its own
worktrees under that path as it needs them). The authoritative runner Hello
already reports its absolute launch root; Opengeni persists it and resolves an
optional relative session folder once against that root. The SDK manifest,
exec cwd, filesystem calls, editor, and PTY all use that same host-native path.
Relative operation paths resolve from it and absolute paths stay literal, so
`/workspace` has no special meaning on a machine.

The Files surface advertises that effective path as `FileSystem.root`, including
Windows drive and UNC roots. A canonical absolute `sandbox:` link opens the tree
in the same namespace and sends the negotiated `{ epoch, root }` identity with
each list, read, or mutation. The API validates that the path remains beneath
the advertised root, pins the request to the first resolved active route, and
uses a contained workspace-relative path for machine execution. Responses keep
the canonical host-native spelling; a route or root change returns a retryable
conflict instead of a misleading outside-workspace validation error or a read
from a different target. Provider-independent artifact receipts may still use
their own portable identity where that receipt contract requires it.

The exact model-visible tool catalog remains available through Codemode without
installing a machine credential. Opengeni sends no Codemode manifest pointer or
token file. Instead, the worker snapshots a renewable exact-attempt URL/bearer
only into each new child exec. It is never written to disk or stable machine
state. The installed binary exposes its absolute path to that authorized child,
so `"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode list|show|call` works even without
Bun/Node/`ogtool`. Default text and `list --json` return all authorized tools with
short summaries, without an aggregate stdout cap or default pagination;
use `list --query <substring>` to filter, or explicitly opt into a slice with
`--limit <1..100> --offset <integer>`,
`list --json` for digest/count/continuation metadata, or `list --full` for the legacy
complete catalog. `show <path>` returns the complete details/schema for one tool;
redirect large output to a file and read only needed ranges.
It reaches the same journal/executor as model MCP; the machine
still owns every ordinary credential and ambient environment.

Native `codemode call` accepts inline JSON (default `{}`), `-` to read one UTF-8
JSON object from stdin through EOF, or `@path` to read it from a local file.
Use stdin or a file for large arguments so the operating system's argv limit
does not apply to the JSON payload:

```sh
"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode call server.tool - < arguments.json
"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode call server.tool '@arguments with spaces.json'
```

Relative file paths resolve from the command's working directory. Input is read
once and validated before catalog lookup or submission; errors do not echo the
file's contents. Omitting arguments does not consume stdin. These input forms
require an updated native agent; API/tool payload limits and the existing
attempt journal, approval and recovery semantics are unchanged.

Vault secrets reach a machine only per command. When an `exec_command` or
`run_on` command contains `{{secret:…}}` references, Opengeni runs it with
`/bin/sh -c` on POSIX hosts or `powershell -NoProfile -NonInteractive -Command`
on Windows (an explicit supported `shell` argument is honoured), splices each
reference as `OPENGENI_SECRET_n`, and sends the values only in that command's
`ExecRequest.env`. `{{secretfile:…}}` files are written under the 0700
`/tmp/opengeni-private` root. Attached exec attempts remove their scope on attempt
end; terminal one-offs clean it on return, while yielded `run_on` commands retain
it as described below. That best-effort cleanup
first waits for any write still in flight from an exec that timed out during
preparation, and such an exec writes no further file. `cmd.exe`, fish
and unknown shells return `unsupported_shell`. Commands without references run
exactly as before, and nothing from a vault is copied into the machine's
environment. See [`secrets.md`](secrets.md#where-references-resolve).

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

The macOS native bridge drains Cocoa autorelease pools around synchronous calls
and each Accessibility worker iteration. Stream ownership includes stopping a
requested capture even when startup times out; dropping a timed-out request does
not cancel the OS operation. The desktop viewer publishes discovered targets
before awaiting semantic observation so a stalled app cannot prevent switching
to another window or screen. `macos_autorelease` exercises the actual helper with
Objective-C missing-pool diagnostics enabled; run this ignored test explicitly
in an unlocked local GUI session.

Accessibility notifications invalidate the snapshots that registered the changed
element, so one observed window's value changes do not discard an unrelated
window's observation. Application-wide focus/layout events, unrecognized event
sources, and overflow of the bounded 64-notification queue still invalidate all
snapshots for that process. Every semantic action continues to verify the target,
element identity and observed state immediately before dispatch.

Native window and screen pointer input uses the exact painted frame's encoded
dimensions. Continuous capture retains superseded frame metadata for at most
two seconds, bounded to 32 frames per target and 512 per adapter, so a newer
capture does not reject a pending viewer click. A latest still screenshot keeps
its existing authority during agent planning. Input clears retained frames;
target generation, native identity and current placement checks remain enforced.

On macOS, runner restart waits for the previous launchd label to disappear before
accepting a replacement. A matching program path on a retiring job is not proof
that the replacement started.

If a desktop producer ends after delivering frames, the viewer exposes its
connection error and Reconnect action instead of leaving the last image over
them. Exhausted socket retries become an explicit connection error. Refresh
desktops also retries a failed stream; terminal placement changes still require
the existing replacement-session recovery path.

The Chrome Native Messaging bridge accepts two exact extension origins: the
development manifest key (`imdmcebcclhibdfolbokjbiibpcnpbel`) and the Chrome Web
Store item (`phpmmcbeelfkcinjfbbggegjdcdmnnch`). Both the installed native-host
manifest and the agent's native-host invocation check must include the store
origin. Older agent releases that only accept the development origin cannot
connect the store-installed extension; updating the extension alone cannot fix
that host-side restriction. Store uploads omit the development-only manifest
`key` field.

Where the browser finds the native host depends on the platform. On macOS and
Linux the agent writes `ai.opengeni.browser.json` into each Chromium-family
browser's per-user `NativeMessagingHosts` directory. On Windows, browsers look
the host up in the per-user registry instead: the agent writes the one manifest
to `%LOCALAPPDATA%\Opengeni\NativeMessagingHosts\ai.opengeni.browser.json` and
sets the default value of
`HKCU\Software\Google\Chrome\NativeMessagingHosts\ai.opengeni.browser` (and the
matching keys for Chromium, Edge and Brave when those browsers are present) to
that path. Removal deletes only keys that still name this agent's manifest.
When the extension cannot reach the agent, its popup says why: no agent is set
up on this computer, the agent is too old for the extension, or it is not
running.

The bridge generation is an opaque unpadded-base64url token: leading `-` and
`_` are valid and retained verbatim in inventory and discovery. Rejecting either
prefix strands a healthy bridge until its next generation. Rolling migration
`0525_attached_browser_opaque_generations.sql` aligns the database bridge-generation
check with this contract; API validation alone does not restore discovery.
Extension handshake
timeouts and rejected readiness fences clear the exact failed port and reconnect
with bounded backoff; late events from that port cannot invalidate a successor.

Attached Chrome profiles are a separate physical placement. Inventory reports a
`connectionGeneration` that becomes the BrowserSession/ComputerSession
`placementInstanceId`. When that generation changes, Opengeni marks the exact
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

The extension's hello carries two generations. `connectionGeneration` is new
for every native port and fences that transport: commands, results and
inventory must name the exact live port. `stateGeneration` is created once per
extension worker lifetime and reused by every native reconnect in it; Chrome
keeps the tab ids, pages and debugger attachments that the worker owns for
exactly that long. The agent reports `stateGeneration` as the profile's
inventory `connectionGeneration` (the placement instance above), so a
native-host exit, an agent restart or an agent update reconnects in place and
the profile's sessions stay live; if the agent restarted, the next action
re-creates the controller session. A restarted worker, a reloaded or updated
extension, or a restarted Chrome reports a new `stateGeneration` and ends the
sessions as above. Extensions that do not send `stateGeneration` keep the
per-port behavior, and the agent's update gate waits while one of them backs a
live attached controller, because restarting would end its sessions. A
quiescent attached session does not otherwise hold back an agent update.

Each ended connection generation is recorded with its reason in
`attached_browser_devices.connection_history` (the latest 50 per profile).
The native host sends a final `native_host_closing` frame before it exits,
naming whether Chrome closed the port (`browser_closed_port`), sent an
unreadable message (`browser_message_invalid`) or stopped accepting output
(`browser_output_failed`). A socket end without that frame is
`native_host_lost`: the native host process itself vanished. A hello or message
the agent refuses is `agent_rejected`. The agent reports its recent ends in
every inventory snapshot. The server records `agent_restarted` for generations
that ended with a replaced bridge and `unreported` for older agents; a later
agent report for the same generation replaces either inference. Native-host
diagnostics are written to stderr because stdout carries Chrome frames.
Oversized tab titles are truncated and oversized tab URLs make only that tab
uncontrollable; neither ends the profile's connection.

Renaming a Chrome profile is inventory metadata, not a connection transition.
The extension keeps the same ready native port and sends optional
`profile: { profileLabel }` metadata with its inventory revision. The agent updates
the profile name without replacing its generation, debugger attachments or pending
commands. A null label restores the default name. Older extensions may omit this
metadata; an older agent ignores it and keeps its last announced name until a real
reconnect, rather than interrupting the profile's work.

Machine availability is also not a turn-admission dependency. A text-only turn
can start while the selected machine is offline. If the model invokes a machine
operation, the typed offline/timeout result returns to the model in-band so it
can explain the outage, choose another available tool or compute target, or help
recover the machine. The transport failure must not replace the agent loop.
The same holds for sessions with repository resources, whose repository Skill
index is built through the sandbox before the first model call: a typed
offline/timeout control error during that discovery degrades to a short
"repository skills unavailable" instruction for that run instead of failing the
turn, and the next run discovers again.

## Create a session on a machine

`createSession` grows two fields for a Connected-Machine target:

- **`targetSandboxId`** (uuid) — the enrolled machine to run the session on (a
  `MachineView.sandboxId` from `listMachines`). It **seeds the active-sandbox
  pointer at creation**, so the very first turn lands on that machine.
- **`workingDir`** (host path) — the directory the agent runs the session under
  (its cwd base for exec, terminal, and the file dock). It may be absolute or
  relative to the persisted Hello root. Tilde is rejected because the control
  plane does not know an authenticated service-user home directory.

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

That API-key example applies to workspace- or organization-scoped machines. A
user-scoped machine must be selected by its owning managed human. The managed
web console discovers the machine's personal authority and includes an atomic
`personalResourceAttachment` in the create command after the owner chooses
`once`, `session`, or `always` and acknowledges workspace-shared output. The
server derives the selected enrollment from the locked session, issues
`connected_machine.use` in the same accepted-turn transaction, and preserves a
`once` decision across recovery of that logical turn. Callers never nominate a
machine authority or issue a standalone grant before creating the session.

Rules to keep in mind:

- **`workingDir` requires `targetSandboxId`.** Sending `workingDir` alone (with
  no machine target) is a **422** — a bare working directory has no machine to
  resolve it against.
- Omit `workingDir` and the session runs under the machine's persisted
  **workspace root** (the agent's launch dir).
- New attaches store and return the resolved absolute `workingDir`. Legacy rows
  may remain null/relative until they are reattached; establishment resolves
  them against the current persisted Hello root.
- **Repos are not cloned** onto a machine target. `resources` you attach are
  available for context, but the platform never `git clone`s onto the user's
  real filesystem — the machine uses its own git auth.
- `sandboxBackend` selects the backend for a **managed** sandbox; for a machine
  target the backend is the machine itself, so leave it off and point at the
  machine with `targetSandboxId`.
- When the deployment default itself is `selfhosted`, the web composer starts on
  Connected Machine and selects the first online machine. It does not offer a
  fictional managed default, and submission stays blocked until a machine is
  available. The API also rejects a targetless selfhosted create before writing
  a session.
- **A child spawn with `targetSandboxId` / `machineTarget` is an own-box
  machine-primary home**, even when the parent is `backend: none`. Omitted
  `sandbox` still shares the creator's box only when no machine is named.
  Explicit `sandbox: "shared"` or `{ groupId }` plus a machine target is a
  **422**.
- When a child omits both `sandbox` and `machineTarget`, sharing a parent that is
  currently routed to a Connected Machine automatically copies that exact
  machine and working directory to the child before its first turn. A
  `backend:none` parent remains a backend-none shared home; its valid attached
  machine is an independent active route and is inherited without relabeling the
  child. The model does not choose the machine again. A selfhosted-only create
  with neither an inherited nor explicit machine is rejected before an unusable
  session starts.

Personal-machine consent also covers the consenting session's agent-created
descendants (0851). Every causal parent/turn link must remain in the same workspace
and belong to the same machine owner and initiating human. Admission and dispatch
reuse the original grant, never mint child grants, and recheck each parent machine
snapshot for the exact creating attempt plus live membership, machine authority, grant generation, expiry and
revocation. `once` covers only descendants of the originating accepted turn;
`session` covers its consented session tree. A sibling of the consenting session,
an unrelated chat, a bare parent/group ID, another human's turn, or another machine
is not covered. Other personal-resource grants remain exact-session.
An owner move's logical-turn receipt follows the same causal tree and live
authority checks when no exact-session machine grant exists. If a source grant
exists in the current execution epoch, tree coverage stays grant-derived: a
move receipt cannot bypass its expiry, revocation, generation change or stale
grant snapshot. Grant-backed ancestors must have a valid grant snapshot; a move
receipt is never a replacement for a failed snapshot check.

Parent IDs alone are not delegation evidence. `create_agent_child_session`
verifies the exact live parent turn/attempt/generation and requires the request's
claimed human (the agent attempt's verified initiating human, or the subject of a
direct request) to match the turn's recorded initiating human. The child's
creator must be that turn's frozen initiator, so the owner's service-initiated
turns (internal-update deliveries, goal continuations) are covered while another
person's turns never match. The same SQL statement inserts the child and its immutable,
owner-protected witness; there is no post-insert stamping function. Both grant
and receipt inheritance require that witness at every edge and match the human
to the machine's grant/receipt owner. Direct inserts, unscoped legacy creates,
turns with no initiating human and legacy children without it remain uncovered;
migration does not backfill proof from readable parent IDs. Existing
exact-session grants remain usable.

As with exact-session machine checks, these functions trust account, workspace
and subject/initiating-human claims installed by the authenticated API. Protecting against an
application role that lies about those claims would require a separate
claim-bound attempt capability; this migration does not introduce that model.

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

Workspace settings can choose `defaultExecutionTarget` as managed compute or an
exact shared Connected Machine. New top-level chats with no explicit placement
inherit that default. Child and existing chats retain their existing placement;
a removed or unavailable configured machine fails visibly and never selects a
different computer. Personal machines cannot be workspace defaults.

A schedule can save `agentConfig.executionTarget: "workspace_default"` instead
of an explicit backend or machine. The worker resolves the current workspace
choice only when accepting a new run chat, freezes it in
`resolvedMachineTarget` (including an explicit null for managed compute), and
re-proves live machine access before attaching. Recovery uses that receipt even
if the workspace default changed. Reusable schedules resolve once for their
first chat; later occurrences keep that chat's machine. Schedules following the
workspace do not implicitly pin a managed Sandbox Environment, since a future
run may use a Connected Machine. Explicit environment selections retain their
normal authority checks. Old schedules without `executionTarget` keep their
previous behavior.

Scheduled agent tasks also support the explicit targeting rule. A generated-session
schedule persists a `machineTarget` containing the exact `targetSandboxId` and
optional `workingDir`; the worker proves that machine is still available and
seeds the generated session's active pointer before its first turn. A deployment
whose default backend is `selfhosted` rejects a generated-session schedule that
does not select a machine instead of creating a session that cannot execute.
Manual runs also preflight current liveness and the reported workspace root
before consuming run capacity. After that preflight, session creation rechecks
durable target authority and commits the active pointer in the same transaction
as the new session row. If the target is invalid, removed, revoked, or otherwise
no longer attachable, the create fails without leaving a queued session shell.

Workspace- and organization-scoped machines run any schedule. A user-scoped
(personal) machine runs only an **Only me** schedule owned by the machine's
owner:

- Saving is the consent. Create and update accept a personal machine only when
  the final audience is Only me; widening such a schedule to Workspace, or
  saving it for Workspace, returns 422. The scoped sandbox lookup returns a
  personal machine to its owner alone, so nobody else can select it.
- Each run attaches the machine through the owner's scoped authorization and
  then issues a `session`-mode `connected_machine.use` grant (context
  `user_private`) for exactly that run's chat. No standing `always` grant is
  created, so the owner's other chats keep asking.
- Every attempt goes through the same database admission as an interactive
  turn (`admit_session_attempt_personal_machine`): the run's causal human must
  be the machine's owner and still an active member with access to the
  workspace, the machine's authority must be current, and the run's grant must
  be active. Removing the person, revoking the machine or revoking the grant
  stops the next attempt.

On macOS, the enrollment display offer is independent of Screen Recording
permission. A detected display keeps the existing screen-control consent option
available while OS grants are pending. Approval does not grant macOS permissions:
Screen Recording, Accessibility and Input Monitoring still gate capture/input.

## Discover machines + metrics

`listMachines` returns the workspace fleet plus the active-sandbox pointer. Pass
`sessionId` for an in-session view, which also folds in that session's synthetic
home group box when one exists and the session's active-sandbox pointer. A
`backend:none` session has no synthetic home, but its owned Connected Machines
remain visible and attachable.

List `state` is the durable heartbeat cursor (`lastSeenAt`, `wentOfflineAt`),
not a live ControlRpc ping. A fresh heartbeat is online; a clean goodbye or a
stale/missing heartbeat is offline. The list therefore does not emit
`reconnecting` (that blip needs a missed live probe). Attach, capability
negotiation, and fleet tools still ping when they need to know whether a
responder is answering now.

Runners also sample desktop availability off the control loop and include the
latest completed sample in heartbeats. Display sleep/wake, Mac lock/unlock, and
Screen Recording permission changes refresh the desktop state without restarting
the runner or changing its connection generation. A blocked snapshot disables
desktop access and supplies the reason; it never grants screen-control consent.
Older runners omit this optional field and retain their connect-time Hello state.
An unchanged snapshot does not rewrite capabilities or release/update metadata.

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

`ERROR_CODE_DRAINING` is a pre-execution admission refusal, not proof that a
machine is at capacity. Runtime errors preserve its typed cause: `agent_update`
means a verified self-update is draining accepted work; `queue_breaker` and
`wait_breaker` identify abnormal admission backlogs. Missing or unrecognized
detail remains an unspecified admission refusal. The same distinction survives
retry exhaustion and structured tool-error rendering. A self-update on a busy
host is accepted and waits for idle: the agent reports `waiting_for_idle` with
the current reason (`update_busy_work`, `update_busy_uploads`, `update_busy_interactions` or a transiently
unreadable controller as `update_state_unavailable`), keeps admitting new work,
and every few seconds re-attempts a short fenced idle proof, reopening
admission whenever it is still busy. It never cancels accepted work, stops
long-lived servers, or restarts the host early. On Linux and macOS a running
streamed command (an `OpStart` exec) does not hold the update back: after the
verified binary is installed, the agent hands each such command to its
successor and `exec`s the new binary in the same process. The command keeps
running as the same process with the same pipes, process group and operation
cgroup; the successor keeps the connection instance, so the server sees a
short reconnect on the same op subjects (no `GoingOffline`), re-attaches as
after any reconnect, and the stream continues byte-exact with one digest.
Every failure is fail-closed: a command that cannot be continued ends as a
typed failure, and if the successor never starts, the command's anchor ends it
as for a crashed runner. Other admitted work, such as a request still being
answered, a git operation or a pending upload, still makes the update wait,
and Windows keeps waiting for every command. Command spawn failures, cancellation
and panicking waiters retain their actual cleanup owner until exit is proved;
they do not permanently disable self-update. A transient cleanup error is scoped
to its exact producer and clears only when that producer obtains completion
evidence. While that evidence is unavailable, the update reports retryable
`update_cleanup_unconfirmed`; the response and agent log identify the producer
and explain recovery. If the cleanup owner itself was lost, finish active commands
and restart the agent service before retrying. An unreadable admission boundary
still reports `update_state_unavailable`. A browser controller that crashed, was killed or
stopped uncleanly is not lost settlement on Linux and macOS: it runs as the
leader of its own process group, so the update waits (busy) only until nothing
remains in that group. The browsers it launched run in their own sessions and
are adopted by the next controller. The agent checks every owned browserd scope through
its private admin-only idle proof. Open sessions block only when a restart
would lose something: admitted commands, pending creation or shutdown,
busy attached browser sessions, browsers without a durable working runtime, and
isolated virtual desktops. A quiescent managed browser with a durable working
runtime does not: graceful browserd shutdown detaches from it without closing
it, so its tabs and unsaved page state stay live and the restarted controller
adopts the same process on its next request, even when the old launcher was
killed with the stopped service or came from an earlier agent release. A
session whose browser already ended and a computer session on the machine's
own physical seat do not keep the host busy either.

The idle proof also carries bounded blocker snapshots: categories and counts,
not private session IDs, command text, page titles, URLs or filesystem paths.
Controller scopes can belong to different workspaces on the same host, so
session identities never leave that boundary in update diagnostics. The
agent emits a progress event when the reason/categories change and refreshes
counts at most once per minute. Enrollment
progress retains it under the existing exact operation/process fence, clears
it when the update advances or its accepting process is replaced, and exposes
it through Machines and fleet. Machines highlights a hold after ten minutes and
shows elapsed time from the original request; this is presentation, not a
deadline or permission to end work. The snapshot is last-reported evidence,
not a live ownership query, and the counters can describe overlapping ownership
layers rather than distinct commands. Older ambiguous `update_busy_work`
receipts cannot identify a culprit and are labeled accordingly. A settled
attached-transport error does not itself hold admission: the uncertain action
remains journaled without retaining a running queue or replaying the action.
These diagnostics do not establish the cause of an earlier hold whose admission
snapshot was not recorded, and do not change the admission decision or cancel work.

Older agents still end a
busy update with retryable `update_busy_work`. Nobody has to request updates:
the control plane asks every live machine behind its channel's promoted build
to update from its heartbeat, and asks an older busy agent again every 10
minutes until it applies (see the deployment guide for the full policy and
`OPENGENI_AGENT_AUTO_UPDATE`). A request for the build a machine already runs
is refused, whatever happened to an earlier attempt.

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
Normal foreground completion, cancellation, timeout, and task abandonment all
converge on the same cleanup: the process group is killed and reaped, then the
runner removes its operation leaf. The Unix group anchor also holds a
kernel-close death lease on the runner process. If the runner is killed without
executing Rust destructors, EOF makes the anchor write the operation leaf's
`cgroup.kill` file, or kill its exact process group where cgroups are unavailable.
Windows retains the equivalent kill-on-close Job Object guarantee. A teardown
that races final descendant release waits for the kernel's `cgroup.events`
`populated 0` notification; it does not retain an empty operation cgroup until
service restart.

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
that same PostgreSQL snapshot verifies the accepted attempt, its owner-click
consent or immutable admission snapshot/current visibility-keyed grant,
membership/generation fences, and the
runner connection. One-off `run_on` exec/read/write uses the same boundary after
creating its attempt snapshot, so a concurrent revoke cannot reach the provider.
Organization- and user-scoped machines used from another same-organization
workspace retain the machine's origin workspace for their physical control and
relay route; the session workspace remains the authorization target. A refused
op-stream `OpStart` may be retried only after a fresh live admission proves the
exact route and policy are still current. It is never retried through a second
wire form.
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
Foreground attempt-owned exec is terminated by Pause, Steer, terminal
cancellation, or its explicit deadline, using the exact POSIX process group or
Windows Job Object and including ordinary descendants spawned by a shell. A
model-facing exec that outlives its bounded yield is different: before returning
a background command ID, the worker durably transfers it to the session and
freezes the physical control workspace, enrollment, connection instance, and op
ID. Normal turn completion and Steer detach from that adopted command; they do
not cancel or retarget it. Session/workspace Pause and terminal Cancel atomically
move adopted commands to `stopping`, after which the global reconciler issues
`OpCancel` only to that frozen subject. Stopping one command through
`DELETE .../background-commands/:commandId` also sends that `OpCancel` from
the API at once, best effort, so the process ends without waiting for the next
maintenance pass; the reconciler still delivers it when that attempt fails,
and the pushed exit settles the command. Switching the session's selected machine
affects future operations only. A connection blip detaches the stream without
killing the command; replay or exact-instance reconciliation collects its
terminal result after reconnect.

The runner pushes an `OperationCompleted` event after exit and pipe drain,
independently of the output consumer and its credit. API ingestion uses the
authenticated control-workspace/enrollment/connection subject and operation ID
to claim the original adopted command, even after its session changes routes.
The collector durably captures retained output through the verified exit frontier
before settlement, so a terminal read cannot race ahead of the final output.
Duplicate events cannot steal an active collector's claim. The runner republishes
unacknowledged terminal records on connection establishment and at its existing
heartbeat cadence over the independent bulk connection, healing a full send queue
or reconnect without waiting for reaper backoff. A delivery-only acknowledgement
stops these notifications after the server durably owns reconciliation; it never
releases retained output. Only the first notification bypasses polling backoff.
Failed collections reuse reconciliation's exponential backoff, and pending
duplicates coalesce per operation. Older agents and lost connections remain covered by
reconciliation. Terminal publication
does not discard retained output; release remains separately retryable after custody.
Completion collectors have independent ingestion capacity, so even a saturated
collection queue cannot delay machine heartbeats. A collector yields to reconciliation
before its existing claim lease expires; this never cancels or time-limits the command.

The session shell capability also preserves an explicit `exec_command.shell`
selection: Opengeni sends that shell as direct argv, with the requested login or
non-login semantics, instead of silently substituting the machine service's
ambient default shell. Calls that omit `shell` retain the machine-owned `$SHELL`
default on Linux and macOS. On Windows they run Windows PowerShell
(`powershell.exe -NoLogo -NoProfile -NonInteractive -Command`), the dialect agents
write for Windows and the one secret splicing already uses, instead of the
machine's `ComSpec` (`cmd.exe`). Internal Channel-A commands keep the machine default.
On Unix a private unreaped group anchor fences the PGID until cleanup has been
issued, so cancellation cannot signal a recycled group and the requested command
cannot exit and leave invisible same-group work behind. The runner-death lease
also closes the crash gap where `Drop` cannot run.
On Windows the owned Job Object provides the same containment and a native
active-process-zero cleanup receipt. Ordinary shell backgrounding (`&`, subshells
and `nohup`) does not detach work from the command's scope. Just before automatic
shell-exit cleanup, the runner observes live non-anchor members using the owned
Linux cgroup, the anchored Unix process group, or the Windows Job Object. Positive
evidence travels with the terminal result and survives command settlement and
agent handover. Only then does a new shell result or terminal command read append
a short notice explaining the cleanup and the foreground `exec_command` workflow
for long jobs. Structured stdout/stderr remain unchanged; ordinary commands,
explicit cancellation/deadlines and older runners produce no inferred notice.
An oversized reply is likewise returned as typed `PAYLOAD_TOO_LARGE`; neither
backpressure nor a reply-size failure changes the machine's heartbeat state.

The agent-facing `run_on` MCP tool is intentionally a one-off side channel to a
specific enrolled machine and never changes the session's active route. Its
personal-machine path requires the same exact accepted-attempt authorization
and current `connected_machine.use` grant as an active route. Its
`exec` receipt reports the exact `exitCode`, typed `timedOut`, and effective
`deadlineMs` (`0` means none). A process killed at an explicitly configured
deadline, or a response with neither terminal exit proof nor durable running
custody, is never reported as `ok: true`; a transport loss after dispatch is
ambiguous and is not replayed. `run_on` uses the deployment's separate
`OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS` and
`OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS` settings (30 seconds and no exec
deadline by default), while preserving the active sandbox pointer and epoch.
Attempt-owned calls use the existing ten-second observation yield and the same
session-command ledger hooks as attached exec (`agent-background-commands.ts`
in core, shared by the API and worker). A still-running command returns
`state: "running"`, a `commandId`, and output so far only after the ledger accepts
custody; use `command_read` or `command_wait` rather than repeating the command.
The observation wait is not a process deadline. HTTP loss is not cancellation.
Failed adoption stops the unowned operation through the existing native cleanup
path; ambiguous machine loss records an exact-connection stop request for the
reconciler. Direct callers without attempt authority retain terminal semantics.
An API crash before adoption remains a non-durable observation window; it does
not make a Unix command block handover. Secret files needed by yielded commands
are not removed on HTTP return. They remain available on the machine for the
owning agent; terminal settlement performs best-effort cleanup only while the
originating session object is still observing it. Later ledger reconciliation
does not delete those files. There is no expiry or forced-cleanup ledger.
There is no new duration limit. Unix streamed one-offs already use
the same update handover as background commands; Windows still waits for live
commands rather than interrupting them.

Fleet entries report the installed `agentVersion` and the accepted `agentUpdate`
status, target, waiting reason and timestamps. Machines shows the current hold
reason and highlights holds after ten minutes; this attention state never kills
work or overrides update admission. Old agents' `update_busy_work` is ambiguous
(it also covered interaction sessions), so it must not be presented as proof of
a stuck command. New agents distinguish interaction-controller holds. Neither
surface reveals another person's command text or private session identifiers.

Large `write` operations use the existing bounded transactional file transfer
when the live target advertises `transactional_fs_write` and
`transactional_fs_write_machine`. Each transfer request
rechecks authority, capability, and the pinned connection; it never falls back
to a whole-file write after an uncertain result. Older agents keep their legacy
small-write behavior and report oversized requests without marking the machine
offline. See [Transactional file edits](#transactional-file-edits).

### Streaming exec (op-stream)

Connected Machine exec requires a runner that advertises the `op_stream`
capability and serves the op-stream protocol with
`OPENGENI_AGENT_OP_STREAM_ENABLED=true` (default on). Opengeni refuses before
starting a command when op-stream is unavailable or unsupported; it never
downgrades exec to request/reply. Output streams as sequenced, credit-flowed
frames the runner retains
for replay: a connection blip mid-command detaches instead of killing the
child, and the server re-attaches and collects the complete output byte-exact
(blake3-verified). Each exec carries a durable op id derived from the model's
tool call, and starting an op is idempotent by that id — a worker-death
re-dispatch that re-executes the same tool call attaches to the
already-running or completed op instead of re-running the command. The
oversized-reply wall does not apply on this path; output is instead bounded by
the runner's retention quotas, and exceeding them fails typed with exact
counters, never silently truncated.

Foreground output can be released within a long turn once the exact tool's
call/result receipt and structural output event are durable. The receipt preserves
recovery while a parallel SDK call batch is still incomplete. Only completed
operations owned by that tool are eligible: parallel results and unscoped setup
work remain retained until their own durability boundary. Each final
acknowledgement still follows journal persistence; failed persistence or publish
keeps the frontier available for retry. Turn completion finalizes remaining
accepted output. Durably adopted background commands keep their separate output
capture and terminal-settlement lifecycle.

Background output has an independent durable custody receipt containing its
verified exit sequence and attach generation. It is recorded only after all
retained bytes have been captured in PostgreSQL. A terminal-only reconciliation
queue retries the final acknowledgement against the original operation and
connection, including after worker loss; a newer enrollment route is never
substituted. Already captured output takes priority over full replay, so older
uncaptured results cannot delay final acknowledgements for saved results. Publish
success leaves the obligation pending until an exact runner
observation establishes that output is no longer retained. A runner that
advertises `capabilities.op_release` in the Hello of that same connection also
reports its own operation inventory (above). It is instead sent one
`OpRelease` for the stored exit frame right where the output is stored; it
drops the operation at once and confirms the release in its answer (LOST,
reason RELEASED, which also answers any duplicate), so the release settles in
that exchange. A different exit frame or a running operation releases nothing.
Foreground command output is released the same way at its durability point
when the runner advertises the capability, and by a final ACK when it does not.
When the storing process dies before it releases or stores the output, that
runner's own inventory recovers it; the reaper sends such a runner nothing and
only rechecks the obligation in the database. A runner without the capability
keeps the attach, final ACK and later observation from the reaper; Connected
Machines do not sleep, so that exchange is answered on the first pass. Compute
sandboxes have no such path (see [compute-backend.md](compute-backend.md)). Completion input to
the model remains independent. Legacy rows require full replay before a receipt
can be recorded; output lost before capture is explicitly marked unavailable
without manufacturing consumption or an acknowledgement.

The output-release due probe and claim inventory use the same runner predicate.
A null connection or an expired/offline connection parks output work without
changing its custody receipt or retry date. Reconnecting the original runner
makes overdue work eligible again. A revoked enrollment, replacement runner, or
explicitly stopped/updated/shut-down runner remains eligible for final retirement
settlement; temporary disconnection alone never proves output loss.

After process exit and pipe drain, the native runner releases both transport-sized
read buffers before waiting for result collection. Retained output and the terminal
record remain replayable until their normal acknowledgement/retention boundary;
completed commands do not need idle pipe buffers to preserve that guarantee.

Retained frames also share a runner-wide memory ledger: one sixteenth of measured
available RAM, with a 64 MiB floor. Starting a command reserves nothing. Appending
past either its per-command limit or the shared limit spills its retained frames
to the existing disk spool; sequence numbers, replay and acknowledgement remain
unchanged. Acknowledgement, successful spill and log disposal release memory
charges. Lower capacity samples affect future reservations without discarding
existing output. This bounds memory-backed record costs, not total runner RSS:
spool indexes, transport/replay buffers and other subsystems use memory separately.
Disk exhaustion remains an explicit retention failure.

When an exec yields as background work, `session_background_commands` becomes
the durable lifecycle authority before the tool returns. It stores only a
bounded command preview plus the immutable launch locator; no later active
machine pointer is consulted. The sidebar projects `running` or `stopping` from
that table even while the session turn itself is idle. The global maintenance
pass runs this reconciliation independently of managed-sandbox ownership: a
running command receives exact `OpQuery`, a stopping command receives exact
idempotent `OpCancel`, and only a typed terminal exit/loss is checkpointed as
proof before settlement. Offline, timeout, malformed, or still-running results
are deferred. Claim expiry recovers coordination only and never implies process
death; a successor connection is never queried on the predecessor's behalf.
Completed operations may need multiple retained-output batches. Reconciliation
keeps one reader and its integrity checkpoint while captured sequence progress
continues, and settles only after the terminal output frontier is verified.
Terminal replay measures progress by the verified contiguous frame sequence,
including heartbeat frames and undecoded UTF-8 prefixes. A quiet command can
therefore drain successive retained batches without restarting from frame zero
merely because a batch contains no printable stdout or stderr. Failed output
persistence or a stalled frame frontier still prevents settlement.
Stalled or repeated frame frontiers defer recovery; they never license a success result.
Adoption takes the canonical workspace-control and exact turn-attempt fence, so
it has a total order with Steer, Pause, terminal Cancel, and session deletion.
Before that transaction starts, the op-stream yield path takes exact
failure-cancellation authority from the attempt fence. A rejected adoption
therefore cancels only the frozen op, while a committed row remains session-owned
even if the tool promise has not unwound yet. Workspace deletion separately
serializes against both the owning and physical control workspace: active origin
references block deletion, and settled cross-workspace history is pruned only in
the transaction that successfully deletes the source workspace.

The server's out-of-order frame stash is only a disposable replay cache, bounded
in bytes to two negotiated flow windows per operation. Overflow drops that cache
and re-attaches to the runner's authoritative retention log; it never limits or
truncates command output. Completed stdout/stderr are assembled once for the
tool result, and source frame references are then released.

## Swap the active sandbox

A session points at one active sandbox at a time. `swapActiveSandbox` re-points
it — the user-authenticated equivalent of the agent's `sandbox_swap` MCP tool.

A machine-home session does not create a cloud box while its Connected Machine
is selected. When the deployment has a managed backend, the fleet also exposes
the session's synthetic managed group as an explicit fallback target. Choosing
`"session"` or `"default"` verifies that group through the normal lease path and
then clears the active machine pointer. A deployment configured with only
`selfhosted` or `none` has no managed group to select.

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
group. If that turn explicitly swaps back to `"session"`/`"default"`, Opengeni
preserves the successful pointer change,
checkpoints completed model/tool truth, and continues the same logical turn in a
fresh home-primary attempt. The handoff requires no new user message, never
silently runs a post-swap operation on the old machine, and never provisions a
cloud home for machine-only work. Unresolved parallel tool calls are closed as
interrupted/outcome-unknown rather than replayed automatically.

## Connect a machine

Enrollment turns a user's machine into a `selfhosted` sandbox in the workspace.
The machine agent is multi-connection: installing it once and connecting another
workspace—even on a different Opengeni deployment—adds an independent link and
preserves all existing links. There are two enrollment paths. Both require the
caller to hold `enrollments:manage`.

The universal Machines-page one-liner securely installs or updates the runner
installation, including a generated background-service definition when the
release requires it, runs `opengeni-agent connect` for that deployment, and leaves
the ordinary background service online. A same-version connection is additive and
does not restart the process or interrupt existing commands. A real upgrade
restarts once when activation requires it; subsequent connection files load live.

A successor started by a manual installer has no managed-update receipt. Its
authoritative Hello settles the replaced process's unfinished request as
`accepting_process_replaced`, not a successful automatic update. The installed
version remains authoritative for current/ahead status; an old version still
shows the failed attempt and can retry. A reconnect by the same process does not
terminate its own active update, and superseded processes cannot settle it.

The running agent captures its executable install path before admitting managed
updates. Unix apply, rollback/retry, and successor exec use that stable path: a
late executable lookup can name the old deleted inode after atomic replacement.
Windows retains its running-image replacement mechanism. This forward fix does
not repair an older agent already executing its previous update handoff; those
installations may require their service manager to start the verified canonical
executable path after the old process exits.

On macOS, the generated LaunchAgent sets `WorkingDirectory` to the installing
user's home directory. This makes the reported default workspace root writable
for attachment delivery instead of inheriting launchd's `/`. Foreground `run`
continues to use the directory it was launched from, and an explicit session
`workingDir` still takes precedence.
Reinstalling or restarting the LaunchAgent preserves its existing environment
(including PATH and locale), rather than replacing it with the invoking shell's
environment. Fresh installs still inherit the installer's PATH.

On Windows, the background agent is a per-user Task Scheduler task named
**Opengeni Agent**, not a Windows Service. A service runs in session 0, where
the screen, input and the user's browser are out of reach, and registering one
needs an administrator. The task runs as the signed-in user in their own
desktop session, so computer use works, and `start` needs no elevation. It
starts at sign-in, runs the agent inside a hidden console host (no window, and
the commands the agent runs share that hidden console), and a one-minute
repetition starts the agent again if it ever exits. Its working directory is the
user's profile folder. `stop` pauses: it disables the task so nothing restarts
the agent, then asks the running agent to shut down cleanly through a named pipe
private to the user, and ends the agent's process tree only if it does not stop
within 45 seconds. The agent stays paused across sign-ins until `start`.
`status` prints `opengeni-agent background task: running`, `paused`, `stopped`
or `not installed`, read from the agent's own instance lock. The agent does not
run while nobody is signed in to Windows. Earlier releases
registered an `OpengeniAgent` Windows Service that could never start; `start`
deletes it when allowed, and otherwise prints the one elevated command that
removes it.

The agent also never treats a filesystem root or the Windows system directory
as its workspace, so an older service definition needs no manual step: when
`run` starts with `/` (or a Windows drive root, or `%SystemRoot%` such as the
`C:\Windows\System32` a Windows service starts in) as its working directory
and the user's home directory is usable, it moves into that home directory
before connecting and reports it as the workspace root. Any other launch
directory is kept as chosen.

Regenerating an older service definition with `opengeni-agent service install
--restart` is still useful to pick up other plist changes (such as the stderr log).
The installer checks launchd's loaded binary and working directory as well as the
plist on disk. If an earlier install wrote the plist but failed before reloading,
a retry still reloads the stale job without requiring `--restart`. Dry-run
rendering and installation share the `HOME`, then `USERPROFILE`, resolver;
unsupported control characters and XML-invalid home paths are rejected before a
plist is written. Existing sessions retain their saved absolute folder, except
that a filesystem or drive root, or anything inside the Windows directory, is
never used as a working directory: the machine's reported root applies instead.
Migration 0853 also cleared the saved `/` (and saved Windows
`C:\Windows\System32` service launch directories) left by older agents. The existing-session Runs
on menu changes the machine, not the folder. Historical attachments are not
restaged automatically; retrieve them explicitly through Files or attach them
to a new message when needed.

While a machine still reports `/` (an older agent without a usable home), staging an attachment, spilled tool result or generated
image into it usually still fails. When the turn's effective backend is a
Connected Machine and its working directory is `/`, any failed staging command
gets a reason that says the filesystem root is often not writable (read-only on
macOS), that this may be why it failed, and how to fix it, followed by the
underlying error. The model and timeline therefore no longer see only a raw
`mkdir: .opengeni: Read-only file system`. This condition is structural (backend
plus root), never a match on the possibly localized command output, so the
wording stays conditional. The original command output and exit code are kept,
and managed sandboxes keep their raw reason. Opengeni never redirects those
files to another host folder, so the cwd-relative `.opengeni/...` paths keep
their meaning (`packages/runtime/src/index.ts`,
`explainConnectedMachineRootDownloadFailure`).

`opengeni-agent run` is the explicit foreground alternative.

Self-update requires settled accepted work across every connection. Relay pumps,
PTY child/IO cleanup, blocking native actions, attached-browser commands and
their original reply transport retain the opening reservation after a waiter or
connection generation ends. A timeout or disconnected profile does not prove a
physical command stopped, and the updater never fabricates a consumer ACK.
Each counted reply carries its transport receipt in the same publication
command. Success requires empty internal buffers and a flush of that stream;
losing the stream fails its attached receipt before reconnect. A replacement
socket cannot prove that the previous reply was sent.
Controller admission is fenced atomically during its idle proof; failed or
deferred updates release only their own fence. Missing physical settlement makes
updates unavailable while ordinary work remains usable. Failures are retained per
producer, never cleared globally or merely by dropping a reservation. Native exec
and PTY cleanup keep owned handles and retry failed exit observations; a positive
exit clears only that cleanup's failure. Cleanup cannot inherit a running job's
handover exemption. Successor startup and rollback restore each adopted command's
reservation as well as its native handles. After handing over running jobs, the updater rechecks cleanup
before recording its restart manifest, including failures during the download.
A panicking worker releases its own reservation only after
unwinding; independently owned native resources still retain theirs. Lost reply
delivery is logged, not mistaken for still-running native work. Retained RPC
replies hold their reservation through delivery or expiry; expiry still rejects
the original request and does not permit replay or release a live producer. Older
controller builds without the update-admission transaction cannot authorize
replacement from an unfenced idle snapshot. A lost fence-release reply retains
its exact operation owner; ordinary scoped recovery retries only that release
after host update admission has reopened. Failed helper/factory cleanup and
forced or nonzero helper termination remain unsettled even after the original
owner leaves active inventory. Helper EOF joins persistent capture producers;
missing ScreenCaptureKit stop completion cannot become a successful shutdown.
Windows cleanup retains the same Job Object until its active process count is
zero; signaling it alone is not completion. Unexpected
controller exit and forced controller termination likewise preserve uncertainty
after the old controller is removed from the active inventory. They cannot be
made update-eligible by reconnecting or replacing the controller.

Enrollment approval lasts until it is revoked; it is not a monthly login.
The command and relay transport credentials last 30 days. The agent renews them
with seven days remaining, using its existing install key and current enrollment
generation. A machine returning after a longer offline period uses the same
renewal path. Revocation, removal and a superseding re-enrollment deny renewal;
renewal itself cannot change ownership, scope or screen-control consent. Who can
use a machine changes in place through **Who can use it?** (see
[Change who can use a machine](#change-who-can-use-a-machine)), and screen
control through its own request below; neither needs a reconnect. Updated
credentials load into the existing process, preserving host operations.
The signed `/v1/enrollments/renew` machine protocol is outside the browser API
contract-revision fence, like device polling and token exchange. Its install-key,
enrollment-generation and revocation checks still apply in production.

A NATS authentication refusal suspends dialing for that exact saved connection;
it is not treated as an ordinary network outage. The existing renewal loop checks
it even when its bearer is not near expiration. A successful renewal clears the
suspension and the live file reconciler resumes that link. An explicit
`enrollment_reconnect_required` renewal response persists a terminal state across
agent restarts: no more NATS or renewal requests until an authorized reconnect
replaces the connection. `opengeni-agent connections` shows pending renewal versus
reconnect-required state and the deployment-specific recovery command. Removing
an obsolete saved connection is also supported. Other workspace links and retained
host operations remain independent.

Clock skew, transport failure, disabled renewal and older APIs' generic 401/404
responses are not terminal proof. They allow another transport attempt on the
existing jittered renewal cadence, so an older API or a temporary callout outage
cannot strand a still-valid connection. Deploy the typed renewal response before the
agent update to stop retries for permanently rejected grants completely. An older
agent does not gain this behavior from a server deployment alone.

Machines shows expired credentials only when the server can verify the bearer
signature and match its current enrollment generation, and never over a live
runner. Fresh Hello/heartbeat clears the diagnostic. Invalid signatures and
removed enrollments cannot safely identify a dashboard row; inspect the local
connection inventory instead. Saved links to other deployments/workspaces are
never disclosed through a healthy workspace's machine status.

Deploy the API renewal endpoint before upgrading agents. An older API returns
404 and the agent retries with jitter while retaining its existing credentials.
Older agents still need a one-time authorized reconnect after expiration; a
restart alone cannot refresh credentials. Legacy connection files whose API
origin has never been confirmed also require an explicit reconnect rather than
sending their credentials to a guessed deployment.

Mac app installations update the complete signed application, including bundled
browser/computer helpers. The updater selects the signed manifest's
`universal-apple-darwin-app` ZIP, verifies its signature and checksum, stages it
beside the installed application, and checks the sealed resources, bundle ID,
signing-team continuity and executable version before an atomic directory
exchange. A failed post-exchange verification or managed-receipt write exchanges
the entire old app back. The successor receipt contains the installed executable
digest, not the ZIP digest. Interrupted transactions retain their recovery copy.
Standalone Mac executables retain the binary update path.
The updater resolves macOS executable symlinks before selecting the artifact,
so invoking an app through `~/.local/bin/opengeni-agent` still updates the whole
app and leaves that symlink intact. Standalone release binaries are signed with
the stable identifier `ai.opengeni.agent`, matching the app. Previously released
standalone binaries used build-dependent identifiers: their grants may need a
one-time reapproval after migration to the stable identity. Updating the old
updater itself still uses its old behavior; use the official whole-app installer
for that first upgrade when launching through an app symlink. No updater can
restore grants that macOS already revoked or that a user explicitly removed.

Mac agents older than 0.1.29 require a one-time upgrade through the official
whole-app installer. Their old updater would replace a single sealed executable;
the Machines UI explains this limitation and the API refuses to dispatch that
unsafe update. Do not run an older app's `update` command as a bootstrap shortcut.

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

### Connect from a chat

Agents connect machines the way they request integrations. When the agent can
already run commands on the target machine, it installs the agent itself with
`connected_machine_enroll_token` (below). When the person has to connect their
own computer, the agent posts the **Connected Machine card**: either
`capability_catalog_search` (for example "my Mac" or "Chrome") followed by
`capability_authorization_request` with `api:connected-machine`, or
`sandbox_provision` with `kind: "selfhosted"`. Both append the ordinary
`tool.auth_needed` event with that capability id; the event carries no token.

The card also appears without an agent decision. When `sandbox_swap`,
`sandbox_attach` or `run_on` is refused with
`personal_machine_permission_required` (the machine's owner started the turn
but has not allowed this chat yet), the API posts the same card in the calling
turn (`apps/api/src/mcp/machine-permission-card.ts`). The refusal the agent
reads then says the card is posted in this chat in Opengeni, carries the chat
link (`chatUrl`), and tells the agent to tell the person in one sentence: that
they can allow it in the chat, or, when they read the chat elsewhere (Slack, a
worker or a scheduled chat), to open the link. It must not wait or retry:
choosing the machine sends the message that continues the chat. A repeated
refusal in the same turn reuses that turn's machine card, since one card lists
every machine; the lookup and append run atomically under the turn-attempt
fence (`appendTurnCapabilityCardOnce`), so parallel refusals cannot stack
copies. Cards for other capabilities, such as Slack and GitHub in the same
turn, are never limited. `personal_machine_not_permitted` (not
the owner, or not the owner's turn) and every other failure stay plain
refusals, and callers without an exact agent attempt get no card. If the card
cannot be posted, the original refusal is returned unchanged.

The card (`apps/web/src/components/capabilities/session-machine-card.tsx`):

- lists the workspace's enrolled machines with **Use in this chat**, which swaps
  the session onto that machine and sends `Use the machine “<name>” for this
  chat.` (the name quoted, on one line, at most 60 characters) so the agent
  continues there. A chat that cannot take a Send is not moved; a chat waiting
  on a question is moved and keeps the question;
- inside the desktop app, **Use this computer** calls the existing desktop host
  connection directly, with personal ownership and screen-control consent. There
  is no second setup confirmation; required operating-system permission prompts
  still use the shared permission guide. Connecting does not move an existing
  chat's compute route: **Use in this chat** remains a separate optional action;
- in a browser, opens the shared **Use your computer** dialog
  (`apps/web/src/components/machines/connect-machine-dialog.tsx`, also used by
  the Machines page). It offers the current platform's desktop app download and
  **Open app and connect**. After installation the person returns to that link;
  the app selects the exact account or starts its existing PKCE sign-in, checks
  workspace access and confirms locally before connecting. The link carries only
  the origin, workspace/chat destination and subject, never an enrollment token.
  Mobile browsers direct the person to the computer they want to connect;
- **Connect a server instead** explicitly reveals the advanced terminal flow.
  Only then is a token minted. The person chooses **Who can use it?** (**Only me** by
  default, or **This workspace**) and screen control (off by default); both are
  baked into a single-use token minted in their browser for exactly that choice.
  Mac, Linux and Windows tabs (the detected OS selected) show the matching
  command. A slower response for an earlier choice never replaces the current
  one, and the dialog checks the server's echo of the scope it granted, so a
  server that cannot mint a personal token says so instead of silently sharing
  the machine. Pairing with a code is a secondary disclosure. While the dialog
  is open the list polls every three seconds; when a new machine, or a known one
  that was offline, comes online the same dialog shows its name, **Connected**
  and **Only me** or **Workspace**, with **Done** and, in a chat, **Use in this
  chat** (the same attach path as the list). Closing the dialog stops the watch;
- once a machine with a screen is reachable (the chat's own machine first),
  offers the
  [Opengeni Browser extension](https://chromewebstore.google.com/detail/opengeni-browser/phpmmcbeelfkcinjfbbggegjdcdmnnch)
  for that machine and shows **Connected** when a Chrome profile on that same
  enrollment links up. It checks once, polls only after **Add to Chrome**, and
  stops after ten minutes or when the inventory is not readable.

Reading the list needs `enrollments:read`; connecting needs `enrollments:manage`;
moving the chat needs `sessions:control`. The card says who can act otherwise.
Like GitHub, the card is posted even when machines are already connected.

Embedded products supply `SessionConversation.computerConnection` (also through
`OpenGeniChat.conversationProps`) with their own desktop host, downloads and
account-bound handoff, or a product-owned connect callback. The shared
`ThisComputerCard` never chooses an Opengeni download or terminal command for a
host. Without host configuration the default card explains that setup is not
enabled there. See [embedding](embedding.md#computer-connection-offers).

### Turn on screen control for a connected machine

Screen-control consent lives on the enrollment row and in the credentials the
machine holds (its own dispatch gate checks them). Turning it on never needs a
reconnect, a token or a human click:
`POST /v1/workspaces/:ws/machines/:enrollmentId/screen-control`
(`enrollments:manage`; `account:admin` for organization machines; no body)
sets `allow_screen_control` on the enrollment in place, with the same id,
scope, owner and credential generation, so the machine's current credentials
stay valid. The API then sends the live agent a `credential_renew` control
request. The agent renews its credentials through the same install-key-signed
`POST /v1/enrollments/renew` it runs on its own schedule. Renewal re-reads the
consent from the row, and the agent saves the result over the same connection
file. The live reconciler adopts it without restarting the process, and the
next Hello reports `consented_screen_control`.

The response is `status: "active"` once the agent holds the new credentials.
Otherwise it is `status: "pending"` with a `reason`:

- `offline`: the machine applies it when it next says Hello.
- `agent_update_required`: the agent predates the `credential_renew`
  capability. Update it, and the successor's Hello applies it.
- `renewal_failed`: retry the request.
- `reconnect_required`: the machine's connection predates in-place renewal
  (for example a legacy-origin connection file). Run the connect command on it
  again with screen control on. The chat card's **Connect again** opens the
  connect dialog with screen control on and the machine's current access
  chosen (**Only me** for a personal machine, otherwise **This workspace**), so
  following the defaults reconnects the same machine without changing who can
  use it. A personal machine reconnects only from the workspace it was first
  connected from: elsewhere the command (or a code approved for **Only me**)
  answers `409` and changes nothing. The command cannot carry organization
  access, so an organization machine reconnected this way connects as a
  workspace machine; pair it with a code instead to keep organization access.

The Hello-time path is the same request: when a Hello shows the row allows
screen control but the credentials do not, the API asks that exact process to
renew. Repeating the request is safe. Once the agent's Hello reports the consent
the API answers `active` without contacting it. The agent serves renewals one at
a time and reports consent already on disk without renewing, so several API
replicas reacting to one Hello cause a single renewal. Each change records a
`connected_machine.screen_control.allowed` audit event with the acting subject
(and the session and attempt for an agent).

Agents use the same action through `connected_machine_enable_screen_control`
(`target` is a `sandboxes_list` id). Personal machines also pass the same
per-attempt admission `run_on` uses. When computer input is refused because
screen control is off, the error names that tool.

macOS also needs Screen Recording, Accessibility and Input Monitoring for
Opengeni. Mac agents report all three without prompting, on Hello and on each
desktop heartbeat, as `runtime.macPermissions` in the machine list; older agents
report only a missing Screen Recording grant, as `desktopUnavailableReason`.
`POST /v1/workspaces/:ws/machines/:enrollmentId/privacy-settings` with
`pane: screen_recording | accessibility | input_monitoring` opens that System
Settings pane on the Mac (bounded to 15 seconds). Opening a pane grants
nothing; the person switches Opengeni on there. The chat card walks the missing
permissions in that order, from what the Mac reports.

### Change who can use a machine

A connected machine switches between **This workspace** and **Only me** in
place. The machine keeps its enrollment id, sandbox id, credentials and live
connection, so its chats, schedules and the installed agent are not registered
again, and the agent keeps running (with its running commands) without a
restart or an upgrade. On the Machines page, open the machine and choose
**Who can use it?**. Organization machines are shared with the whole
organization and cannot be changed here.

- Narrowing to **Only me** is done by the person who will own the machine, or by
  a workspace admin who picks that owner. The owner must be an active member who
  can use the workspace.
- Widening to **This workspace** needs `workspace:admin`, and is done by the
  machine's owner, so nobody exposes another person's Only me machine.
- Both need `enrollments:manage`. An agent cannot change it.

The dialog shows what one confirmation will do, as counts in plain sentences
with the itemized chats and schedules behind **Chats and schedules affected**.
Nothing has to be resolved by hand first. Narrowing to **Only me** does this:

- **The owner's chats** stay on the machine and keep their audience. A shared
  chat stays shared, so the workspace keeps reading it, but only the owner's
  turns can use the machine (who reads a chat and who uses a machine are
  separate, as when choosing a personal machine for a shared chat). Each kept
  chat gets a per-chat `connected_machine.use` grant, and the owner's running
  attempts are re-authorized in place, so their running turns and commands
  carry on.
- **Other people's chats** move off the machine. Their history stays, their
  files stay on the machine, and their next turn needs another machine. Another
  member's private chat is listed without its title or owner.
- **Running turns** that may no longer use the machine stop now and end as
  cancelled (`authority_changed`): turns in chats that move off, and turns
  someone other than the owner started in the owner's shared chats. The agent's
  commands still running in chats that move off are stopped too.
- **Schedules** that target the machine: the owner's Workspace schedules become
  Only me schedules when the owner may have Only me schedules, and pause
  otherwise. Everyone else's pause. The owner's Only me schedules keep running.
- **Notices**: each affected person other than the one switching gets one
  inbox notification saying what moved, paused or stopped, and that they can
  choose another machine to continue.
- **A duplicate connection**: if the same computer is also connected separately
  under the target audience, remove that copy first; this is the only thing
  that blocks the switch. A removed copy is retired by the switch.

Undo is switching back to **This workspace**. Moved chats and paused schedules
are not restored automatically, and the notices say so; people choose another
machine or resume their schedules. Widening keeps the owner's chats and
schedules in this workspace where they are; chats and schedules in other
workspaces move off or pause, since a workspace machine serves only its own
workspace. The round trip Workspace → Only me → Workspace keeps the same
machine throughout.

The switch is one transaction. It recomputes the plan under the machine's row
lock and the session fences of every workspace it touches, applies it,
advances the machine's generation, moves the owner authority and
re-authorizes the owner's live attachments. The worker reads the machine's
current audience on every operation, so live sessions follow the new audience
without being rebuilt and the agent needs no restart or upgrade. Each change
records a `connected_machine.audience_changed` audit event with the counts.

The API is the same flow:

- `POST /v1/workspaces/:ws/machines/:enrollmentId/audience/preview` with
  `{ audience: "only_me" | "workspace", ownerSubjectId? }` returns the plan:
  `summary` counts, `items` (each with its `action`: `move_off`, `keep`,
  `make_only_me`, `pause` or `remove_first`), whether it is `ready`, and the
  machine's `generation`.
- `PUT /v1/workspaces/:ws/machines/:enrollmentId/audience` with the same body
  plus `expectedGeneration` applies it and returns the counts and the chats it
  moved off. It answers `409` with `details.reason: "stale"` when the machine
  changed since the preview (preview again and retry), and
  `details.reason: "blocked"` with the preview while a duplicate connection
  remains.

A person makes this change, in the app, through the API, or through an agent
they gave their full access: a session with admin access or a connected agent
with full access calls the same two routes as them (the `previewMachineAudience`
and `changeMachineAudience` admin actions). An agent acting as itself, or one
with less than the person's full access, is refused.

### Zero-click token (fleet / headless)

Agents with the existing `enrollments:manage` permission can call the first-party
`connected_machine_enroll_token` MCP tool when it is selected for their session.
It returns the same one-hour token and deployment-specific Unix/PowerShell install
commands. `allowScreenControl` defaults to false. No additional approval flow is
introduced. The workspace/account come from the caller's grant, not tool input.
The tool always mints workspace-shared tokens.
Run the command on the intended machine through an already-authorized execution
path, then verify readiness with `sandboxes_list`. A token cannot execute the
installer on a machine for which no access path exists.

The token is returned to the agent in the tool result; never publish it in source
code, chat, or unrelated logs. Missing `enrollments:manage`, an explicit tool
selection that excludes it, or disabled Connected Machines means the tool is
unavailable. This addition does not grant the permission to existing sessions.

Enroll tokens are **single-use**. Each token carries a random `jti`; the exchange
records it in `enrollment_token_redemptions` (0696) in the same transaction that
creates the enrollment, so one token connects one machine. The same machine
(same public key) may repeat the exchange after a lost response or a re-run
install command, while its enrollment is still active. Any other machine, or a
machine removed since, receives `401` with "this connect command was already
used to connect another machine". Mint one token per machine for a
fleet. Tokens minted before 0696 carry no `jti` and stay multi-use until they
expire an hour later. Expired redemptions are pruned per workspace during later
exchanges.

`scope` chooses who can use the machine: `"workspace"` (the default, shared with
the workspace) or `"user"` (only the person who minted the token). A personal
token can be minted only for a verified person: a signed-in human session, or a
credential acting as that person (a personal API key, or an organization key or
organization MCP client acting as them), the same canonical-actor rule as
personal connections. A key acting as itself, a service, an agent attempt or a
service-initiated grant gets `422`. The owner is always the caller's
authenticated subject, never a request field, and a personal token always
carries a `jti`, so it is single-use.
It is signed with a distinct `typ` (`enroll_user`) carrying that owner, so an
API replica that predates personal tokens rejects it instead of creating a
shared machine during a rolling deploy. The exchange re-checks, under the
organization membership fence, that the owner is still an active member with
access to the workspace; otherwise it answers `403` and claims nothing. Fence
contention answers `503`; run the command again. A personal machine stays in the
workspace it was first connected from, and its credentials belong to that
workspace: running a personal command for the same machine (same install key)
from another workspace answers `409`, writes nothing and leaves the command
unused, and the machine keeps its existing connection. Reconnect it from that
workspace. The response echoes `scope` and `allowScreenControl`; clients should
compare them with what they asked for, since an older server omits `scope` and
always mints a workspace token.

Mint a short-TTL enroll token and hand it to the machine's installer. The token
is **secret**: anyone holding it can connect one machine until it expires.

```ts
const { token, expiresAt, expiresInSeconds } = await client.mintEnrollToken(
  workspaceId,
  {
    scope: "user", // only me; "workspace" (the default) shares it
    allowScreenControl: false, // bake screen-control consent into the token
  },
);
// Run on the machine (the installer dials Opengeni and exchanges the token for
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
available only to account administrators. Machines and Sandbox Environments display the
resulting scope in their list cards so wider publication is never implicit.

### Agent logs

The running agent (`opengeni-agent run`, or a bare launch of an enrolled
machine) keeps its own log in `logs/agent.log` under its config directory
(`~/.config/opengeni/agent` unless `$OPENGENI_CONFIG_DIR` or
`$XDG_CONFIG_HOME` says otherwise), whatever service manager runs it. The file
rotates at 8 MiB and keeps two older generations (`agent.log.1`,
`agent.log.2`); the directory and files are owner-only. It records browser
controller diagnostics and exit statuses, and a panic on any thread with its
backtrace, so a crashed agent can be diagnosed afterwards. One-shot CLI
commands log only to the terminal.

On Linux the same lines also reach the systemd journal
(`journalctl --user -u opengeni-agent`). The macOS LaunchAgent sends the
process's raw stdout and stderr to `logs/agent.stderr.log` and sets
`OPENGENI_AGENT_STDERR_LOG=off`, so that file keeps only output that bypasses
the agent log, such as an abort message; the agent bounds it at startup. A Mac
picks up that LaunchAgent change the next time `opengeni-agent service install`
runs; the agent log itself needs only the new agent.

## Transactional file edits

Native ranged file reads retain only the selected bytes, rather than allocating
the entire file before slicing it. They still consume the full stream to report
the actual `total_size`, including virtual files whose stat size is zero; this
reduces memory use without promising less disk I/O. A zero length continues to
mean the remainder of the file, and an offset beyond EOF returns empty content.

The editor uses transactional transfers for text creation and in-place updates,
including small files, when the exact live agent advertises
`transactional_fs_write`. Small in-place updates must not bypass staging: a
direct write can be interrupted after truncating the destination. This is separate from `op_stream`;
older agents retain their existing single-message write behavior. An outbound
message-size rejection is reported as a request-size fault, not an offline
machine, and does not prove that earlier operations failed.

Transfers stage bounded chunks privately, verify the intended BLAKE3 digest and
byte count, and publish only after the expected destination state is checked.
Large Files-panel writes use provider byte transport instead of shell arguments.
On capable Linux and macOS agents, raw replacements above 256 KiB use these same transfers,
including binary files; an ambiguous write is never retried through a fallback.
Every transfer request is reauthorized against the same physical connection.
The runner pins each operation to its original session route epoch;
different sessions may have different epochs on the same machine. This is not
the legacy machine hello epoch, which normal enrollment leaves unset. The
connection-local registry rejects another epoch adopting an operation, and
connection shutdown is checked again at publication.
Machine-addressed operations such as `run_on` use epoch 0 and additionally
require the live `transactional_fs_write_machine` capability. Zero is pinned
exactly, never a wildcard or a fabricated session epoch. Older agents with only
`transactional_fs_write` still support session-scoped transfers, but new servers
refuse their machine-addressed replacements above 262144 bytes (256 KiB) before
any file operation, with an instruction to update the agent. Small writes keep
working. Deploy the updated server and release/update the native agent for
large machine-addressed writes; either rollout order is safe. No mutation is
retried through the legacy path after a transfer has begun.
An ambiguous acknowledgment triggers one read-only query of the exact operation,
never a replay of the edit. A lost operation after agent restart remains unknown;
inspect the destination before submitting another edit.
If that query confirms the abandoned transfer is still running, the caller
cancels only that exact operation through the same authorization checks. A commit
racing cancellation retains its verified receipt. Lost cancellation responses or
lost authority do not prove cleanup: private staging may remain until the link
ends, and a process crash may leave an orphan. There is no automatic sweep or
adoption of unknown transfers.

The native implementation supports ordinary Linux and macOS APFS regular files.
Expected-absent creates honor `create_parents`: missing directories are created
through pinned handles and remain after cancellation or failure; file publication
is still atomic. Existing-base edits never create missing parents. It fails closed on unsupported symlinks, hard links,
ownership, special modes, and extended metadata rather than silently discarding
their semantics. Transactional editing does not implement `runAs` impersonation.
macOS leaves parent-directory ACLs and attributes untouched, including the standard
home-directory ACL. The replacement inode keeps OS-assigned provenance; the old
inode's provenance is not copied or required to match. Destination/staged-file
ACLs, other file attributes and inode flags remain unsupported rather than being
silently removed.
Expected-base checks detect observed changes but are not a filesystem
compare-and-swap against unrelated concurrent writers.

An edit with `moveTo` replaces the destination and then verifies and removes the
source on the same authorized connection. This is **not an atomic move**. If
source cleanup cannot be verified, the tool reports that the destination was
verified but cleanup remains uncertain; it does not replay the move. Inspect
both paths before retrying.
The source check and subsequent deletion are not conditional deletion; unrelated
writers can still change the source between those steps. This is not a
metadata-preserving filesystem rename.
Small moves retain the legacy direct-write path so they do not acquire a new
read requirement on a write-only destination. They do not have transactional
publication guarantees. Legacy agents without transactional support also retain
their existing direct-write behavior; inspect the destination after any timeout.

The Files and terminal API report an oversized native request as HTTP 413
(`limit_exceeded`), without marking the machine offline. An oversized reply is
HTTP 502 with the same code: the operation may already have completed, so inspect
its result before repeating it. Both errors are non-retryable and include
`details.code: machine_transport_payload_too_large` plus a bounded `direction`
(`request` or `response`), without native paths or diagnostic contents. This
reporting does not add transactional transfer support to unsupported platforms.

Deploy matching protocol/runtime packages and a compatible native agent before
expecting transactional support. Changing transport limits is not required.

## Run as another local user

Exec (including op-stream and background commands), git, PTY open and every file
request, transactional uploads included, carry an optional `run_as`: a local user
name, else a decimal uid, which must exist in the machine's password database.
The agent honors it only when it advertises `Capabilities.run_as`, which it does
only on Linux while running as root (as in a managed sandbox); a Connected
Machine agent running as its owner's account never does, and the control plane
must not send `run_as` to an agent that does not advertise it. Such an agent
refuses a non-empty `run_as` with `ERROR_CODE_UNSUPPORTED` rather than ignoring it,
and an unknown user fails with `ERROR_CODE_RUN_AS_UNKNOWN_USER`.

A process started for the request runs with the user's uid, primary gid and
groups (real, effective and saved ids, no capabilities), with `HOME`, `USER`,
`LOGNAME` and `SHELL` from the password database before the request's own
environment. A PTY without a command starts the user's login shell, and the user
owns the terminal device. File requests run on a dedicated agent thread switched
to the user, so the kernel enforces the user's permissions and everything the
request creates is the user's; `~` expands to the user's home. Transactional
uploads stage as the user, so the published file is the user's. Because that
user can also reach its own staged file, a replacement re-checks the published
inode and its content right after the atomic exchange: on any difference the
agent exchanges the previous file back and reports `WRITE_CONFLICT`, or reports
`WRITE_OUTCOME_UNKNOWN` when it cannot confirm that restore. Exec and git
children switch identity after their cgroup placement, which still uses the
agent's privileges.

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

### Interaction runtime reliability

Connected Machine BrowserSessions can explicitly request `engine: "lightpanda"`
for headless semantic work. Chromium remains the default. This requires the
pinned Lightpanda executable configured on the native agent through
`OPENGENI_BROWSERD_LIGHTPANDA_BINARY`; browserd verifies the platform-specific
digest in `packages/browserd/src/lightpanda-binary.ts` before use. Standard native
agent releases do not currently embed this optional executable. A missing or
incompatible executable fails the request; it never falls back to Chromium.
Provision it only on supported Linux or macOS platforms, preserving the source
and license obligations of the upstream release.

This engine does not provide rendered screenshots, live viewing, desktop input,
Chromium profile identities, or a linked ComputerSession. Use Chromium for
visual/mobile testing and human interaction. Browser authority, per-session
isolation, and source-placement fences remain identical for both engines.

The agent runs one browser controller (browserd) per scope: workspace,
placement kind and placement (the machine, or an attached Chrome device). A
controller that reports holding no session at all (no open, retained or
recovering browser or computer session and no work in flight), and whose scope
has not been ensured for ten minutes, is stopped; the next request starts a
fresh one in about a second. Each controller also holds the write end of a
stdin lifeline from its agent: however the agent ends, including a crash or
SIGKILL, the kernel closes it and the controller shuts down gracefully,
leaving retained browsers running for the next agent to adopt. Controllers no
longer accumulate across scopes or outlive the agent that started them.

Managed BrowserSessions own browser lifetime across tool calls. A browser daemon
launched by a shell command remains subject to that command's containment and
cleanup; repeating its CLI session name does not retain its process. Explicit
Connected Machine interaction creation must match the source session's current
placement. Move the session first; a creation mismatch is a 422, while an existing
resource on a retired placement retains the terminal stale-resource fence.

Managed Chrome on Linux drains browser stderr through a private launch
wrapper. The last 64 KiB are retained in the session's owner-only
`chrome-launch/chrome-stderr.log`; launcher and pipe files are removed on browser
shutdown. This prevents a full Chrome stderr pipe from blocking CDP while keeping
startup diagnostics bounded. The wrapper resolves its `mkfifo` and `tail`
utilities from the agent's `PATH`, with standard `/usr/bin` and `/bin` fallbacks,
so Linux distributions with nonstandard installation paths are supported.
Attached browsers are unaffected.

Linux managed-browser cleanup matches an exact private profile and executable
before signaling a process. Rewritten Chromium titles additionally require the
profile's same-host PID lock; ambiguous titles are refused. Procfs start times
fence discovery and fresh signal checks against PID reuse.

During initial window layout, an observation may have `viewport: null` while
semantic content remains available. Subsequent observations report the measured
geometry when valid; the controller does not substitute guessed dimensions.

Attached Chrome is an explicit user-profile choice, never an automatic fallback
for an unavailable managed browser. Agents use `interaction.discover` with
`scope: "attached_browsers"` to find personal Chrome profiles without loading
unrelated workspace sessions or saved identities. This scope returns only
`attachedBrowsers` and `attachedBrowserBridges`; other inventory arrays are empty
by scope, and revision fields retain the shared workspace interaction revision.
Use `scope: "workspace"` when the wider inventory is actually needed.
A new attached BrowserSession creates a new
background tab rather than navigating an existing personal tab. Startup waits
for that exact target to appear in the bridge inventory; a missing target fails
without borrowing another tab, including an existing blank tab. Attached startup
uses an empty, network-free data document because the installed extension excludes
`about:` pages from discovery and debugger control; browser-owned page restrictions
remain enforced. Reuse honors
explicit placement, identity, revision, network route and linked desktop choices.
Debugger continuation pages are drained without treating a full page as lost
history; actual sequence gaps still terminate the connection.

An attached tab's debugger disconnect invalidates its cached target, document,
frame and element authority without restarting Chrome or changing other tabs.
A later read can reattach the same surviving tab with fresh fences. Chrome's
`canceled_by_user` disconnect requires reconnecting the profile; it is never
silently overridden. Detachment during pending input or other possible effects preserves an unknown
outcome and blocks automatic reattachment until the profile reconnects. A late
reply cannot revive the old attachment, and no input or navigation is replayed.
Acknowledged partial input followed by a disconnect also remains outcome unknown.
Queued navigation, DOM changes, emulation and unclassified commands cannot run
under a replacement debugger attachment.
Read-only disconnect failures use typed unavailable responses instead of a
generic internal error.

Native computer protocol version 3 separates `capture_still` (including JPEG and
size options) from reading an explicitly started live stream. macOS helpers use
private, byte-identical executable copies for each process: concurrent
ScreenCaptureKit clients sharing one executable path can otherwise route capture
to the first process and leave another waiting. Copies retain their signatures
and responsible-app permission checks, and are removed after process exit.

Unexpected controller errors are retained in two owner-only, size-bounded
`controller-errors.jsonl` files in the private controller state directory, as
well as stderr. The agent forwards bounded controller stderr diagnostics;
startup mismatch errors report both expected and received runtime build IDs.
