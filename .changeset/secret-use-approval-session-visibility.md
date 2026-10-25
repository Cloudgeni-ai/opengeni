---
"@opengeni/db": patch
---

Migration 0953 (rolling) adds the restrictive session visibility policy to `secret_use_approvals`, so an approval request is readable only by someone who can see the chat it came from, like every other chat-linked row. Grants still cover the acting person's own chats.
