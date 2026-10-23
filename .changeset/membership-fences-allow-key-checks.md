---
"@opengeni/db": patch
---

Fix a database deadlock between an external user's request and a turn starting in one of their chats. Resolving an external identity, changing a chat's visibility and forking a chat no longer take a lock on the person's organization membership that blocks foreign-key checks, so a turn that updates its chat twice can no longer deadlock with them. Lifecycle changes to the membership are still excluded until those requests commit.
