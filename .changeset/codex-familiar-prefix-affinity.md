---
"@opengeni/codex": patch
"@opengeni/worker-bundle": patch
---

Reuse familiar Codex prompt prefixes across sessions for the same person in a workspace by separating Responses cache affinity from session identity. Keep request bodies, per-session cache keys, conversation sockets, and continuation chains unchanged.
