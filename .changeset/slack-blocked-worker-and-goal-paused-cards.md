---
"@opengeni/api-router": minor
"@opengeni/db": minor
---

Slack notifies the human when work they started stops making progress. A Slack-originated session's `child_requires_action` notice becomes one bounded pointer card ("A worker you started needs input", a single-line first-question or waiting-approval preview, and an **Open in OpenGeni** link to the child session), and a goal that pauses for `limits` or `max_auto_continuations` becomes one bounded line. Deferred child lifecycle notices, `user_pause` / `api` / `agent` / `no_progress` pauses, and `goal.resumed` stay silent. Both reuse the durable per-event post-operation ledger, so reaper retries and replica claims cannot double-post. Rolling migration `0326_slack_orchestration_delivery_events.sql` adds `system.update.pending` and `goal.paused` to the Slack delivery claim's event types, and `@opengeni/db` exports the read-only `getSessionSystemUpdateById` used to resolve the exact typed notice.
