---
"@opengeni/agent-proto": minor
"@opengeni/db": minor
---

A runner process that comes back after another process took its connection no longer keeps running commands Opengeni already settled. On every connection the agent reports the operations it still runs or retains (a new `operation_inventory` agent event), and the API answers each page in that same exchange with the operations it no longer recognises: settled commands, and work without a command, such as a command deleted with its chat, from an earlier connection generation. The agent stops them. Nothing is recorded server-side and no request is sent to the agent, so a sleeping compute sandbox is never woken for it. Agents that do not send the event keep the earlier behaviour.
