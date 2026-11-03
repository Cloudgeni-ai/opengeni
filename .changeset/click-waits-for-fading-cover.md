---
"@opengeni/browserd": patch
---

A click whose target is covered by something still animating away, such as a dialog fading out after its Close button was pressed in the same batch, waits for it to go (up to 1.5 s) instead of failing with "covered by … at its center". A cover that is not animating is still refused at once.
