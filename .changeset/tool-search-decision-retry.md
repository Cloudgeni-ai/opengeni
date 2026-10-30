---
"@opengeni/runtime": patch
"@opengeni/decisions": patch
---

Tool search retries its decision model once, after a 250 ms pause, when the provider answers with a rate limit, a server error or an expired sign-in, or the connection drops. Both attempts stay inside the search's 5-second selection deadline, so a brief provider hiccup no longer turns a search into a keyword-only result. Invalid answers, billing and permission refusals are not retried. A dropped connection to a decision provider now carries the error code `request_failed`.
