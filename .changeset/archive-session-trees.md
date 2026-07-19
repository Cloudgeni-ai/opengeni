---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
---

Add the canonical checksum-fenced session-tree archive manifest contract,
server-side SHA-256 helpers, and framework-agnostic SDK wire types and client
methods for archive-aware reads, planning, applying, and receipt replay. Add a
fail-closed resumable bulk operator that locally verifies plans and exact
receipt evidence while keeping operational artifacts outside the repository.