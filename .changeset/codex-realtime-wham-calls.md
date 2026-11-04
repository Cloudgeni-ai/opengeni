---
"@opengeni/codex": patch
---

Subscription voice works again. The Codex backend now answers 404 on the old `/codex/realtime/calls` path for its current voice model (`gpt-live-1.1-codex`), so calls are created at `/wham/realtime/calls`, with a per-call voice session id in the `Voice-Session-Id` header and `session.voice_session_id`, as the official Codex desktop app does. The fallback model used when the remote configuration is unavailable is now `gpt-live-1.1-codex`.
