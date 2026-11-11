---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A sub-agent failure that its parent agent has already received no longer shows a red dot or an "unread failures" count on the parent's sidebar row, hover card, project totals or Needs you, and nothing the failed session logs afterwards counts as unread there either. Failures nobody took on still show: a top-level chat that fails, a failure whose notice its parent has not consumed, or a sub-agent that fails again after a retry. Sessions carry a new optional `failureHandled` flag.
