---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Computer and browser calls of one model response that use the same ComputerSession, or the same BrowserSession tab, now run in model order, so a `computer_observe` written after a `computer_act` shows the window after it, and a parallel read can no longer replace the reading an unfenced action was fenced on. Calls on other sessions or tabs, and other tools, still run concurrently. CUA keyboard input fenced on an earlier reading of the same window is sent when that window's focused element is unchanged.
