---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Archiving a Knowledge collection now also archives what is only inside it: its sub-collections and the entries no other live collection holds. Before, they stayed in use and moved to the top of Collections, so archived collections seemed to come back. Undo, or restoring the collection, brings back everything archived with it. Entries that are also in another live collection, entries you can't change, and anything archived separately keep their state.
