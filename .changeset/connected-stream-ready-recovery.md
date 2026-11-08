---
"@opengeni/runtime": patch
"@opengeni/events": patch
---

Reattach Connected Machine command output from its retained position as soon as the exact runner or controller reconnects, instead of waiting for the silence probe. Reuses the existing operation and receipt without restarting commands, extending deadlines, or changing credential expiry.
