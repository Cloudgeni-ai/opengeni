---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Workspace instructions can now be cleared. Saving empty text in Knowledge > Instructions (or creating and activating an instruction policy draft with empty content through the API or SDK) clears the policy: agents get no workspace instructions, the earlier versions stay in History, and any of them can be restored. Clearing also removes an instruction override saved in earlier workspace settings, so nothing applies again by surprise.
