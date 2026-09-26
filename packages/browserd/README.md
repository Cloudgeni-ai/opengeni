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
