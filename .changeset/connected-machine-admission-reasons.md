---
"@opengeni/runtime": patch
---

Distinguish Connected Machine self-update drains and admission breakers in errors instead of labeling every refusal as capacity exhaustion. Preserve typed reasons through retry exhaustion without changing retry or execution behavior.