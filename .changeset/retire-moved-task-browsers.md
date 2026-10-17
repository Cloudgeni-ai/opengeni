---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Stop browsers and Desktops a task leaves running on a Connected Machine it moved away from. Retiring a browser now also stops one that an agent restart left running detached (its profile and downloads stay on disk) and every later request that notices the move retries earlier retirements of that task's browsers and Desktops that found the machine offline or refusing.
