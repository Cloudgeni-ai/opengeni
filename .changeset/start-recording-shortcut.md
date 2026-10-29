---
"@opengeni/react": patch
---

The app has a Start recording action with its own key: ⌃⌘N on Mac, Ctrl+Alt+N on Windows and Linux. It is in ⌘K, the ⌘/ shortcut sheet and the desktop File menu, and it starts the same recording as the Meetings page's Start recording button. While a recording is going it reads "Go to recording", and a Stop recording action (no key) stops it and opens the meeting. Where nothing records meetings or the browser can't record, both are left out of ⌘K and the shortcut sheet and greyed out in the desktop File menu.

A start someone asked for outside the recorder panel, such as a desktop call notification's Record, now also starts after an earlier recording stopped or failed, as a click on Start does. A recording started with the button uses up a start still waiting, so it never begins a second one after Stop. A start without a title keeps one already typed in the panel.
