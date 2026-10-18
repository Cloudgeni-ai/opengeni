---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

A browser that was marked lost because its suspension found the controller had restarted can now be resumed from its preserved working copy. The resume continues the same browser and profile on the generation that owns that copy, instead of refusing the browser forever. If the copy can't be continued, resume says so plainly and leaves the browser lost; it never silently rolls back to an older checkpoint.
