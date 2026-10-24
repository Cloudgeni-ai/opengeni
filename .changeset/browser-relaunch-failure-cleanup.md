---
"@opengeni/browserd": patch
---

A browser whose saved process had exited is relaunched on its profile when it is next used. If that start failed partway (for example because a restored tab had no JavaScript context yet), the browser service detached from the new browser instead of stopping it. The browser kept running with nothing tracking it, and every later attempt to open the session was refused because the profile could not be proven unused. Now a failed relaunch closes the browser it started, so the next attempt relaunches the same profile with its tabs. The start also no longer fails when a restored tab has no JavaScript context yet: the optional viewport reading is skipped, and the user-agent reading uses its hidden page, as it already does when the page returns nothing.
