---
"@opengeni/browserd": patch
---

On macOS, the buttons and fields of a bubble a window shows (Chrome's "Save password?", translate, site permission and download bubbles) can now be used through that window, instead of every action on them being refused: invoke and set_value on their refs work, while pointer and key input to them is refused with a message saying so, since it would land on the page under the bubble. An element of another window of the app is still refused, and the failure names that window when it is a target that can be observed.
