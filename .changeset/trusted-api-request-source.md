---
"@opengeni/api-router": patch
"@opengeni/config": patch
---

Key managed sign-in, sign-up, verification, and password-reset rate limits, the address recorded on auth sessions, and every other API abuse quota on one trusted request source address. `OPENGENI_API_TRUSTED_PROXY_HOPS` replaces `OPENGENI_MCP_OAUTH_TRUSTED_PROXY_HOPS` and now applies to all of them, optionally restricted to a connecting proxy inside `OPENGENI_API_TRUSTED_PROXY_CIDRS`; forwarded client addresses stay ignored by default. Managed auth adds explicit per-client-address limits and per-email throttles, and the managed-auth database pool keeps serving when the server closes its connections instead of crashing the API.
