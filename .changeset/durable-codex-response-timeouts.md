---
"@opengeni/codex": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Make Codex subscription response timeouts recoverable without blindly replaying partially observed model work. The transport now assigns a durable request identity, records attempt-fenced start/headers/first-byte/terminal metadata, enforces explicit headers, stream-idle, and whole-request deadlines, and retries once only before any response is observed. Exhausted or partial-stream timeouts retain a typed failure class and return the durable session to its existing retryable recovery path instead of hard-failing it with the opaque OpenAI SDK `Request timed out.` error. External cancellation remains authoritative, the SDK retry budget remains disabled, and Codex subscription turns keep their existing zero-credit billing path.
