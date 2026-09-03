---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/core": patch
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Replace goal-scoped long waits with self-only session-level `wait_for_input`, add provider-neutral `command_wait`, and deliver terminal background-command proof as exactly-once durable agent input with workflow wakes for nonterminal sessions while preserving event-only audit for terminal sessions.