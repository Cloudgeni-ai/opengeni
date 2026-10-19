---
"@opengeni/runtime": patch
---

A command or file operation in flight when a Connected Machine's agent restarts,
or when a compute sandbox's VM dies and boots fresh, now ends as soon as the new
agent connection is live instead of retrying the old one for minutes. A running
command is reported lost because the agent restarted, a read is read again from
the new agent, and a request that never reached the old agent is sent to the new
one. A streaming command's timeout now also covers its start, so abandoned work
no longer keeps a sandbox lease warm or blocks deleting the chat.
