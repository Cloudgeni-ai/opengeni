# CUA desktop adapter

The macOS and Linux adapters use CUA Driver source revision
`737e200fca49cbf6b0116f8acf7f52525aa45cef`: upstream `cua-driver-rs-v0.37.0`
(`2d2f9922`, including its non-invalidating preview capture and cursor support)
plus two Linux X11 coordinate fixes, a macOS per-action overhead fix (a hidden
cursor no longer glides; Electron detection no longer spawns `ps`), `run_steps`
step reports that keep the windows each step opened, and a `run_steps` option
(`refind_stale:false`) that stops a batch at a stale element token instead of
acting on a lookalike found again by role and label, or re-sending a refused
menu-bar token click as `invoke_menu`, and a macOS launch of an app that is
already running that sends a reopen (`aevt/rapp`) instead of a second open
event, so a running document app with no window shows its window or Open panel
again, in the background. On macOS it also focuses an element on its own (a
`click` with `action:"focus"` sets `AXFocused` and reads it back, refusing with
`focus_refused`), and lists app windows at the floating and modal-panel levels
(3 and 8) as well as normal windows, so a first-run modal dialog is visible.
Its macOS waits wake on time (a kqueue timed wait instead of `nanosleep`, which
woke a 25 ms poll up to 150 ms late on a busy Mac), and a batch of background
presses on one window makes that window key once instead of before every press.
A press that puts the caret in a text field reports a confirmed effect when the
field then holds the keyboard focus, instead of an unconfirmed click.
On macOS `set_value` writes a text field's value as text even when it reads as
a number (Chrome accepts a number written to a web text field and ignores it).
In web content it writes any number as text: Chrome empties a number field
(`<input type=number>`, an AXIncrementor) given a CFNumber. A number field a
write leaves empty gets its previous value back, and the write is refused as
not applied. A control that takes a value write but keeps its value (a web
range input) is stepped to the value with its increment and decrement actions;
a value outside the range it reports is refused before any step, and a run
that stops short fails with `value_not_reached` and what it reads now.
`write_not_applied` always means the control holds what it held before (a
number field a value emptied reports `write_cleared`), so Opengeni maps it to
a definite failure.
These refusals never repeat the value given, since it may be a secret such as a
PIN in a number field.
On macOS an element of a bubble or popover that a window lists as its own (Chrome's
Save password?, translate, site permission and download bubbles are separate
windows whose content the browser window lists among its accessibility
children) takes accessibility actions (a press, `set_value`) through that
window. Pointer and key input to it is refused with
`element_in_attached_window` before anything is sent, since it would land on
the window under the bubble, and a coordinate click over a bubble never
presses it. An element of an unrelated window of the app is still refused, now
naming the window it belongs to. An element scroll proves the pointer route
before scrolling the element into view, and a wheel refused after that reveal
reports a partial effect.
A focus read-back waits up to 300 ms, since Chrome moves the focus to a web
control a moment after the write.
A `run_steps` lookup or check may set `exact: true`, so its name must be the
element's whole label rather than the start of a word in it.
A `run_steps` lookup or presence check for a button or link that finds nothing
of that role uses the one element of the other of the two with that exact name
(button and link are pressed alike, and on the web models often confuse them),
and its step report and `role_note` say which element it used and to name its
role next time. It never does so for a pick by position, a text write or a
drag, nor for a toggle button or anything with a pressed or checked state, and
a true match in any window wins. It takes the stand-in only from a complete
reading of the window (never one cut at the 2,000-element cap) whose content
has stayed the same for 1.5 s, so a button an earlier step brings up wins over
a link of its name. Several such elements never hold a wait or a lookup: once
the window's content has stayed the same for 1.5 s the step fails as
`ambiguous`, naming them. A window that never settles before the step's
deadline fails as it did before, and a name shown only on an element of an
unrelated role waits its whole time.
On macOS a window's accessibility reading asks the app for each element's
attributes in one request (`AXUIElementCopyMultipleAttributeValues`) instead of
one request per attribute, and bounds each request by what is left of the
read's `timeout_ms`, so a slow app costs a few requests per element instead of
about fifteen and cannot hold a read past its budget. An element whose request
fails for another reason is read one attribute at a time, as before; the
reading is the same. The first `get_window_state` of a process after an action
on it (outside a `run_steps` batch) waits only while the read window is
changing: an action returns when the app has taken it, not when its result is
on screen, and a read at once showed the screen before it or one half way. With
no accessibility notification for the read window within 100 ms of the action's
end, the read goes ahead at once. Otherwise it waits until the window's
notifications (layout
changes, created elements, focus and selection changes, row counts, new windows
and sheets, opened menus) have stopped for 200 ms, counted from the last one,
and goes ahead 1 s after the action at the latest. Value and title changes do
not count, so a window that keeps updating numbers or text (a clock, a progress
bar, a terminal, a process monitor) does not hold the read. A window whose
notifications show it changed while it was read (an app can pause in the middle
of a change) is read again once quiet, at most three reads in all and not past
that 1 s. Notifications of the process's other windows do not count (the iOS
Simulator shows every booted device in one process). The read reports what it
waited for as `settle`, with the number of reads.
`@trycua/cua-driver` 0.37.0
supplies the private-worker transport; the source-built executable performs
desktop operations. Windows uses the published SDK's native runtime in process.
A `computer_act` batch runs as one `run_steps` call only where the worker offers
`refind_stale`, so every step stays bound to the observation the batch was
checked against. The exception is a later action whose role, label or text
locator the observation does not show (an earlier action brings it up): it is
sent by role and name, and CUA finds it when the step runs after waiting up to
10 s for it to appear and enable. So is a first action that names a button or
link the observation does not show when it shows an element of the other of the
two with that name: CUA's stand-in above decides whether it is the one meant.
Every element-targeted action after it is
then found by name too, because CUA's lookup re-reads the window and retires the
observation's tokens. On Windows a batch's actions are sent one at a time. CUA is the
default on macOS, on Windows and for explicitly selected isolated Linux
desktops. Linux host desktops retain the native default.

`ComputerBackend` retains the legacy desktop projection and exposes native CUA calls. The existing `ComputerDriver`
continues to handle Opengeni sessions, operation receipts and frame streaming.
There is no second authorization system or operation journal. Structured browser
control, attached Chrome and browser profiles are unchanged.

## Runtime and packaging

macOS and Windows configuration select CUA with the existing desktop. Linux configuration
retains the existing native desktop unless
`OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE=isolated_linux` is explicitly selected;
that mode defaults to CUA and requires the Linux desktop dependencies listed below.
The incompatible CUA/existing-Linux combination is still refused.
`OPENGENI_BROWSERD_COMPUTER_BACKEND=native` preserves the native backend on every
platform. These choices do not alter browser control.

On macOS, upstream's `createPrivateWorker` owns the child and
its AppKit cursor event loop. The child has no reconnectable endpoint and exits
when its SDK owner closes. A second session cannot take this process's physical
desktop while the first owns it. Separate visual cursors do not isolate focus or
application state.

On Linux, each ComputerSession receives its own Xvfb display, accessibility bus,
home and application profile directories. The worker uses that allocated X11
seat even when the host has Wayland or Xauthority settings. Its private process
group is stopped before those directories are removed. This cleans up ordinary
launched children; programs that deliberately detach into another process session
are outside that group. Display/profile separation is not an OS security sandbox:
process inspection and app management retain the host user's authority.

Existing macOS accessibility and screen-recording permissions are required. The
host application owns permission prompts; CUA does not raise a second prompt.
The adapter selects Standard authorization and does not bypass CUA refusals.
Background input targets the selected window without requesting foreground focus.
Unsupported operations return their limitation rather than switching to foreground.

`stage-cua-runtime.ts` builds the fixed upstream revision, bundles the SDK and
stages its matching native transport package, worker executable and source
receipt. Everything joins the existing immutable embedded helper generation.
Compiled controllers load only their adjacent assets, with no runtime downloads.
For source development, run the staging command first. An operator can supply an
unmodified checkout at that exact revision with `OPENGENI_CUA_SOURCE_DIR` during
build, or an absolute worker path with `OPENGENI_CUA_DRIVER_BINARY` during local
execution. Neither setting is an agent tool argument.

```sh
bun scripts/stage-cua-runtime.ts
bun run typecheck
bun test test/cua-backend.test.ts
OPENGENI_CUA_E2E=1 bun test test/cua-computer.e2e.test.ts
OPENGENI_CUA_E2E=1 bun test test/cua-linux.e2e.test.ts
OPENGENI_CUA_PACKAGING_E2E=1 bun test test/cua-runtime-packaging.e2e.test.ts
```

The opt-in desktop test creates one disposable AppKit window. It checks text
replacement, semantic clicks, replay without a second click, PNG streaming,
semantic input while streaming, pixel clicks and repeated scrolling against
independently written fixture state. It closes only its own window. The packaging
test builds the real compiled loader and verifies that missing adjacent assets
cannot be replaced by an ambient installation. Stage first to keep compilation
outside the test timeout. Building both macOS architectures requires their Rust
targets and Xcode tools.
Linux builds require the X11, XTest, XRandR, XFixes, XInput, XRecord and DBus
development libraries; execution requires Xvfb, an accessibility-enabled desktop,
DBus, XFWM4, xterm, x11vnc and util-linux `setsid`. The Linux test checks two
independent displays, cursor and clipboard state, native batches, viewer captures
and cleanup of a launched non-GUI process. CI builds and runs it on x64 and arm64.

## Current limits

- Mac background drag is refused before input. The legacy action projection remains
  limited; native CUA tools expose app launch, desktop capture, clipboard and cursor
  controls with upstream arguments and results. Foreground activation is explicit.
- Background support depends on the target application's native controls. It
  does not make every desktop application fully operable in the background.
- Linux supports semantic background actions within its isolated X11 seat;
  foreground pointer input stays inside that seat. Unsupported native background
  pointer requests are refused. Web/application acceptance is still required.
- Windows requires an unlocked interactive session on `WinSta0/Default`;
  Session 0 is refused. Window capture, semantic UIA actions, pointer input
  (click, scroll, drag) and keyboard input (typing and key chords with
  ctrl/alt/shift/win) are admitted. Semantic actions run in the background;
  pointer and keyboard input use foreground delivery, which briefly fronts
  the window and restores the previous foreground, because background
  PostMessage input is dropped by Chromium, Electron and WinUI surfaces. Raw
  native CUA tool calls are not offered on Windows yet. Edit values and labels
  copied from those values are redacted when password metadata is absent.
  `cua-windows.e2e.test.ts` drives a real window on a hosted Windows runner.
- Release staging includes macOS, Linux and Windows x64. Runtime defaults take effect only in
  an installed release containing this change; server deployment alone does not
  update a connected machine's installed helpers. macOS still requires OS consent.

Pointer frames supply coordinate dimensions, not one-shot action permission.
Repeated gestures may use the same displayed frame. Passive captures use
`display_only` to preserve both accessibility tokens and native pixel/zoom state.
Viewer pointer input takes a fresh capture under the serialized worker queue,
translates coordinates, and refuses resized windows. The adapter requests structured elements
for semantic observations. Unknown input outcomes are never automatically replayed.

[Pinned source](https://github.com/Cloudgeni-ai/cua/tree/737e200fca49cbf6b0116f8acf7f52525aa45cef/libs/cua-driver).
The two commits on top of upstream carry the X11 coordinate corrections proposed in
[CUA #4890](https://github.com/trycua/cua/pull/4890), rebased onto 0.37: only
Chromium's renderer-local frame is rebased, and GTK4 windows without client-side
decorations rebuild element bounds from Window coordinates. Upstream 0.37 does
not include them; without them GTK4 controls are misplaced after a window move,
which the isolated Linux end-to-end tests catch.

## Native agent interface

The release catalog comes from the bundled worker's `listToolsJson()` via
`bun packages/browserd/scripts/generate-cua-desktop-tools.ts`. It admits desktop
workflow tools; lifecycle, escalation, configuration, updates and browser tools
stay outside this interface. macOS, Linux and Windows each have a generated
catalog, produced by running the script on that platform after every CUA pin
change; macOS defines the admitted set, and a platform whose driver lacks a tool
omits it. Each catalog records the CUA version it was generated from, and a
browserd test fails unless every catalog names the `@trycua/cua-driver` version
browserd pins, so a catalog left on an older CUA release shows up before its
runtime refuses calls. Agent schemas preserve the union of the native
variants, and the selected runtime checks its exact platform schema.
Each admitted tool's input/output schemas are checked against the running worker.

Agents use `interaction__cua_<upstream_name>` or Code Mode
`computer.<upstream_name>`. Arguments remain native snake_case, with
`computerSessionId` replacing the host-owned CUA `session`. Existing
`computer_open` and `computer_act` selection plus computer control permission
are required, including for read-like tools that can write screenshot files.
No tool-enable UI or separate permission system is added.

`run_steps` retains upstream batching, per-step waits and checks, and optional
final observation diff; `run_script` runs upstream's sandboxed script engine, whose
only API is the same CUA session, with no filesystem, network or process access;
`get_window_state` retains compact Markdown, query limits and diff reads.

A `computer_act` batch (semantic and keyboard actions on one window) is one
operation on CUA: the adapter checks every action against the observation the
batch names, sends them as one `run_steps` call, which paces all but the last
step for a batch, and observes the window once at the end, or the window CUA
reports the last action opened. A batch CUA stops part way records how many
actions completed in its receipt's error details. A keyboard action after the
first carries no element token, since earlier actions may have moved the focus.
MCP content, structured results and images survive the journal. Responses larger
than 12 MiB carry an explicit bounded projection, retained operation status and
no-replay guidance; the original stays in the controller journal. Failed
or uncertain calls also retain their native evidence and explicit no-replay
status. Native and legacy calls share one operation-ID namespace. The SDK exposes
`callNativeComputerTool` and `computers.get(id).callNativeTool`; the native receipt accessor is `getNativeComputerToolReceipt` or
`nativeReceipt`. Existing legacy receipt methods keep their public types.

After native calls begin, ordinary web-view observation polling returns geometry
and pixels without minting a new accessibility snapshot. This preserves the
agent's element tokens; human keyboard input retains a matching observation
fence. Native tools use their own CUA session identity: after actual viewer
pointer input changes the pixel frame, stale native pixel/zoom input is refused
until a new native observation. The native tool result owns the semantic tree.
The disposable Mac test covers native batching, replay, differently scaled
preview polling, pixel and zoom clicks, and keyboard/pointer takeover.
