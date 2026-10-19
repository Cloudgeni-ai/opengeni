---
"@opengeni/browserd": patch
---

Ending a managed browser no longer takes about 30 seconds when a tab closed while the browser was still setting it up, for example a new tab whose server never answered. The browser is now asked to shut down over the controller's own connection, which that unfinished setup cannot hold up.
