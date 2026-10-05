---
"@opengeni/db": patch
---

Sandboxes kept warm only by Browser or Computer sessions are now visible: the reaper publishes `opengeni_sandbox_leases_interaction_only{idle_bucket}` by time since the sessions were last used, and an alert fires when more than five such boxes have been idle for over two hours.
