---
"@opengeni/react": patch
---

Loading older session history no longer tears down and reopens the live event stream. Rows that arrive while an older page is in flight append once, in order, onto the prepended window, and the connection state stays `live` (no "Connecting…" flash or repeated session reconciliation on every scroll-up). The stream still closes when a full backward page evicts the live tail and the timeline enters history mode.
