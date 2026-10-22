---
"@opengeni/browserd": patch
---

Computer use can work macOS file dialogs in the background. A sidebar place, folder or file in an open or save panel offers `invoke`, which opens it the way a double-click does (into the folder, or choosing the file), and no longer offers `set_value`. macOS reports such an open as not completed even when it worked, so the window is read again and the action succeeds when it changed. Keys refused because a sheet or another window has the keyboard focus now say what to do instead, in batches too, and count as an invalid action rather than a driver failure.
