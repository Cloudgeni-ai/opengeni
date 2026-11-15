---
"@opengeni/db": patch
---

Session event writes wait less for database locks. Session lock reads that do not use the session's stored inputs no longer fetch them, and background-command output bookkeeping now locks only its own command row instead of queueing behind, and blocking, the session's event appends. Session deletion, the only frequent holder of the exclusive workspace-control lock, is much faster because every foreign key its cascade checks now has a supporting index.
