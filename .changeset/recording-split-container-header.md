---
"@opengeni/worker-bundle": patch
---

A recording whose container header is split across its first chunks is now transcribed instead of failing as unreadable audio. Chromium sometimes hands out the first byte of a WebM recording on its own, before any audio has arrived, and the rest of the header in the next chunk; the worker required the whole header in the first chunk, so such a dictation or meeting failed with `invalid_audio`. A chunk too short to tell whether a header starts there is now held and judged together with the chunks after it, both at the start of a track and at a later capture session.
