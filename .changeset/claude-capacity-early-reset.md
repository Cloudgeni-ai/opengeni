---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
"@opengeni/worker-bundle": patch
---

A turn waiting for Claude subscription capacity resumes when Anthropic resets a limit early: the waiter re-reads the account's usage on a bounded schedule (at most every 30 minutes per connection) instead of sleeping until the stored reset, and resumes only when the reading confirms the limit that refused it has ended.
