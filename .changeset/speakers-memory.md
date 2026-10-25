---
"@opengeni/worker-bundle": patch
---

Speaker diarization holds a fraction of the memory it did on long meetings:
each thread embeds one piece of speech at a time, segmentation runs in small
batches, and ONNX Runtime no longer keeps a memory plan for every input
length. A two-hour meeting on four threads peaks at about 0.9 GB instead of
3.6 GB, with identical speakers and turns.
