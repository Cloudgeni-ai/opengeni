---
"@opengeni/core": patch
---

Agent browser, computer, file and terminal requests now reach a personal (Only me) Connected Machine that their chat is allowed to use. The agent acts for the person who started its turn and passes the same per-chat check as swap and run_on, instead of failing with "machine-home session points to an unavailable Connected Machine". Without the chat's permission the request is still refused.
