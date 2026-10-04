---
"@opengeni/api-router": patch
"@opengeni/core": patch
---

Connect personal Gmail accounts through Google's regular OAuth and Gmail API without depending on the hosted MCP preview. Require the configured Google Web client, the reviewed Gmail scopes, a fresh offline grant and successful mailbox verification before saving a connection. Failed reconnects preserve the previous account, and historical workspace-owned Gmail grants remain available for cleanup.
