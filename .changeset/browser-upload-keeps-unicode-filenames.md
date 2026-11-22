---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

A workspace file uploaded into a page through a browser now keeps its own name in any script. Before, every character other than ASCII letters, digits, spaces, dots, underscores and dashes became `_`, so `Rørføring etg. 2 – rev A (SIM).pdf` reached the page as `R_rf_ring etg. 2 _ rev A _SIM_.pdf`. The staged copy is now named from the file's original name, with only path separators, control characters and characters Windows forbids replaced, a trailing dot or space removed, and the name kept within 240 UTF-8 bytes. A browser controller from before this change refuses such names as invalid; it is sent the ASCII names it has always accepted instead, so uploads keep working while machines update.
