---
"@opengeni/browserd": patch
---

Offscreen managed Chrome on a Mac with a Retina main display now presents that display at its real size. Chrome reads the screen it is given in device pixels, and the display was passed in points, so pages saw a screen half its size and smaller than the browser window (for example 864x559 around a 1280x633 viewport), a signal bot detection looks for.
