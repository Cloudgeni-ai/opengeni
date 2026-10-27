---
"@opengeni/contracts": minor
"@opengeni/runtime": patch
---

A BrowserSession now reports how its headed managed browser was actually shown on its machine: the new optional `display` field is `window` for a native window or `offscreen` for a browser with no window (a managed browser on macOS, or on a Linux host without a display). It comes from the browser controller at create, resume and recovery, never from the requested mode, and is absent for headless, remote and attached browsers and for older controllers. The agent's session line for such a browser now reads "headed, offscreen with no window," instead of only "headed", and the create that launches it adds one short line naming what to use for a step a person must do at the machine.
