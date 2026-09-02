---
"@opengeni/react": patch
---

Reconcile sustained hidden-tab sessions by measuring their durable event gap: replay tiny gaps normally, append semantically small compact catch-ups in one paint, and reload the latest tail only for large or complex backlogs.
