---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Add a quiet "-> Workspace" line to Slack acknowledgements and deliveries when routing actually chose a workspace, and bump all five Slack post operation-id seeds to v2 in the same change so no interaction with a claimed-but-unposted delivery row can wedge on a digest that will never match again.
