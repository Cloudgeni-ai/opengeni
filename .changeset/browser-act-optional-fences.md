---
"@opengeni/sdk": minor
---

`actInBrowser` no longer requires the three causal fences. Omit `expectedTargetGeneration`, `expectedDocumentGeneration` and `expectedFrameId` to act on the tab's current document; the API reads them from the live browser in the same request instead of needing a separate target-state call first.
