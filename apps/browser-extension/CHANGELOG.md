# @opengeni/browser-extension

## 0.1.6

### Patch Changes

- 13b9837: The popup now says why it cannot reach the computer's agent instead of a bare "Agent unavailable": the agent is not set up on this computer, it is too old for this extension, it is not running, or it stopped. The raw browser error stays available on hover.
- 87b1e0e: When the extension and the computer's agent don't match, the popup now says plainly which side is outdated: "Update the Opengeni agent" (with the agent's version when it reports one) or "Update this extension". When the agent reports the extension as the older side, the extension checks for its own update right away and applies it, since nothing is attached while the agent refuses it. Current agents explain every refused connection (not running, older or newer bridge, or another error), so the popup no longer guesses between "not running" and "too old".
- cbb55f3: The extension popup now keeps its connection state current while it is open. It used to show the state from the moment it opened, so opening it while the agent was still starting or the native host was still connecting left it saying the agent was unavailable even after the profile connected.

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
