---
"@opengeni/browserd": patch
---

Typed text on Linux now arrives in the requested case while Caps Lock is on, instead of in inverted case while reported as sent. On GNOME Wayland (version 49 and later, which reports the locked modifiers) and on X11, each letter is sent with or without Shift so that Caps Lock turns it into the requested case; a character that cannot arrive as requested under the locked modifiers, such as a small letter while Shift is locked on GNOME, is refused with the existing "use clipboard paste" message. The Caps Lock state is never changed.

On X11, typed text also follows the active keyboard layout group: with a second layout such as Russian active, Latin text no longer arrives as the letters on the same keys in that layout while reported as sent. Text is typed on the keys that give it in the active group, or on a temporarily bound spare key, or refused with the same message. If the keyboard state cannot be read while a lock or another group is active, typing fails with the existing retryable "keyboard layout is not ready yet" message instead of sending unchecked text. On GNOME, Caps Lock stays known across a keyboard layout change.

