---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A `computer_act` (and native CUA tool) call now runs in model order with the other calls of its response, so a `computer_observe` written after an action shows the window after it, and a parallel read can no longer replace the reading an unfenced action was fenced on. CUA keyboard input fenced on an earlier reading of the same window is sent when that window's focused element is unchanged.
