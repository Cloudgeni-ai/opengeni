---
"@opengeni/db": patch
---

Reading session events, history items, turns and other per-session rows no longer spends most of its database time on row-level security. Each row's session visibility check used to start a separate function executor and call several security-definer helpers, and private sessions opened a subtransaction per row. The check now runs inline, cheap conditions decide first, and the acting human's private-session memberships are resolved once per statement. Who can see what is unchanged. Reading 3,000 events of a private session dropped from about 470 ms to about 45 ms, and listing 7,000 sessions from about 255 ms to about 35 ms.
