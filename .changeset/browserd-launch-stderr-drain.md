---
"@opengeni/browserd": patch
---

When managed Chrome exits during launch, the error now reliably quotes Chrome's own stderr (for example `Missing X server or $DISPLAY`). Before, the error often read the stderr log before the drain had written it and reported only the exit code.
