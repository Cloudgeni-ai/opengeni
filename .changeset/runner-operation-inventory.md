---
"@opengeni/agent-proto": minor
"@opengeni/db": minor
---

The agent now reports the operations it still runs or retains (a new `operation_inventory` agent event), on every connection and again while it holds completed output nobody released, and the API answers each page in that same exchange with the operations to end. Every OpStart carries the connection generation it was dispatched under, which the agent stores with the operation. A command decides by its custody: output Opengeni has not stored is never ended but collected while the agent is talking, and stored output is ended and its release recorded. Work without a command, such as a command deleted with its chat, is ended when it started under an earlier connection generation and is otherwise kept, never ended for its age. So a runner process that comes back after another process took its connection no longer keeps running commands Opengeni already settled, and output whose storing process died is recovered by the agent itself. The agent starts every such exchange, so a sleeping compute sandbox is never woken for it. Agents that do not send the event keep the earlier behaviour.
