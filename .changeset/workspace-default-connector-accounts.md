---
"@opengeni/core": patch
---

Freeze follow-up connector accounts against a workspace-default session's effective tool list. A session that tracks workspace defaults stores only its creation-time snapshot, so account selections for a connector enabled later were rejected as unmatched and its personal delegation was never frozen.
