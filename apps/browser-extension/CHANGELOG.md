# @opengeni/browser-extension

## 0.1.5

### Patch Changes

- 615cc90: Apply a downloaded extension update without waiting for Chrome to restart. Chrome installs an update only when the extension's worker stops, and the native connection keeps it running for as long as Chrome does, so fixes (such as fast background-tab clicks) did not reach the browser until a restart. The extension now reloads itself into the new version as soon as no agent is driving a tab: nothing attached, or no agent command for 15 minutes, and never during a command.

## 0.1.4

### Patch Changes

- Report a state generation that stays the same for the extension worker's lifetime, across native reconnects. Agents that understand it keep the profile's attached browser sessions alive through agent restarts, agent updates and native-host reconnects instead of ending them; each native port is still fenced by its own connection generation.

## 0.1.3

### Patch Changes

- 2c2e03d: Keep an attached browser connected when its profile label changes. Publish the updated label in inventory without replacing the connection generation or invalidating active browser sessions and pending commands. Older extensions can continue sending tab-only inventory.
- 2952b97: Make clicks and hovers in attached Chrome fast again. Agent tabs open in the background so the user's foreground tab is left alone, and Chrome held every mouse event sent to such a hidden tab for about five seconds before acknowledging it, so each click cost over five seconds regardless of how many agents ran. Attached sessions now use the same target-local focus emulation as managed browsers, which keeps a background tab rendering and taking input without activating it; Chrome clears it when the debugger detaches. The extension admits exactly `Emulation.setFocusEmulationEnabled` and no other Emulation method.
- The packaged manifest version now comes from `package.json`, so Changesets owns the extension version and every package (unpacked archive and store ZIP) carries the same version.
