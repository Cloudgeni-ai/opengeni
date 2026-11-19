---
"@opengeni/api-router": patch
---

Console test workspace access follows Console roles: the membership a test chat creates only starts and reads chats (never `workspace:admin` or `agents:manage`), it is removed whenever a person's Console access drops below Editor (role change, an owner or admin made a member, offboarding), a failed removal answers a retryable 503 `console_access_cleanup_failed`, and an organization agent chat in the test workspace needs Editor access when it starts.
