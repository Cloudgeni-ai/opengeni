---
"@opengeni/worker-bundle": patch
---

Recording audio is checked for timestamp holes before it is decoded. The timeline filter fills each hole with silence in a single step and holds that whole stretch in memory, so a few-kilobyte chunk whose packets claimed a much later timestamp could make ffmpeg allocate gigabytes. Each run's packet timestamps are now read first, by a stream copy that never decodes and stops at the first bad packet. A run with a hole longer than 60 seconds (counting from time zero to its first packet), or a timeline more than five seconds and 1% past what its chunks declared, fails as `invalid_audio`, which is not retried. A prepared file that still comes out materially longer than declared also fails as `invalid_audio` instead of being stored.
