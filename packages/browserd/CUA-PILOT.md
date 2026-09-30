# CUA desktop pilot

Experimental, source-run macOS adapter for `@trycua/cua-driver` 0.30.4. **Not ready
for deployment or replacing the native backend.** The native backend remains the
default. Browsers, attached Chrome, browser profiles and browser input are unchanged.

`ComputerBackend` owns desktop operations. `ComputerDriver` adapts those operations
to the existing OpenGeni controller, operation receipts and frame stream. The CUA
adapter translates desktop calls only. It does not add an authorization system or
another operation journal. Machine/session access remains enforced above it.

For source-mode experiments, select `OPENGENI_BROWSERD_COMPUTER_BACKEND=cua` with
the existing desktop environment mode. Only one CUA session may own this process's
physical desktop. Existing macOS accessibility and screen-recording permissions
are required; the adapter does not request permissions or silently front apps.

From this package, run:

```sh
bun run typecheck
bun test test/cua-backend.test.ts
OPENGENI_CUA_E2E=1 bun test test/cua-computer.e2e.test.ts
```

The live test compiles a disposable AppKit window, verifies text replacement,
semantic clicks, replay without a second click, PNG streaming, pixel clicks and
repeated scrolling. Input is checked against the fixture's independently written
state. Only its own window is closed. The test also characterizes the following
known failures; a passing characterization is **not** full adoption acceptance.

## Remaining acceptance gaps

- **Semantic actions with a live viewer:** CUA 0.30.4 replaces its accessibility
  snapshot on screenshot-only reads. A viewer frame invalidates an agent's earlier
  element handles. Reading the initial image before the initial semantic snapshot
  fixes cold startup, but does not solve a continuously running viewer. Resolve
  this at the capture/observation boundary; do not paper over it with retries or
  guessed replacement element references.
- **Mac background drag:** the released SDK explicitly rejects it before posting
  input. The adapter reports unsupported. Foreground delivery needs integration
  with OpenGeni's explicit desktop focus/control behavior and independent testing.
- **Compiled releases:** the SDK's platform-library resolver cannot find its
  native package from Bun's compiled virtual filesystem. Native assets need
  canonical packaging and signing before this backend can ship. Source mode works.
- App launch, whole-desktop capture, clipboard, native hover and foreground focus
  are not yet exposed. Linux and Windows have not been accepted through this adapter.

Pointer frames supply coordinate dimensions, not one-shot action permission.
Repeated scroll/drag requests may use the same displayed frame. No new screenshot
is required for each gesture. CUA background pointer delivery remains targeted at
the selected PID and window. The current scroll API accepts wheel notches rather
than pixel deltas; the adapter maps a conventional 100-pixel wheel step to one notch.

Upstream references: [SDK 0.30.4 source](https://github.com/trycua/cua/tree/cua-driver-rs-v0.30.4/libs/cua-driver/rust),
[capture behavior](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/libs/cua-driver/rust/crates/platform-macos/src/tools/get_window_state.rs),
[Mac drag](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/libs/cua-driver/rust/crates/platform-macos/src/tools/drag.rs).
