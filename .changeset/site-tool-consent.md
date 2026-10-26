---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/contracts": minor
---

Sites can now run tools that need approval. When a Site you view in Opengeni calls one, for example Gmail "Send message", Opengeni asks you around the Site: what will happen, from which of your accounts and to whom, with Send and Cancel, plus "Always allow for this Site". The call always uses your own account. `createSiteToolBridge` accepts `confirmToolCall` and `connectForToolCall` for hosts that show this confirmation.
