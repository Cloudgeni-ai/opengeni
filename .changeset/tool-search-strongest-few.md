---
"@opengeni/runtime": patch
---

Tool search without a decision model loads each request's strongest few matches instead of one: the best match and the next ones from the same integration scoring at least 0.7 of it, up to three per request, so a task's sibling tools (create a session, then message it) arrive in one search instead of one round trip each. A tie within one integration now loads the close matches together rather than one guess; close matches from other integrations or connections are listed, not loaded. "Notification" now matches tools that notify, and notifying counts as sending, so a messaging tool's "send" no longer outranks the tool that notifies.
