---
"@opengeni/browserd": patch
---

A page's missing icon no longer counts as a failed request. Chrome fetches `/favicon.ico` or a declared `<link rel=icon>` by itself, and on the many sites without one, every browser observation reported "1 failed request" that the page never made. Requests the page makes, including images, scripts and fetches, are still counted.
