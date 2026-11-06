---
"@opengeni/db": patch
---

A session's full access now applies only to turns the person who gave it caused: their own messages, and continuations (goals, schedules, child results, inbox deliveries) whose recorded causal person is them. In a turn another workspace member caused in the same shared chat, `resolveSessionAppActionAuthority` resolves exactly as it would without full access, to that member's own confirm or read-only app actions, and the session tools refuse chats in the granter's other workspaces. The tool listing still follows the session's grant, so it doesn't change between turns.
