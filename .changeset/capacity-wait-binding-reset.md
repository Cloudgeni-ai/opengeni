---
"@opengeni/subscriptions": patch
"@opengeni/db": patch
---

A subscription capacity wait now reports the reset that actually blocks, and its notification no longer promises a time that has passed. A provider quota refusal that came without a reset time got a five-hour fallback deadline even while the account's weekly allowance was spent, so the wait named that fallback, an account with extra credits was retried when it ended and refused again, and the chat stayed stuck past the time it promised. A running quota exhaustion now lasts until every usage window still spent beside it resets (`quotaExhaustionHeldByWindows`), so the wait names the earliest real reset across the eligible accounts and resumes then; a usage reading that shows the limit lifted still ends it early. The person's inbox notification for a long wait is updated in place (same key, no new alert) whenever a later check finds the wait ends later than it said, after its time passed without capacity, or that no reset time is known.
