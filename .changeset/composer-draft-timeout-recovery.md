---
"@opengeni/react": patch
---

Retry timed-out composer draft reads with backoff and clear their warning after a successful refresh, including when the draft revision is unchanged. Keep draft-read failures separate from Send, Steer, and control failures, and identify draft sync timeouts in the composer message.
