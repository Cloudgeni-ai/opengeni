# @opengeni/browser-extension

## 0.1.3

### Patch Changes

- 2c2e03d: Keep an attached browser connected when its profile label changes. Publish the updated label in inventory without replacing the connection generation or invalidating active browser sessions and pending commands. Older extensions can continue sending tab-only inventory.
- 2952b97: Make clicks and hovers in attached Chrome fast again. Agent tabs open in the background so the user's foreground tab is left alone, and Chrome held every mouse event sent to such a hidden tab for about five seconds before acknowledging it, so each click cost over five seconds regardless of how many agents ran. Attached sessions now use the same target-local focus emulation as managed browsers, which keeps a background tab rendering and taking input without activating it; Chrome clears it when the debugger detaches. The extension admits exactly `Emulation.setFocusEmulationEnabled` and no other Emulation method.
- The packaged manifest version now comes from `package.json`, so Changesets owns the extension version and every package (unpacked archive and store ZIP) carries the same version.
