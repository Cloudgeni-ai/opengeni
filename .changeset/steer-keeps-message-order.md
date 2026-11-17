---
"@opengeni/db": patch
---

A Steer no longer lets a later message be answered before one sent earlier. Steering a queued message, or sending a new message as a Steer, used to move it to the front of the queue. When nothing was running yet, that turn started first and answered without ever seeing the earlier message, which then ran on its own afterwards. A Steer now keeps the order messages were sent in. The running turn, and each message still waiting ahead of the Steer, hands over to it before its first model request, so the agent reads every message up to the Steer, in order, before it answers. A pending Agent Steer still runs ahead of queued messages, but no longer lets a human Steer skip an earlier human message. Only an explicit queue Move changes the order.
