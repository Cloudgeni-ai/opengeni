---
"@opengeni/api-router": patch
---

An agent can now end a managed browser or computer on its owner's personal (Only me) Connected Machine even when the chat that opened it is idle, or when the end comes from another chat. Previously the end needed that chat's live per-chat machine permission, failed with an "agent offline" error, and left the browser processes running on the machine until it ran out of browser capacity. Ending runs nothing new on the machine, so it now needs only the owner's access. Every other operation still needs the chat's permission.
