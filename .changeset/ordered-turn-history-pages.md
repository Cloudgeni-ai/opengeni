---
"@opengeni/db": patch
---

Add an online ordered turn-history index so durable tool receipt checks can fetch the newest page without sorting the turn or scanning unrelated session history. History contents, ordering, access checks and receipt semantics are unchanged.
