---
"@opengeni/runtime": patch
---

browser_open on a browser that was lost because its controller restarted, or because its resume expired, now resumes it through the browser resume route, as it already did for a suspended browser. The route continues the same browser and profile from its preserved working copy, or refuses with the reason, and never falls back to an older checkpoint. Before, browser_open returned the lost browser with no tabs and no way forward, so an agent could not continue its own browser after an agent update or restart.
