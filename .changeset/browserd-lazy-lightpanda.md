---
"@opengeni/browserd": patch
---

The browser controller starts faster on a fresh sandbox: it now checks the pinned Lightpanda binary when a Lightpanda session first needs it, instead of reading and hashing the whole file on every start. On a fresh VM's cold disk that read took about a second before the first browser could open.
