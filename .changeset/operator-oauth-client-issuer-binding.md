---
"@opengeni/api-router": patch
---

MCP OAuth now uses a client from `OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON` only for the authorization server whose metadata it actually fetched. Previously the `issuer` named inside that metadata could also select an operator client, even when it differed from the server that served it. An entry now matches the fetched authorization server URL, or an issuer equal to it apart from a trailing slash. The OAuth callback applies the same rule. Providers whose metadata issuer matches their authorization server are unaffected.
