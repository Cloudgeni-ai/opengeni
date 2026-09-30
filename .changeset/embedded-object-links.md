---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Agent links to OpenGeni objects now work inside an embedding product. `artifact:` files and `sandbox:` files download by default from `SessionConversation` (the session proxy gains a bounded `fs/read` route, `sandboxFiles: false` to disable), and editable artifacts and Sites route through a new `resolveLink` prop (`MessageTimeline`, `SessionConversation`, `Markdown`, `OpenGeniLinkProvider`) instead of rendering console paths that 404 on the host origin. `parseOpenGeniLink` in `@opengeni/sdk` classifies the same hrefs for non-React clients. The editable artifact export tool now lists the formats the deployment serves (spreadsheet XLSX) and refuses any other pair with that list before pinning a version, and the artifact Skills stop promising PDF/DOCX/PPTX exports.
