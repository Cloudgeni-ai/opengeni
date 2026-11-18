---
"@opengeni/browserd": patch
---

Two macOS computer-use fixes from the pinned CUA driver. A batch step that asks for desktop scope (a drag, click or scroll in desktop screenshot coordinates, keys to the frontmost app) no longer inherits the window an earlier step used, which turned it into a window-scoped action at the wrong coordinates. A slider or other control whose accessibility value reads as NaN is now treated as unreadable: setting its value no longer falls back to stepping it with up to 500 decrement actions (NaN never equals the last reading, so every step looked like progress), which could run the control to its minimum while reporting that nothing changed.
