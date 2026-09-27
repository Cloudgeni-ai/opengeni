# `@opengeni/browserd`

Placement-resident browser controller. It hides the pinned native driver, owns
target generations and operation receipts, and exposes only OpenGeni interaction
contracts. Raw driver sockets and CDP endpoints are not product APIs.

The pinned `agent-browser` binary owns Chromium/profile lifecycle only. Browserd
connects to its placement-local endpoint without an Origin header, attaches each
page target independently, and owns semantic observation, action dispatch,
screenshots, and live frames. Mutations serialize per target; different targets
remain concurrent. Live-frame subscribers share one target screencast, receive a
latest-frame-wins stream, and every upstream frame is acknowledged immediately.

One `BrowserSupervisor` hosts many independently fenced `BrowserSession`s on a
placement. Each session has its own browser/profile/socket directories, driver,
target queues, and SQLite WAL operation journal. A prepared receipt is durable
before dispatch; restart settles a prepared operation as failed and a dispatched
operation as `outcome_unknown`, without replaying either command. Session state is
retained for restore unless its lifecycle owner explicitly ends and removes it.
Recovery scans receipts with bounded keyset reads inside one atomic transaction,
avoiding simultaneous raw-row and duplicate observation collections. Corruption
in a later receipt rolls back earlier recovery changes.

Each Browser/Computer journal authority retains at most 10,000 operations and
256 MiB of serialized receipts (64 MiB per receipt). Inserts and settlements
evict the oldest terminal receipts until both limits fit; in-flight records
are never evicted. If they prevent a write, the transaction fails without
partial eviction. These are receipt-retention limits, not changes to model
history. SQLite files may retain previously allocated free pages, so lowering
a limit does not immediately shrink an existing file. End/remove reclaims the
session directory. The SQLite receipt format remains compatible.

Settled interaction receipts use the same authority-scoped SQLite journal for
on-demand replay. Controllers retain a content digest rather than a second full
receipt in memory after successful terminal persistence. Replay validates the
full stored receipt; a missing/corrupt record cannot trigger repeated input.
Failed persistence preserves the existing controller-lifetime RAM fallback.

When an ephemeral Chromium pool terminates, its lost sessions settle pending
receipts and retire their runtime and journal handles. New admission joins that
cleanup before checking capacity. Healthy peers remain active. Retired sessions
are no longer queryable as active resources; their receipt files and issued
generation markers remain on disk, and the same session identity cannot silently
launch a replacement browser. Failed cleanup remains visible and must succeed
before its capacity is reclaimed.

During profile restoration, saved `blob:` previews and `chrome-error:` documents
become inert explanatory tabs: their old process-local contents cannot be reopened.
They retain separate tabs and selection instead of failing the entire restore.
Ordinary URLs and durable profile data restore normally; the immutable source
checkpoint is unchanged. This does not turn other navigation failures into success.

A batch is not a transaction. If an action completes and a later action has a
definite failure, its receipt remains `outcome_unknown` and reports the completed
action count and later error code; this is not evidence of controller loss.
Re-observe the target before continuing, and do not replay the batch. A definite
failure on the first action still returns `failed` with its original error code.

For custom listboxes, `press` with a locator explicitly focuses that element
before sending the key. After opening a menu, omit the locator to navigate its
existing focus within the same fenced target, inspect the intended focused
option, then confirm. Re-targeting the trigger can reset focus or fail when the
open menu hides that trigger from the accessibility tree. The `select` action
requires a native HTML select; an ARIA combobox role alone is not sufficient.

The optional Lightpanda 0.3.5 engine supports `fill` and `type` only in editable
text inputs and textareas. Browserd rejects typing into rich-text editors,
read-only fields and other unsupported focused targets before sending text:
Lightpanda otherwise acknowledges `Input.insertText` without editing them.
Choose Chromium for contenteditable workflows; browserd never replaces page
text or synthesizes an input event to disguise unsupported native editing.
Back/Forward history is also refused for Lightpanda: its pinned implementation
mixes iframe URLs into main-page history. Navigate to an explicit URL or use
Chromium for history-dependent workflows. Refusal leaves the current page intact.

Live-view grants advertise `focusedInputObservations` only when the driver
supports the optional `observationMode: "input"`. A left pointer click then uses
a bounded isolated-world focus probe: ordinary clicks return no observation,
while a native select or child-frame focus hint requests the existing redacted
semantic snapshot. Only a snapshot identifying a focused native select is
returned. Optional metadata failure never changes a completed click into a
failed mutation; clients retain explicit observation as a fallback. Agent
actions keep the default full observation behavior.

The compiled `opengeni-browserd` placement service exposes the supervisor through
one versioned HTTP/WebSocket protocol on port 7682. An owner-only file supplies
the placement admin credential; each session receives independently rotatable
control and view credentials. View authority can list/observe/debug targets,
fetch bounded screenshots, and consume a latest-frame-wins binary stream. Control
authority additionally opens/selects/closes targets and submits the same fenced
`BrowserActionCommand` used in-process. Admin authority alone creates, rotates,
lists, and ends sessions. Browser origins are deny-by-default and explicitly
allowlisted; non-browser placement clients omit `Origin`.

Both canonical sandbox images compile the service from this package, copy the
exact `agent-browser` 0.33.2 native binary for the target architecture, verify its
hard-coded SHA-256 digest, and install an exact Chromium/Chrome package version.
The runtime starts the service idempotently under a placement lock, authenticates
readiness using the file-only admin credential, refuses a foreign listener, and
stops only the exact recorded executable/PID.

Sandbox startup places the service below `opengeni-command-supervisor service`.
Provider exec processes may bypass the image's entrypoint init; the local
subreaper collects detached browser descendants after crashes and normal close.
When browserd exits, including SIGKILL, it terminates and reaps remaining
descendants before exiting itself. Killing the supervisor itself is outside
this guarantee and requires sandbox teardown.
The PID file continues to identify browserd itself, preserving authenticated
readiness and exact-process shutdown checks.

`bun run --cwd packages/browserd test:e2e` includes the opt-in context pool's
real Chromium acceptance tests. They fill all six slots, verify same-origin
cookie/localStorage/IndexedDB and target isolation, reject a seventh context
without evicting peers, and keep rendering after one actor ends. The supervisor
test closes one shared browser, checks that its actors become terminal without
restoration, and verifies that another authority partition remains usable. Set
`OPENGENI_BROWSER_EXECUTABLE` to the test Chromium executable, as in CI. Pooling
still requires explicit opt-in; its contexts share a crash boundary and cannot
replace durable profiles or an OS security boundary.

Chromium main-frame reference actions revalidate the exact observed node through
a single-node accessibility read before input, retaining document/ref checks
and native hit testing. Other frames, semantic locators and engines still use
full-tree resolution. Full post-action observations are unchanged; this removes
redundant page-wide reads without acting on cached node state.

## Journal recovery memory benchmark

Browser/Computer controllers consume the recovered records synchronously inside
that transaction, retaining replay descriptors one at a time. Restart no longer
materializes all retained observation graphs into an intermediate array. Failed
controller initialization rolls back recovery and closes the scoped iterator.

For an opt-in synthetic restart-memory comparison, run each mode in a fresh Bun
process against the same fixture. This seeds 1,800 receipts with 1,000 semantic
nodes each (roughly 223 MiB on disk); the baseline can consume several GiB of RAM.
It never launches a browser or uses real session data. Both modes verify every
replayed receipt against the restored digest. Compare Linux `maxRSSKiB` on the
same host; this measures journal/controller recovery, not browser capacity.

```sh
bun packages/browserd/test/journal-recovery.bench.ts seed /tmp/browser-recovery-bench.sqlite
bun packages/browserd/test/journal-recovery.bench.ts baseline /tmp/browser-recovery-bench.sqlite
bun packages/browserd/test/journal-recovery.bench.ts candidate /tmp/browser-recovery-bench.sqlite
```
