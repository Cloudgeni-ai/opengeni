---
"@opengeni/sdk": minor
---

The relay's `beforeForwardMessage` now sees the context the browser attached to a message or voice entry, as `browserContext`, and can return `browserContext` to replace it (a string) or drop it (`null`), or refuse the action. Live voice calls the hook once per finalized transcript or spoken request, with the entry's `operationId` as `clientEventId` and its `realtimeKind`, instead of once per batch.
