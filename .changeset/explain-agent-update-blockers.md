---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
"@opengeni/browserd": patch
"@opengeni/agent-proto": patch
---

Retain bounded agent-update blocker categories/counts and show their report age
and elapsed holds in Machines and fleet, without disclosing private session IDs. Distinguish controller work
from native request admission without changing update safety, killing work or
adding command deadlines. Older agents that cannot identify a blocker remain
explicitly unspecified. These diagnostics do not establish the cause of an earlier
hold whose admission snapshot was not retained.
