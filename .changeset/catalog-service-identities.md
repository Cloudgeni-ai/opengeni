---
"@opengeni/capabilities": patch
"@opengeni/react": patch
---

Connector cards show a well-known service's own name and logo instead of its raw hostname and a letter, for example "Google Search Console" with its mark and a "Connect Google Search Console" button. The catalog overlay gains `identities` (name, logo and homepage only) for 162 services including every Google API row, generated letter placeholders from integrations.sh are screened out so the product's own monogram shows instead, and `validateLogoAsset` rejects such placeholders. The setup card no longer repeats a subtitle identical to its title.
