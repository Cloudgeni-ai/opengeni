---
"@opengeni/browser-extension": patch
---

Apply a downloaded extension update without waiting for Chrome to restart. Chrome installs an update only when the extension's worker stops, and the native connection keeps it running for as long as Chrome does, so fixes (such as fast background-tab clicks) did not reach the browser until a restart. The extension now reloads itself into the new version as soon as no agent is driving a tab: nothing attached, or no agent command for 15 minutes, and never during a command.
