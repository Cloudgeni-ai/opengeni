---
"@opengeni/api-router": patch
---

When an agent acting for a person asks for something outside the access the person gave its connection, the refusal now reads "This agent's access doesn't cover this action." instead of naming the raw permission. The permission is still in the error details (`details.permission`), and refusal metrics classify it.
