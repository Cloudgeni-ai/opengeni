---
"@opengeni/codex": patch
"@opengeni/network": patch
"@opengeni/runtime": patch
---

A Codex WebSocket response that keeps sending only status events (such as `response.in_progress`) after the model stops making progress now fails within 10 minutes as a `progress_stream` timeout, and the turn recovers, instead of running to the 30-minute whole-request deadline. Status-only frames no longer count as progress; reasoning, output and tool-call events do. HTTP responses keep only the 5-minute silence bound. The SSE progress scanner the OpenAI-compatible idle timeout uses moves to `@opengeni/network/stream-progress` so both share it.
