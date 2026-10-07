---
"@opengeni/runtime": patch
---

Modal router reads no longer report a finished command as still running when the exit poll is answered just before both output streams reach EOF; the page polls again within its existing read budget. Internal Channel-A commands (file writes, skill checkout) that still yield a retained process are observed through the non-model-visible control read until exit, so a finished internal command reports success and is settled instead of being adopted later as an agent-visible background command.
