---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Accept native MCP OAuth clients during dynamic registration: ignore extra RFC 7591 metadata, allow custom-scheme redirect URIs, and return a continue page after consent instead of a raw redirect that embedded browsers drop.
