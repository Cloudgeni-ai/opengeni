---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/config": patch
---

Connector catalogs no longer offer connectors that cannot connect on the current deployment. Some providers refuse OAuth self-registration (Asana, HubSpot, Front, Box, Dropbox, Canva, Vercel, and others). When the deployment has no operator-registered OAuth client for such a provider, the catalog reports `runtime.operatorOAuthClient.configured: false` and connector discovery hides the row. Rows that are already connected stay visible.
