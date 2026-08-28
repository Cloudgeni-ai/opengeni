---
"@opengeni/react": patch
---

Harden live and historical session timelines: preserve reader ownership through cumulative pointer movement and animated layout shrink, keep bidirectional history windows density-bounded and compact-cursor correct, schedule large window swaps without blocking the browser, and prevent unmatched tool outputs from settling unrelated calls.