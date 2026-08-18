---
"@opengeni/db": minor
---

The API-direct session-attach variable-set materialization lane (viewer attach and direct channel operations cold-creating a box) now records the accepted subject and a `variable_set.materialized` audit fact with the live session authority tuple (migration 0282, rolling; unchanged function signature). Attribution flows through the standard request-context GUCs; an old image that sets no subject records the explicit `service:session` sentinel. Denials keep their fail-closed raise-and-rollback semantics.
