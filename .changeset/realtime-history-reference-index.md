---
"@opengeni/db": patch
---

Index realtime history references so archiving conversation history does not scan the entire realtime ledger for every deleted item. The additive index builds online and preserves foreign-key behavior.
