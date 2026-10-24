---
"@opengeni/desktop": patch
---

The page keeps keyboard focus when the window becomes active again. On macOS, after the app was hidden or the display slept, the page's first keystrokes were lost, so the first Control+Tab jumped straight to the next chat instead of showing the chat switcher.
