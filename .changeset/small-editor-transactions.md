---
"@opengeni/runtime": patch
---

Use supported transactional file transfers for small in-place editor updates and file creation, avoiding interruption-prone direct replacement writes. Preserve legacy-agent and small-move compatibility.