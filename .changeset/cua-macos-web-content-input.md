---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

On macOS, the controls of a web page in Chrome or another Chromium app can be invoked again: Chrome lists no press action on page elements in the accessibility mode Opengeni enables, so buttons, links, checkboxes and similar page controls showed no actions and invoking them was refused. A pointer click on a background browser tab, or on a checkbox whose value does not change from the accessibility press, is now sent as a pixel click instead of being reported as done while nothing happened. A keyboard shortcut whose menu item macOS keeps disabled while the app is in the background (Terminal's Close Window) reports that it most likely did nothing, instead of completing. A pointer click, key press or typed text after which no element of the window changed now says that it may not have taken effect, since apps do not confirm the input they receive.
