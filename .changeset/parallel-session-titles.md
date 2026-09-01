---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Generate pending semantic session titles in a bounded parallel model request so the main assistant response no longer waits on a title tool round trip, while retaining the serialized compatibility path for custom runtimes.
