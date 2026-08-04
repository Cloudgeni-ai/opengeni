---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Make Connected Machine project paths portable and diagnosable: session responses now expose `workingDir`, and the native agent consistently supports the service user's `~` path across exec, filesystem, git, and terminal operations while reporting missing working directories accurately.