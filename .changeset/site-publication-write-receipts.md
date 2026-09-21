---
"@opengeni/api-router": patch
---

Trust successful immutable Site upload writes instead of requiring immediate read-after-write visibility. Observe conditional-write winners and editable source with the existing bounded missing-object retry policy, preserve provider errors, and never replay writes during read recovery.