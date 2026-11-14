---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

A Business Central address is never read by dropping part of its path. An address such as `businesscentral.dynamics.com/opengenitest2026/Production`, whose first segment is neither a tenant ID nor a domain, used to connect an environment named `opengenitest2026` and ignore `Production`, so every query failed with "Environment does not exist". Such addresses, and addresses with more after the environment than a web client page, are now refused with what to paste instead: the address bar while Business Central is open, or `businesscentral.dynamics.com/<tenant>.onmicrosoft.com/<environment>`. Tenant ID or domain with environment, environment only, and `?company=` addresses work as before. `microsoftDynamicsAddressProblem` returns that explanation; `custom_mcp_setup_request` answers with it and adding such an address as an MCP server is refused with 422.

When an agent publishes a Site and its turn's account bindings can't be read, the publication is now refused with a clear error instead of declaring only the publisher's own account routes (which left the Site's tools working only for the publisher).
