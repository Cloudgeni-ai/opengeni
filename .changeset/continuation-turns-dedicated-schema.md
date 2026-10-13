---
"@opengeni/db": patch
---

Continuation turns (goal continuations, wake-ups, command and child results) insert again on installs whose tables live in a dedicated schema: migration 0756 replaces 0755's hard-coded `public.session_turns` lookups with the install's own schema. The legacy Codex pin fallback now applies only to shared people-scoped connections of the same provider, so another person can no longer pin someone's personal connection.
