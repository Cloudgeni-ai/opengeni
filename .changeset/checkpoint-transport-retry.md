---
"@opengeni/worker-bundle": patch
---

A chat no longer fails when the context checkpoint (compaction) request is cut off: a stream that ends without a final event or times out now retries the same turn through the usual bounded provider recovery. These failures stay terminal on ordinary model requests, where a replay could repeat model or tool effects; a checkpoint request only summarizes, so it is safe to send again.
