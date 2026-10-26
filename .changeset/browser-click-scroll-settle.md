---
"@opengeni/browserd": patch
---

A browser click, double-click, hover or drag that first scrolls its element into view now waits for the page to finish reacting to that scroll before it aims. Pages often change layout once they scroll (a sticky header that shrinks, directly, on the next frame or after a short debounce), which moved the element after it was measured, so the press landed on whatever took its place and the click was refused as covered at its center although nothing covered it. The driver now waits until the element's box has not changed for 150 ms of drawn frames, at most 600 ms; an element already in view, which needs no scroll, and a hidden tab do not wait. When the element still moves away between aiming and pressing (for example the pointer's arrival collapses the panel above it), the refusal now says it moved, names what the press fell on, says the click was not delivered and that it can be clicked again, instead of calling that a cover.
