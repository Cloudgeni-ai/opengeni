---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Preserve Fiken's connection-derived catalog status so session OAuth completion
can attach its tools. Distinguish connected integrations awaiting human tool
selection from connections needing reconnection, and report readiness only for
Fiken tools available in the current attempt.
