---
"@opengeni/browserd": patch
---

On macOS and Linux computer use, refs now carry over between two readings of the same page after an action opened it. Whether two readings show the same document was judged by the window's listed title, which still names the previous page until the windows are listed again, so the reading after a navigation and the next one compared unlike and every ref of the new page changed: an action naming a ref from the action's own receipt failed as stale although the element had not changed. Readings now compare the title of the window element they carry themselves, and fall back to the listed title when they carry none. A window that shows another document still keeps none of its refs.
