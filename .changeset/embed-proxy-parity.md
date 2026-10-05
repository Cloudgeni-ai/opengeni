---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Make the stock `OpenGeniChat` work end to end behind `createSessionProxyHandler`.

- Generated images and video, published files, and browser or computer screenshots now display in an embedded chat. Under `files` the proxy forwards a session's screenshot reads and the workspace artifact content (with `Range`) and video playback-source routes, and only for an artifact the API proves that session produced. `SessionConversation` supplies the loaders by default; `createWorkspaceRetainedArtifactLoader`, `createSessionRetainedScreenshotLoader`, and `createWorkspaceRetainedVideoLoader` are exported for custom timelines.
- The proxy's client config reports `artifacts: false` (unless `artifacts: true`), `sessionCreation`, and `archive`. Site previews show as unavailable without a request, and "New chat" and "Archive" are hidden when the proxy cannot serve them. A refused create from an older proxy shows the "New chats are not enabled" label.
- The composer microphone appears in `SessionConversation` and the new-chat composer when the deployment reports voice input available; `voiceInput={false}` opts out.
