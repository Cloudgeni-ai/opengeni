---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Retain failed scheduled occurrences when connection-account selection blocks
dispatch. Run history includes structured connector/account identifiers and
safe eligibility reasons without credential values or raw error messages.
Replaying an occurrence retains its original outcome without admitting work.