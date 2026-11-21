---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Observing a computer window whose picture cannot be taken (for example while a dialog sticks out past it) now returns its elements with a note saying why there is no screenshot, instead of failing the whole observation. A window that cannot be read even when tried again is refused with its own explanation instead of a generic "workspace temporarily unavailable — retry".
