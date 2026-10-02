---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
---

Record a failed scheduled occurrence when its selected model is retired, instead of retrying policy resolution without a run receipt. Preserve the selected model and replay existing receipts without accepting new execution.