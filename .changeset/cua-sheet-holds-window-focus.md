---
"@opengeni/browserd": patch
---

macOS: a sheet attached to a window (a Save panel, a close prompt, an editor sheet) now counts as that window's focus. Menus on the window, foreground keys such as Escape, and bringing the window to the front work while the sheet is up, instead of being refused because the focused window is the sheet. Foreground key delivery also makes the sheet key rather than its parent, so the keys reach the sheet even when the app was behind another one.
