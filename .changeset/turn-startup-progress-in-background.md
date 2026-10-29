---
"@opengeni/worker-bundle": patch
---

A turn reaches its first model request sooner. The startup progress receipts a turn writes while it prepares (credentials ready, preparing tools, tools ready, client ready, preparing the model request) no longer hold up the next startup step: each starts at once in an ordered per-attempt lane, and the model-request audit and every other awaited append or settlement still commit after the receipts issued before them, so the event log keeps the same order. A receipt that cannot be delivered no longer fails the turn; a fenced attempt is still refused by its next awaited append. Model requests are byte-for-byte unchanged.
