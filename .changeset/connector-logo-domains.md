---
"@opengeni/react": patch
---

Tool steps from connectors whose server lives on another host than the provider (Linear's mcp.linear.app) show the connector's logo again instead of the generic wrench. `connectorLogoIndex` and `connectorLogo` in `@opengeni/react/timeline-model` index each catalog entry under its provider domain, its connection's domain and its MCP server's host, so web, native and embedded surfaces resolve logos the same way.
