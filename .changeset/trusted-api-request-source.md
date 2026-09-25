---
"@opengeni/api-router": major
"@opengeni/config": major
---

Key managed sign-in, sign-up, verification, and password-reset rate limits, the address recorded on auth sessions, and every other API abuse quota on one trusted request source address, with IPv6 clients keyed on their /64. Managed auth adds explicit per-client-address limits and two-tier per-email throttles (per email and address, then per email), the browser session-set sign-in returns `Retry-After` on a per-email refusal, and the managed-auth database pool keeps serving when the server closes its connections instead of crashing the API.

Breaking: `OPENGENI_API_TRUSTED_PROXY_HOPS` (optionally narrowed by `OPENGENI_API_TRUSTED_PROXY_CIDRS`) replaces `OPENGENI_MCP_OAUTH_TRUSTED_PROXY_HOPS` and `Settings.mcpOauthTrustedProxyHops` is now `Settings.apiTrustedProxyHops`. API startup and runtime-artifact generation fail while the old variable is set to anything but `0`; rename it. Managed deployments behind a proxy must now set `OPENGENI_API_TRUSTED_PROXY_HOPS`: Better Auth previously read a single-value `X-Forwarded-For` by default and now ignores forwarding headers unless the hop count is declared, so without it every user shares the proxy's address and its sign-in and sign-up limits.
