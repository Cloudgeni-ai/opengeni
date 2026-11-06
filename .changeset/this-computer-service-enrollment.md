---
"@opengeni/agent-host": patch
---

When the separately installed Opengeni Agent runs this computer, the desktop app now reports which machine it is in the workspace. Its status left the enrollment out in that case, so Settings › Computer use could not find the computer in the machine list and showed screen control and Chrome as Off while agents were using both, and the Runs on menu did not mark the computer as "This computer". The app-run case already reported it.
