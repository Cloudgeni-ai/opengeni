---
"@opengeni/browserd": patch
---

When Chrome ends a tab's debugging between an observation and the next action (another extension's frame appearing, as a password manager's menu does), the action now runs on a new attachment instead of failing with "Browser tab debugging unavailable", as long as no input was sent yet. This covers the action's pre-dispatch check of the tab and its own first reads.
