---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

An idle sandbox drain no longer piles up workspace captures. When a capture outlives the drain snapshot budget, a retry in the same worker now waits for it instead of starting another full read and temporary spool of the same box. The slow capture still publishes late and the box then drains. Host-backed captures also stop promptly when aborted during the archive re-read and verification passes.
