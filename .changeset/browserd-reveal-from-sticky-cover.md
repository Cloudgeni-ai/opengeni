---
"@opengeni/browserd": patch
---

A browser click on a target hidden under a sticky table column, a sticky header or a small fixed toolbar now scrolls the target out from under it, trying other scroll alignments, and then clicks. Before, the click was refused as covered. A layer over the whole viewport, such as a modal backdrop, is still a definite refusal, and nothing is scrolled.
