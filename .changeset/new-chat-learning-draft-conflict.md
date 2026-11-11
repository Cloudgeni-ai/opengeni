---
"@opengeni/core": patch
"@opengeni/db": patch
---

A new chat now sends after its learning settings (Knowledge, Instructions, Skills) were changed in the composer. Before, every send failed with "this draft kept changing in another tab or window" and kept failing for each later new chat, because the saved draft carried the learning choice and the check that the request matches the draft ignored it.
