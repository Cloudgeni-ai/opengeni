---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Add the isolated, versioned organization/workspace/user preference registry,
including audited proposal and activation flows, deterministic attempt-bound
descriptors, authorized full-content retrieval, REST/MCP tools, and SDK types.
Attempt reads revalidate current generation and immutable-human authority in one
locked transaction; lifecycle writes use scope-version CAS and database-owned
audit functions that prevent direct head mutation or history erasure.