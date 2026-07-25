---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Add tenant-bound encrypted identity evidence and an explicit, quorum-approved organization governance recovery boundary with fail-closed managed access, atomic authority restoration, immutable audit records, and stable approval replay identities. Operators must provision the independent `OPENGENI_ORGANIZATION_RECOVERY_RECEIPT_IDENTITY_SECRET` before rolling out managed binaries and keep it stable; rotating the AES evidence key revokes envelopes but does not change exact approval retry identities.