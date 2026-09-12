---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

Add an authorized standalone session inline MCP credential rotation operation with durable idempotent receipts, exact destination and credential-version fencing, and atomic quiescence checks. Expose the operation through HTTP and the SDK without sending messages, scheduling work, retrying external mutations, or widening connection or attempt authority. Keep existing message-bound credential updates unchanged.