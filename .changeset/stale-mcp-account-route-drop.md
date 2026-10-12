---
"@opengeni/core": patch
---

Reconfiguring a connector no longer fails every agent-started turn in existing chats. When a connector is removed, made public, or moved to another provider after a chat accepted an account for it, the worker drops that frozen account route instead of failing the turn with "Accepted MCP account route does not match canonical provider". The route is still never rebound to the new configuration; the chat's other tools keep working, and the next human message picks up the connector's current accounts.
