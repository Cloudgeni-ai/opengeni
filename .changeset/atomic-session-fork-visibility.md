---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Add atomic same-workspace session forks with an explicit private or workspace destination. Private-to-workspace copies require a durable acknowledgement, workspace members may fork a shared source into fresh authority of their own, and private sources remain owner-only. Exact applied receipts remain recoverable by the same live workspace actor after mutable source authority changes, while changed requests conflict and fresh keys still require current source authority. Every fork receives fresh authority, provenance, root, and sandbox-group identity without inheriting live grants, credentials, Connections, turns, goals, MCP, resource attachments, processes, or pins. The managed web control now exposes the generic Fork dialog to authorized shared-session members and verifies the returned owned destination before navigation.
