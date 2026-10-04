---
"@opengeni/contracts": patch
---

Preserve recorded prior-window monetary totals when model-call facts are missing. Insights prior measures may contain charged or list micros with zero recorded calls and zero coverage; only truly empty priors must be null. UTC zero-length-window rules remain unchanged.