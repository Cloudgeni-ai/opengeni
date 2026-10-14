---
"@opengeni/worker-bundle": patch
---

The artifact outbox dispatcher and materializer now say exactly why they are not ready. An unsafe database role posture names the accessible relations, the excess privileges or the wrong role, together with how to fix it. `/readyz` reports each check's own result and reason instead of marking every check failed. A readiness failure is logged once when it starts and again when it recovers. Relations owned by an installed extension, such as the PUBLIC-readable `pg_stat_statements` views, no longer make the dispatcher's posture unsafe.
