---
"@opengeni/runtime": patch
---

Configured agents without a sandbox or Connected Machine no longer receive instructions they cannot act on: editing or publishing sandbox files, workspace file links, building Sites, sandbox paths, background-command acknowledgement and sandbox CLI lists. The verification rule names a goal and its completion audit only when goals are on. Sessions with a sandbox or Connected Machine keep their exact prompt; an "all"-capabilities session without compute drops about 380 system-prompt tokens per call.
