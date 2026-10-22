---
"@opengeni/worker-bundle": patch
---

A retried context checkpoint request keeps its cause. Each retry, and the failure after the retries run out, now records the checkpoint diagnostics (transport code, status and request), and for a timeout its timeout class, request and whether a response arrived, so the session reports an unresponsive provider instead of a generic outage.
