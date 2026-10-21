---
"@opengeni/db": patch
---

A chat shared with the workspace whose parent chat is still private can now be prompted by other members. Their turns used to fail before the model ran ("A database error occurred.") because the turn-start Company Brain context selection required the whole task tree, private parent included, to be visible to them. The selection now needs only the exact current turn and attempt and the addressed chat to be visible (migration 0896). Task notes still cover the whole tree, so they stay closed to a member who cannot see the private parent.
