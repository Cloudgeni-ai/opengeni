---
"@opengeni/desktop": patch
---

App-shots work on macOS releases where `osascript` never calls a JavaScript `run` handler (macOS 26.2 among them). There the shortcut could not be set up, the permission check reported nothing, and captures failed. Each helper now calls its own entry point with its arguments.
