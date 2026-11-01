---
"@opengeni/api-router": patch
---

When a session tool (`session_get`, `session_send_message` and the others) answers "Session not found or access denied" for a chat in this workspace, the explanation now starts by saying that session tools see only chats the person the turn acts for can open, so another person's private chat is out of reach, and that a turn started by a message from another person's chat acts for that person. Before, it talked only about full access and other workspaces. A chat woken by a colleague's message could then wrongly conclude it had lost access to its own workspace.
