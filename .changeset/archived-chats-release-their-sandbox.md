---
"@opengeni/react": minor
---

A compute sandbox is deleted a day after every chat that works in it is archived.

- Archived chats no longer keep their sandbox in storage forever. A chat restored within a day of archiving keeps its sandbox. A chat stored automatically after weeks unused loses its sandbox at once. A sandbox shared by several chats stays while any of them is live, and a chat with work under way keeps its sandbox.
- A chat restored later continues on a new sandbox. Its timeline says the old one was deleted, and the agent is told on its next turn that the old files are gone.
- New message key: `timeline.projection.sandboxDeletedWhileArchived`.
