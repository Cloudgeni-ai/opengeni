---
"@opengeni/api-router": patch
"@opengeni/capabilities": patch
"@opengeni/core": patch
---

Disconnecting a Nango-backed Gmail, Google Calendar or Google Drive connection now also revokes the grant at Google, as for native Google connections. Deleting the connection in Nango only removed Nango's copy of the tokens. The grant is kept while another live Nango Google connection of possibly the same account remains.
