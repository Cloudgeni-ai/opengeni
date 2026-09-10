---
"@opengeni/runtime": patch
"@opengeni/storage": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Spool Linux host-backed workspace archives through capture, object storage, and cold restore instead of materializing whole JSON/base64 payloads. Isolate each upload at a fresh physical locator and verify stored bytes without assuming conditional-PUT support. Preserve legacy locators, archive format, configured restore limits, and lease capture/publication authority; retain candidates after ambiguous publication outcomes.