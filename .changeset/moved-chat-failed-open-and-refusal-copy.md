---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A computer_open or browser_open that moved the chat to another machine and then failed now says the chat moved, so the agent does not assume it is still on its old machine. Moving a chat in the UI to a machine that has not reported its workspace folder, or whose workspace does not contain the chat's working folder, shows what to do instead of "Try again."
