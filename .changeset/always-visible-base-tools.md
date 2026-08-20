---
"@opengeni/runtime": patch
---

Make eager-vs-lazy a function of tool origin, not provider transport: the base sandbox tools stay in the first request on every path, and Browser/Computer plus `generate_image`/`generate_video`/`get_video_generation_capabilities` hide behind search on Codex and OpenAI too.
