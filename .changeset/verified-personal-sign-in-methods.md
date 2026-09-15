---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Support verified-email Google and GitHub sign-in linking and personal sign-in
method management. Preserve canonical user ownership and email-verification
checks, require recent authentication for sensitive changes, prevent removal of
the last usable method, and respect explicit provider disconnection until a
verified reconnect. Surface actionable callback feedback and security
notification outcomes without granting integration access.