---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

Computer use now runs on CUA Driver 0.36. On macOS, drags are delivered to background windows without bringing them forward, background typing reaches editor surfaces and multi-window apps, and background actions no longer raise Chrome or re-activate the user's app. The batch tool `run_actions` is replaced by upstream's `run_steps`, which adds targeting by role and name, per-step waits and checks, and a diff of what changed (`observe: {}`). The new `run_script` tool runs a short sandboxed script against the same computer session for flows that need loops or branches; it has no filesystem, network or process access.
