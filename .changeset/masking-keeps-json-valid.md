---
"@opengeni/contracts": patch
---

Secret masking no longer breaks JSON-escaped text: a masked signed-URL signature or password stops before the backslash of an escaped quote, so tool history and outputs that contain them stay valid JSON.
