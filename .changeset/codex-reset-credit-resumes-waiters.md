---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
---

Redeeming a Codex rate-limit reset credit now restarts chats waiting for that account within seconds. The stored usage windows read before the reset are invalidated along with the stored exhaustion deadline, so a woken waiter places on the account instead of waiting again until the old weekly reset; it no longer depends on a later live usage read.
