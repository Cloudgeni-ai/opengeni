---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A browser that cannot start now says why. A machine without Chrome or Chromium reports that plainly as an unsupported placement, other launch failures carry the driver's own reason, and `browser_open` returns that reason as an error instead of a bare failed session.
