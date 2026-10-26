---
"@opengeni/browserd": patch
---

Typed text on Linux now arrives in the requested case while Caps Lock is on, instead of in inverted case while reported as sent. On GNOME Wayland (version 49 and later, which reports the locked modifiers) and on X11, each letter is sent with or without Shift so that Caps Lock turns it into the requested case; a character that cannot arrive as requested under the locked modifiers, such as a small letter while Shift is locked on GNOME, is refused with the existing "use clipboard paste" message. The Caps Lock state is never changed.

