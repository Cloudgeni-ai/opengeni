---
"@opengeni/db": patch
---

A Slack callback for a bot shared across an organization can find the shared workspaces' Slack sources in one indexed lookup (`list_shared_slack_event_sources_v2`, migrations 1551 and 1552) instead of one probe per workspace. The definer is withheld from the runtime for one release, so until a later migration grants it the existing per-workspace lookup stays in use; delivery and sharing rules are unchanged.
