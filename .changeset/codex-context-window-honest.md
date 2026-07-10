---
"@opengeni/codex": patch
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Proactive context compaction now actually fires on the codex-subscription path: codex models declare their real (empirically measured) context window instead of inheriting the 1.05M global default, and the default compaction trigger moves from 60% to 90% of the declared window — compact as late as possible now that the window base is honest, with the reactive compact-on-reject ladder absorbing any overshoot.
