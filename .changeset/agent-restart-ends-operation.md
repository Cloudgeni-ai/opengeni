---
"@opengeni/runtime": patch
---

A command or file operation in flight when a Connected Machine's agent restarts,
or when a compute sandbox's VM dies and boots fresh, now ends as soon as the new
agent connection is live instead of retrying the old one for minutes. A command
that may have started is handed to the session's command ledger with a stop
request and reported with an unknown outcome, a read is read again from the new
agent, and a request that never reached the old agent is sent to the new one
with only the time it has left. A streaming command's timeout now also covers
its start, so abandoned work no longer keeps a sandbox lease warm or blocks
deleting the chat.
