---
"@opengeni/browserd": patch
---

Cleaning up after a crashed controller no longer abandons a tab it opened that Chrome still lists without an address: the tab stays recorded and a later sweep closes it once it shows it is empty.
