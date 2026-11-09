---
"@opengeni/db": patch
---

Deleting a turn that delivered a system update no longer fails. The update's link to that turn was a foreign key that, on delete, also tried to clear its workspace column. Migrations 1341 and 1342 make it clear only the link, and a catalog test now rejects any foreign key that would clear a required column on delete.
