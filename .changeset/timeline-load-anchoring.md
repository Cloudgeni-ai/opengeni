---
"@opengeni/react": patch
---

Session load and backfill no longer flicker: the timeline stays invisible until its first bottom-anchored frame (a flash of the window top is structurally impossible), rows decide at mount whether they animate so bulk paints never replay entrance animations across the timeline, the scroller disables native browser scroll anchoring (it fought the reader-anchor corrections during backfill), and programmatic scroll echoes can no longer unpin the bottom-follow (which could strand the view just short of the bottom).
