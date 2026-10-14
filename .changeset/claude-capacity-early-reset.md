---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
"@opengeni/worker-bundle": patch
---

A turn waiting for Claude subscription capacity resumes when Anthropic resets a limit early: the waiter re-reads the account's usage on a bounded schedule (at most every 30 minutes per connection) instead of sleeping until the stored reset. It resumes only when the reading reports every limit the refusal's own headers named below the limit; a refusal with an unrecognized or missing limit, or without usage headers, still waits for its stored reset.
