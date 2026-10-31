---
"@opengeni/api-router": patch
"@opengeni/react": patch
---

When a member is suspended, removed from the organization or removed from a workspace, the confirmation says that schedules they own stop running. A schedule stopped because its owner's access changed now also says what happens when the owner has left: it can't run as them again, so someone else can set it up as theirs or delete it.
