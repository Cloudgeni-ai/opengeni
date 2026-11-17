---
"@opengeni/contracts": patch
"@opengeni/core": patch
---

Creating or updating a session with a first-party tool's old name from before a one-to-one rename (for example `session_send_message`, now `session_queue_message`) selects the new name again instead of failing with "disabled by deployment policy". Clients built against an older contract kept sending the old name and every such session was refused at creation. The old name is still never offered to models.
