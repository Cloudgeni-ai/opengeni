---
"@opengeni/browserd": patch
---

A browser clipboard paste without text now fails when the BrowserSession clipboard is empty, and the error says that a page's own Copy button does not fill it. Before, the paste typed nothing and reported success.
