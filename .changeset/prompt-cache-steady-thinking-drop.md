---
"@opengeni/contracts": patch
---

Prompt-cache warm-miss diagnostics no longer label a miss `thinking_dropped` just because Claude dropped signed thinking blocks. A long conversation can drop the same old blocks on every request, including warm hits, which leaves the prompt unchanged; such misses were hiding plain cache expiries. The class now needs more blocks dropped than for the previous call, so a steady drop count falls through to `account_changed`, `idle_gap` or `unexplained`.
