---
"@opengeni/capabilities": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Connector cards show a well-known service's own name and logo instead of its raw hostname and a letter, for example "Google Search Console" with its mark and a "Connect Google Search Console" button. The catalog overlay gains `identities` (name, logo and homepage only) for 164 services including every Google API row, and generated letter placeholders from integrations.sh are screened out so the product's own monogram shows instead. `validateLogoAsset` rejects such placeholders when called with `rejectGeneratedPlaceholder` (the catalog import and vendoring paths); a custom MCP server's own declared icon is accepted as before. A re-import clears a stored catalog logo once its row has no logo by policy (`RegistryCapabilityCatalogItemInput.clearLogoAsset`). The setup card no longer repeats a subtitle identical to its title. The SharePoint and OneDrive setup cards show their Microsoft marks instead of a letter, like Teams and Outlook already did.
