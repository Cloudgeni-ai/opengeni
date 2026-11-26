---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/observability": patch
---

Restoring an archived chat from long-term storage no longer fails forever when one of its inbox updates carried accepted subscription authority (for example a background result caused by a turn accepted before a provider cutover). The restore now copies that authority record again, as when the update was first accepted. Session archive failure logs also keep the database SQLSTATE, never the message.
