---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
"opengeni-web": patch
---

Distinguish scheduled runs skipped because their chat is paused from busy-chat overlap, and show the reason and recovery action on the schedule. Explain explicit model-account pins that are turned off for allocation instead of presenting them as temporary quota waits. Reclassification of an existing capacity waiter appends a new, deduplicated status event without changing earlier context, resuming paused work, or replacing an account pin.
