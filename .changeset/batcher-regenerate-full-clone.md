---
---

Merge batcher: regenerating a queued PR's conflicting generated files works again. It now checks out every file's contents, because in a blobless clone the merge's checkout asked GitHub for blobs the merge had just written, and failed.
