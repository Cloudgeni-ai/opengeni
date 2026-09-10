---
"@opengeni/runtime": patch
"@opengeni/storage": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Spool Linux host-backed workspace archives through capture, object storage, and cold restore instead of materializing whole JSON/base64 payloads. Preserve the existing archive format, integrity verification, configured restore limits, and lease capture/publication fences.