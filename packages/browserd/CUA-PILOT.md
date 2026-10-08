# CUA desktop adapter

The macOS adapter uses CUA Driver source revision
`49e924c4632882134b204b2e8a0ce8fae44418df`, including its non-invalidating preview
capture and cursor support. `@trycua/cua-driver` 0.34.0 supplies the private-worker
transport; the source-built executable performs desktop operations. The narrow
Windows experiment still uses the published SDK in process. Native remains the
default until platform acceptance is complete.

`ComputerBackend` translates desktop calls into CUA. The existing `ComputerDriver`
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

## Current limits

- Mac background drag is refused before input. Native hover, app launch,
  whole-desktop capture, clipboard and foreground focus are not exposed here.
- Background support depends on the target application's native controls. It
  does not make every desktop application fully operable in the background.
- Linux and Windows have not completed adoption acceptance. Windows requires an
  unlocked interactive session on `WinSta0/Default`; Session 0 is refused.
  Only Windows semantic actions and window capture are admitted. Edit values
  and labels copied from those values are redacted when password metadata is absent.
- Release staging is macOS-only. Signed application acceptance is required before
  changing the default backend.

Pointer frames supply coordinate dimensions, not one-shot action permission.
Repeated gestures may use the same displayed frame. Capture-only reads preserve
CUA's accessibility snapshot; the adapter explicitly requests structured elements
for semantic observations. Unknown input outcomes are never automatically replayed.

[Upstream source](https://github.com/trycua/cua/tree/49e924c4632882134b204b2e8a0ce8fae44418df/libs/cua-driver)
