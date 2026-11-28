---
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
---

Artifact cards show what each artifact looks like. An app's card renders the page with its own scripts at a desktop width, scaled down, in a frame that can run scripts but call nothing (no network, workspace tools or credentials); a page that draws nothing keeps its type glyph instead of a blank tile. Documents, spreadsheets and presentations show a picture of their first page, sheet or slide, from the new `GET /v1/workspaces/:workspaceId/editable-artifacts/:artifactId/preview` (`client.getEditableArtifactPreview`). `@opengeni/sdk/site-preview` builds the app preview document.
