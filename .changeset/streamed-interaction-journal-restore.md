---
"@opengeni/interaction": patch
---

Accept synchronous iterables when restoring operation journals, allowing controllers to recover durable receipts without retaining every observation graph in memory at once. Existing array inputs remain supported.
