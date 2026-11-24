---
"@opengeni/api-router": patch
---

A refused site-runtime request now logs which gateway check failed as `rejectionDetail` (for example `missing_headers` for unsigned traffic, `bad_signature` or `skew` for a gateway secret or clock problem), so direct probes are told apart from a real gateway fault from the API log alone.
