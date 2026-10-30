---
"@opengeni/browserd": patch
---

On macOS, background keys to the iOS Simulator now type the right characters and keep their modifiers. Typed text used to arrive on the device as "aaaa" and Cmd+V did nothing, while the call reported the keys as sent; the Simulator now gets each character's own key and real modifier presses. Text with a character that has no key on a US keyboard fails before anything is typed.

Pins CUA 473b859d, which combines the window hit test, main-window keys and Simulator keys fixes.
