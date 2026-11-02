---
"@opengeni/desktop": minor
---

Dictation shows in the menu bar (the tray on Windows and Linux). While a dictation starts, listens, transcribes or has failed, the icon changes to match (a microphone, a record button, moving sound bars, a warning sign; a brief check when the text is delivered), and the tooltip and the first menu line say how it is going. The menu starts each dictation shortcut, showing its keys, and copies the last dictation again; while dictating it offers Finish and Cancel, and after a failure Retry (when possible) and Dismiss. The menu bar item now stays while dictation is on, even when this computer isn't connected. `Dictation` adds `activity()`, `onActivity()`, `menu()` and `menuAction()`.
