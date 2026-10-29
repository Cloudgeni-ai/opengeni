---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

A browser session in the person's own Chrome that continues after being idle, or after its controller restarted, no longer opens a blank tab in the person's window when none of its tabs are left. It carries on in the tab it was using, or in another tab it opened that is still open, and otherwise has no tab until it opens one. Its tools then never pick one of the person's tabs by themselves: they say the session has no tab of its own and to open one, or to name one of the person's tabs. The API tells browserd it can take a session with no tab, so browserd and the API can be deployed in either order.
