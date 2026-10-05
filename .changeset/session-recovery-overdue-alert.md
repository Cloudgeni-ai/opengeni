---
"@opengeni/db": patch
---

The durable recovery monitor now reports how long the single oldest recovering session has been past its recorded recovery due time (`summarizeSessionRecoveryBacklog`), and how many recovering sessions are still inside their recorded provider Retry-After or connectivity backoff. `OpenGeniSessionRecoveryBacklogStale` pages only when one session stays more than 10 minutes past due, so sustained provider rate limits that keep some session in backoff no longer page.
