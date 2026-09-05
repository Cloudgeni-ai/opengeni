---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Decode bounded session-monitoring progress scalars with their persisted lossless codec version. Preserve canonical prefixes and explicit truncation without reporting encoded storage lengths as original character counts. Clarify that completion joins use the last consumed event cursor, not a session snapshot watermark that may already include an unread child result.