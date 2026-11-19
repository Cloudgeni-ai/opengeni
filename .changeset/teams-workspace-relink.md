---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

A workspace whose Microsoft Teams bot was disconnected can now be connected to a different Teams organization through the normal setup. Setup releases the old organization's binding in the same transaction: its account links, stored chat choices, routes, pending deliveries and chat context in the workspace are removed, the old organization can no longer reach the workspace, and the release is audited. A workspace that is still connected to another organization is refused with a message that says to disconnect the bot first.
