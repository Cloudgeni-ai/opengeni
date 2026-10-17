---
"@opengeni/browserd": patch
---

A browser screenshot taken right after a viewport change now shows the new viewport. Chromium applies a device-metrics override asynchronously, so on a busy machine the next capture could still return the previous surface (for example a 1280px frame after switching to a 390px phone viewport). The viewport action now waits, bounded, for the page to present a frame at the new size, and a viewport capture of an emulated device retries briefly until the surface has the emulated size, publishing what it has after 1.5 s at most.
