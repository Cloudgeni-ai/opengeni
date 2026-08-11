---
name: opengeni-video-generation
description: Generate a retained video when the user asks for a new clip, animation, referenced motion, or a transformation of an existing image or video.
---

# Video generation

Use `get_video_generation_capabilities` when model or source support matters. Then call `generate_video` once for each intentionally distinct output.

- Use `text` for a new scene without reference media.
- Use `first_frame` to animate one exact opening frame.
- Use `first_and_last_frames` only when both ordered endpoint frames matter.
- Use `image_reference` for semantic/style/character guidance rather than an exact opening frame.
- Use `video_reference` to transform or continue the visual language of one existing video.
- Pass exact absolute `/workspace/...` paths. Never invent a path or pass a URL.
- Choose an explicit model only when capability discovery shows it is available; otherwise allow the workspace default.
- Treat an `accepted` result as asynchronous durable work. Continue other useful work instead of polling or calling again.
- A later platform update provides the terminal result and retained sandbox path. Never retry automatically after failure or uncertainty; a retry is another paid generation.
- Do not promise that a file exists in the sandbox until the terminal result supplies its verified path.
