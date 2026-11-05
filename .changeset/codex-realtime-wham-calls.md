---
"@opengeni/codex": patch
---

Subscription voice calls are created at `/wham/realtime/calls`, with a per-call voice session id in the `Voice-Session-Id` header and `session.voice_session_id`, as the official Codex desktop app does. The fallback model used when the remote configuration is unavailable is now `gpt-live-1.1-codex`.
