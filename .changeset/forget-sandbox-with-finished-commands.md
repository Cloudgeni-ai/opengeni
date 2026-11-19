---
"@opengeni/db": patch
---

A stopped sandbox of archived chats is now forgotten even when a background command once ran in it, and deleting such a chat no longer fails. The finished command's records (its retained process, background command and closed terminal) go with the sandbox; a sandbox where a command still runs, or whose supervised output is not captured yet, is kept.
