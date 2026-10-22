---
"@opengeni/runtime": patch
---

Reuse the JSON already serialized for model-context inspector byte accounting when estimating its tokens. This avoids repeated schema and provider-body traversals without changing model requests, captured bodies, token estimates or persistence.
