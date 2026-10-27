---
"@opengeni/config": patch
---

Resolve canonical model ids and aliases from one freshly constructed catalog instead of constructing it twice per provider lookup. Configuration and provider credentials remain freshly read on each call.
