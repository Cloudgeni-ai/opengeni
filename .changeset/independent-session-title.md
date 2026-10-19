---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
---

Keep session title generation independent of conversation handover. Steer and cancellation no longer wait for a title or cancel it; a durable metadata operation retains the accepted provider account, request custody, usage accounting and human-title precedence across recovery.
