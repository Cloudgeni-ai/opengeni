---
"@opengeni/browserd": patch
---

On macOS, a computer-use batch whose earlier action closes or hides its window (a start screen's Cancel) can still open the app's menu in a later action: an accessibility action on an item of the app's menu bar no longer depends on the batch's window. A later action on an element of a window that is no longer on screen is refused before anything is sent, reported as not run rather than with an unknown outcome, and the refusal says to act on one of the app's windows that is shown. A later action looked up by role and name in such a window fails the same way at once, instead of after its whole wait. A focus action on a macOS window now brings it to the front and confirms it there, instead of being unsupported.

Pins CUA bc18cf52 (`cu-menu-bar-after-window-closes` merged with `cu-office-menus` 24a0726f).
