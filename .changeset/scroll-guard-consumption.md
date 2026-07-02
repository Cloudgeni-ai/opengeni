---
"@opengeni/react": patch
---

A no-op pinned-follow scroll assignment left the programmatic-scroll mark set (no scroll event fires to consume it), which made the reader's next real scroll-up read as programmatic and get eaten — the view snapped back to the bottom and upward backfill could never engage. The mark now self-clears when an assignment doesn't move the scroller.
