---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Expose bounded durable recovery-backlog metrics from every control worker and alert when closed recoverable attempts remain without active ownership or a settled session projection.