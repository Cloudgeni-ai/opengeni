---
"@opengeni/api-router": patch
---

Suspending a browser whose controller restarted (for example after a Connected Machine agent update) no longer marks it `lost` with `controller_resource_missing`. Suspension first reaches the controller the way any use does, relaunching the browser from its intact private profile, and then saves that profile. A browser that cannot be recovered is still recorded as lost.
