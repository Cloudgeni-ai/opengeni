---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

A browser session in the person's own Chrome that continues after being idle, or after its controller restarted, no longer opens a blank tab in the person's window when none of its tabs are left. It carries on in the tab it was using, or in another tab it opened that is still open, and otherwise has no tab until it opens one. Deploy the API with or before browserd: the controller can now answer a continued session with no observation.
