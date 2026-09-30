---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Agent links to OpenGeni objects now work inside an embedding product. `artifact:` files download by default from `SessionConversation`; sandbox-path downloads require explicit proxy `sandboxFiles: true` and use bounded, no-symlink reads within the session working directory. Editable artifacts and Sites route through a new `resolveLink` prop (`MessageTimeline`, `SessionConversation`, `Markdown`, `OpenGeniLinkProvider`) instead of rendering console paths that 404 on the host origin. Invalid reserved references render unavailable. `parseOpenGeniLink` in `@opengeni/sdk` classifies the same hrefs for non-React clients and preserves validated console return hints. Editable-artifact export uses configured exporter capabilities and preflights the exact format and options before creating a snapshot or pinning a version. Stock deployments serve spreadsheet XLSX; the artifact Skills stop promising unsupported PDF/DOCX/PPTX exports.
