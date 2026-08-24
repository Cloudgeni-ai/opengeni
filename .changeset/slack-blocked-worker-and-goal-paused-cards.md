---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Slack can notify the human when work they started stops making progress, **off by default and switched on per workspace**. The new `slackOrchestrationNotices` workspace setting carries one boolean per notice (`childRequiresAction`, `goalPaused`), two checkboxes sit beside the reaction shortcut in the Slack integration settings, and `resolveWorkspaceSlackOrchestrationNoticeSettings` fails closed: absent, malformed, or partially invalid settings resolve to both disabled, so only an explicit opt-in ever posts. An unsolicited Slack post is worse than a missed one, and the in-app rail and priority feed already surface this work.

When a workspace opts in, a Slack-originated session's `child_requires_action` notice becomes one bounded pointer card ("A worker you started needs input", a single-line first-question or waiting-approval preview, and an **Open in OpenGeni** link to the child session), and a goal that pauses for `limits` or `max_auto_continuations` becomes one bounded line. Deferred child lifecycle notices, `user_pause` / `api` / `agent` / `no_progress` pauses, and `goal.resumed` stay silent. A disabled notice takes the same "nothing to post for this event" path as an undeliverable one - no post, no ledger row, and the delivery cursor advances identically - and every pre-existing Slack card type is unaffected. Both reuse the durable per-event post-operation ledger, so reaper retries and replica claims cannot double-post. Rolling migration `0328_slack_orchestration_delivery_events.sql` adds `system.update.pending` and `goal.paused` to the Slack delivery claim's event types, and `@opengeni/db` exports the read-only `getSessionSystemUpdateById` used to resolve the exact typed notice.
