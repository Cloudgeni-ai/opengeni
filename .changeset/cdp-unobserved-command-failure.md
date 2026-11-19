---
"@opengeni/browserd": patch
---

A browser closing while a CDP command or wait nobody still awaits is in flight no longer ends the browser controller, and with it every browser on the machine.
