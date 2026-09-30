---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Artifacts and Sites now work inside an embedding product with the same components the OpenGeni console uses. `@opengeni/react/artifacts` gains the console's inline Site/HTML preview (`ChatInteractiveBlock`, `ArtifactSandbox`, `DeferredChatMedia`), `SiteView`, `EditableArtifactView`, and a host-mountable `SessionArtifactViewer`; `SessionConversation` renders `opengeni-site` fences inline and opens agent artifact links through `onOpenArtifact` (`viewerLinkResolver` for a custom timeline). `createSessionProxyHandler({ artifacts: true })` serves only the artifacts OpenGeni lists for the requesting session (read, editor live ticket, Site detail and sandboxed HTML), and client config advertises the live socket URL and browser cache partition. The SDK client adds `withHeaders`, `apiUrl`, and `fetchApi` for host-authenticated transports. Every built-in artifact string is translatable through a `labels` prop (partial `ArtifactLabels`) on `SessionArtifactViewer` and `ChatInteractiveBlock`, or `ArtifactLabelsProvider`. The conversation's "Jump to latest" pill now sits below the transcript instead of floating over the last row. Document and presentation editors compose one projection at a time, so opening an artifact with a long history no longer floods the artifact Worker's request queue.
