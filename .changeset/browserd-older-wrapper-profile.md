---
"@opengeni/browserd": patch
---

A managed browser launched through the desktop image's browser wrapper from an image older than its profile fix is recorded with its process again. The controller now names its own profile to the wrapper, and the process check accepts that same profile switch repeated, so the browser can be continued after it stops instead of being refused as having no recorded browser process. Sandboxes keep the image they were created from, so this reaches them without an image change.
