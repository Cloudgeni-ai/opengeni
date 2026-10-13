---
"@opengeni/react-native": minor
---

Links in native timelines, notes and previews can open inside the host app. `OpenGeniReactNativeAdapters` takes an optional `links: { openUrl(url) }` adapter, and the new `useOpenNativeLink()` hook returns it, falling back to `Linking.openURL`. `useNativeAgentCall().callSession(sessionId, workspaceId?)` now accepts the session's own workspace, for sessions opened outside the current one.
