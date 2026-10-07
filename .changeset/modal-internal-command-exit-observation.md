---
"@opengeni/runtime": patch
---

Modal router reads no longer report a finished command as still running when the exit poll is answered just before both output streams reach EOF; the page polls again within its existing read budget. Internal callers that read once (file writes, Skill checkout) now see the finished command's exit instead of failing, so the command is not retained and later adopted as an agent-visible background command.
