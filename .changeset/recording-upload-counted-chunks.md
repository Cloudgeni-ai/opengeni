---
"@opengeni/sdk": patch
---

A phone recording no longer loses a chunk at the end. The native recorder writes each chunk file before the recorder counts it, so the background upload could send a chunk and remove it before the recorder read it. That recording was then finalized one chunk short. While a recording is capturing, the upload now sends only chunks the recorder has counted.
