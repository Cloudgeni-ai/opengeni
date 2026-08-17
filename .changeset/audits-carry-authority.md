---
"@opengeni/db": minor
---

Connection-use audit facts record the frozen causal initiator and session authority epoch/visibility/owner of every authorized or denied use, and variable-set materialization/secret-read audit events carry the causal human, attempt authority triple, and owner authority identity (migration 0280). Variable-set authority denials are now recorded as metadata-only audit facts from a fresh transaction while the fail-closed rejection is preserved.
