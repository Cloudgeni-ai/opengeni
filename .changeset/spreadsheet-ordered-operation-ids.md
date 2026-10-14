---
"@opengeni/db": patch
---

Spreadsheet edits that send several commands in one batch now commit. The database checked the batch's operation ids as if they had to be alphabetically sorted, but they follow command order, so most multi-command edits failed with a generic commit error.
