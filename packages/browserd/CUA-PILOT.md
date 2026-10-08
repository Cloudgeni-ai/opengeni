# CUA desktop adapter

The macOS and Linux adapters use CUA Driver source revision
`2e4736b3ebff61ef99e8c0c74270b5cd75894643`, including its non-invalidating preview
capture and cursor support. `@trycua/cua-driver` 0.34.0 supplies the private-worker
transport; the source-built executable performs desktop operations. The narrow
Windows experiment still uses the published SDK in process. Native remains the
default until platform acceptance is complete.

`ComputerBackend` retains the legacy desktop projection and exposes native CUA calls. The existing `ComputerDriver`
continues to handle OpenGeni sessions, operation receipts and frame streaming.
There is no second authorization system or operation journal. Structured browser
control, attached Chrome and browser profiles are unchanged.

## Runtime and packaging

Select `OPENGENI_BROWSERD_COMPUTER_BACKEND=cua` with the existing desktop
environment mode. On macOS, upstream's `createPrivateWorker` owns the child and
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
- Windows has not completed adoption acceptance. Windows requires an
  unlocked interactive session on `WinSta0/Default`; Session 0 is refused.
  Only Windows semantic actions and window capture are admitted. Edit values
  and labels copied from those values are redacted when password metadata is absent.
- Release staging includes macOS and Linux. Signed macOS application acceptance is required before
  changing the default backend.

Pointer frames supply coordinate dimensions, not one-shot action permission.
Repeated gestures may use the same displayed frame. Passive captures use
`display_only` to preserve both accessibility tokens and native pixel/zoom state.
Viewer pointer input takes a fresh capture under the serialized worker queue,
translates coordinates, and refuses resized windows. The adapter requests structured elements
for semantic observations. Unknown input outcomes are never automatically replayed.

[Upstream source](https://github.com/trycua/cua/tree/2e4736b3ebff61ef99e8c0c74270b5cd75894643/libs/cua-driver)

## Native agent interface

The release catalog comes from the bundled worker's `listToolsJson()` via
`bun packages/browserd/scripts/generate-cua-desktop-tools.ts`. It admits desktop
workflow tools; lifecycle, escalation, configuration, updates and browser tools
stay outside this interface. macOS and Linux each have a generated catalog;
agent schemas preserve the union of their native variants, and the selected
runtime checks its exact platform schema. Other platforms must supply their own
qualified schemas before native admission.
Each admitted tool's input/output schemas are checked against the running worker.

Agents use `interaction__cua_<upstream_name>` or Code Mode
`computer.<upstream_name>`. Arguments remain native snake_case, with
`computerSessionId` replacing the host-owned CUA `session`. Existing
`computer_open` and `computer_act` selection plus computer control permission
are required, including for read-like tools that can write screenshot files.
No tool-enable UI or separate permission system is added.

`run_actions` retains upstream batching and optional final observation;
`get_window_state` retains compact Markdown, query limits and diff reads.
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
