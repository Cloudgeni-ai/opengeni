---
"@opengeni/browserd": patch
---

A viewport change on a page that stays busy with its own resize work now reports that within 10 s, instead of waiting 30 s and calling a working tab unresponsive. Touch emulation is sent before the new size, so it no longer waits behind the page's resize work, and a busy page is no longer sent the change a second time.
