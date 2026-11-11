---
"@opengeni/runtime": patch
"@opengeni/network": patch
---

Tool search without a decision model loads each request's strongest few matches instead of one: the best match and the next ones scoring at least 0.7 of it, up to three per request, so a task's sibling tools (create a session, then message it) arrive in one search instead of one round trip each. A tie or a clause where keyword rank cannot decide now loads the close matches together rather than one guess; another connection's copy of the same operation is still left to the account notice. "Notification" now matches tools that notify. On WebSocket Responses connections, a client tool search replayed without its item id and completed status continues the previous response instead of resending the whole input.
