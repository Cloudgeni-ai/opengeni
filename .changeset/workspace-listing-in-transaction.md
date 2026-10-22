---
"@opengeni/db": patch
---

Listing workspaces inside an existing transaction no longer fails when the caller has several workspaces. Each workspace's details are read in its own row-security scope, and inside a transaction those scopes were opened concurrently on one connection, where they overwrote each other's tenant settings. External actors calling `GET /v1/workspaces` hit this as a 500 with `SAVEPOINT can only be used in transaction blocks` in the database log. The scopes now run one after another inside a transaction and stay concurrent otherwise.
