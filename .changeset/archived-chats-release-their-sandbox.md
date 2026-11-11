---
"@opengeni/react": minor
---

A compute sandbox is deleted once every chat that works in it is archived.

- Archived chats no longer keep their sandbox in storage. A sandbox shared by several chats stays while any of them is live, and a chat with work under way keeps its sandbox.
- A chat restored from the archive continues on a new sandbox. Its timeline says the old one was deleted, and the agent is told on its next turn that the old files are gone.
- New message key: `timeline.projection.sandboxDeletedWhileArchived`.
