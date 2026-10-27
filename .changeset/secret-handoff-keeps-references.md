---
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Opengeni's own tools that store text or pass it to other work (creating sessions, messages, Steer, goals, schedules, task notes, Knowledge, instructions, artifacts, notifications, built-in Slack and social posts, and any first-party tool added later) now keep secret references as text and never receive a resolved value. The session, scheduled run or goal continuation that gets the text resolves the reference when it runs something, under its own vault policy. Escaped references still arrive as plain reference text, and a missing or malformed reference no longer fails these calls. Connectors, Codex apps, shell commands, `run_on`, browser and desktop typing and `excel_run` still receive values. An `admin_action_call` gets a value only in a request field its action marks as a credential (and in a vault item it creates or updates); the rest of its body keeps reference text. Before, a reference written into a new session's first message was resolved and the value was stored in that session.
