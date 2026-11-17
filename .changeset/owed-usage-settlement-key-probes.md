---
"@opengeni/db": patch
---

Finishing owed model-usage ledger writes no longer scans the usage ledger. The check that a recorded response is already settled now looks its completion key up in the ledger's unique index under the runtime role's row-level security, so it costs a few milliseconds per session however large the ledger is. Before, PostgreSQL could not use that index under row-level security and scanned every usage row the tenant could see for each response, which took minutes per idle, failure or worker-death boundary and could occupy every database connection of the control worker, stalling turn starts across the deployment.
