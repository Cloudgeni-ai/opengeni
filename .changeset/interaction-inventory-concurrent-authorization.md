---
"@opengeni/api-router": patch
---

Browser and computer session lists check each distinct source chat's read access a bounded number at a time instead of one after another, so a workspace inventory spanning many chats no longer takes one database round trip per chat in sequence. Visibility rules are unchanged.
