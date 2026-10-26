---
"@opengeni/browserd": patch
---

On GNOME Wayland, typed text is checked the way Mutter resolves it: in the active keyboard layout group and at any level Mutter can reach with Shift or AltGr. AltGr characters such as `@` on a German layout are now typed instead of refused, and Latin text is refused while a non-Latin group such as Russian is active, instead of being silently dropped. On GNOME 49 and later the active group comes from Mutter itself; on older versions text must be typeable in every group. Typing waits for Xwayland to take the session's keymap, so the first text after Xwayland starts is no longer checked against its default layout.
