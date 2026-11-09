---
"@opengeni/runtime": patch
---

When the model sends invalid arguments to `generate_image`, `get_video_generation_capabilities`, `generate_video` or `skill_read`, the turn no longer fails. The model gets a tool result saying the tool was not called and to correct its arguments. Errors while these tools run still end the turn as before.
