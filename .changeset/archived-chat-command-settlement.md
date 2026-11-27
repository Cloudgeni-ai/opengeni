---
"@opengeni/db": patch
---

A background command in a chat that was archived while it ran now settles, and its sandbox drains cold. The command's result was delivered to the archived chat as agent input and a wake, which the database refuses for read-only chats (`SESSION_ARCHIVED_READ_ONLY`), so every reaper settlement and drain of that box failed and it stayed draining. Archived and imported chats now get only the `session.command.finished` audit event, like a cancelled chat, and their closed turns get no wake.
