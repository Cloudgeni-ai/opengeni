---
"@opengeni/contracts": patch
---

A chat or scheduled task can now carry up to 1024 inline Skills instead of 32. Going over the limit still rejects the request; nothing is dropped. The request size limit bounds the Skill files, and the model's Skill index keeps its own budget for names and descriptions.
