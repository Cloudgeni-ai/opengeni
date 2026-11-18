---
"@opengeni/browserd": patch
---

A browser click on an element inside a sideways-scrolling container that runs past an ancestor's clipped edge (a carousel wider than a page column that clips its overflow) now scrolls the element into view and clicks it, instead of refusing it as past the clipped edge. Chromium's scroll into view left such an element in place because it already lies inside its scroller's own box; the driver now centers it in its scrollers when nothing of it shows and nothing covers it.
