---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

computer_observe without a targetId on a computer the agent has not used yet starts in its focused window, or its only screen when no window is focused, instead of failing. Actions still need a window the agent has seen or named.

On macOS, Windows and isolated Linux desktops, the frontmost ordinary window (highest stacking order, menus and overlays aside) is now marked focused in computer targets.
