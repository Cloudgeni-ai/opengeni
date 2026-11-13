---
"@opengeni/db": minor
---

A stopped Modal or Docker sandbox is forgotten a day after every chat that works in it is archived, as a compute sandbox is.

- Its saved workspace goes with it, and the checkpoint GC deletes the Modal snapshot it named, which had no expiry. Before, it was kept until the chats were deleted.
- The same rule as for compute: a chat restored within a day keeps its sandbox, one stored automatically after weeks unused loses it at once, and a sandbox shared by several chats stays while any of them is live. A chat restored later continues on a new sandbox and is told the old files are gone.
- New definer `opengeni_private.cold_sandboxes_of_archived_chats_v1` (migration 1404), withheld from the runtime for one release; until a later migration grants it nothing changes.
