---
"@opengeni/browserd": patch
---

Text typed on Linux X11 no longer loses or repeats characters the keyboard layout lacks (such as `ø` on a US layout or `密`) while reporting them as typed. Spare keycodes bound to such characters now stay bound for the rest of the session instead of being restored right after the action, so an application that reads the new keymap late still gets the right text; they are restored when the last session using them ends, or on the next session start after a crash. Function keys the layout lacks (F13 to F24) use the same bindings. Only when a batch needs more distinct characters than spare keycodes remain is ordinary text pasted, and the person's previous clipboard text is put back once the target has read it (it stays replaced when it held something other than text or the target did not read the paste within three seconds). A secret the layout cannot type is refused without naming the character or suggesting the clipboard.
