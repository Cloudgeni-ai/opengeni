---
"@opengeni/browserd": patch
---

macOS computer-use key combinations (such as cmd+s) go through CUA's hotkey, so a menu shortcut sent to a background app runs its menu item instead of being silently dropped; a refusal because macOS disables the item in the background is reported as unsupported.
