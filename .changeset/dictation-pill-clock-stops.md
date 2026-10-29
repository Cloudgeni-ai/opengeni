---
"@opengeni/desktop": patch
---

The dictation pill's clock now stops when the pill goes away. After a dictation was cancelled or finished, the hidden pill kept its recording clock ticking four times a second until the next dictation, which kept the app waking up for nothing. Hiding the pill now empties it as well.
