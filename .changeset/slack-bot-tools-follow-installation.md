---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Workspace Slack bot tools are listed only when the workspace has a Slack bot available, so a Slack request in a workspace without one reaches the Slack connect offer. Where a person can answer, sending a prepared bot message follows the person's own Slack send permission: Ask first asks for approval and Block blocks it.
