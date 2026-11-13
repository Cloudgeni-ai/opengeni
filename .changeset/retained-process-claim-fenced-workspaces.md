---
"@opengeni/db": patch
---

The retained-process reconciler no longer fails a whole pass when a process in another workspace becomes due while it takes its workspace fences.

- Migration 1405 makes `opengeni_private.claim_terminal_retained_processes` take the fences itself and claim only rows in the workspaces it fenced. A row that became due in between is left for the next pass.
- Before, on databases whose migration role bypasses row security (for example a superuser), such a row reached the claim's update and the session-tenancy fence trigger rejected it with SQLSTATE 55000, failing the reconcile pass.
- Same signatures, owner and grants; no runtime change is needed.
