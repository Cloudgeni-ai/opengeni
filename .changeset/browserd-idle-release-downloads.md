---
"@opengeni/browserd": patch
---

An idle managed browser is no longer stopped while it is still receiving a download. Before, a download that ran longer than the idle time without any request to the browser failed with `browser_ended` when the browser was released; the browser now waits until the download settles.
