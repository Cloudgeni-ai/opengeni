---
"@opengeni/db": patch
---

A chat no longer stops accepting messages when a shared connector account that a voice session or an edited prompt still carries was disconnected or reconnected. The voice handoff (or edit) now runs without that account and records the gap, instead of the turn being refused and the chat being blocked on every later message.
