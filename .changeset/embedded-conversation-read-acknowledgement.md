---
"@opengeni/react": minor
"@opengeni/react-native": patch
"@opengeni/sdk": minor
---

An embedded conversation marks itself read while the person watches it.

- `@opengeni/react`: `SessionConversation` and `SessionConversationView` acknowledge each delivered reply, question or failure for the signed-in person while the timeline is on screen, the page is visible and the window focused (once per reply, never per streamed token, with `acknowledgedThroughSequence` so a late request never hides a newer reply). Unread state, and notifications a server derives from it, then skip replies the person already saw. A hidden timeline, background tab or unfocused window acknowledges nothing; `readAcknowledgement={false}` turns it off. `useSessionReadAcknowledgement` (from `@opengeni/react/session`) does the same for custom layouts. `createEmbeddedSessionClient` passes an optional `updateSessionAttention` through.
- `@opengeni/react-native`: the native session uses the same acknowledgement implementation, which now retries a transient failure once after a short delay and stops after a permanent rejection.
- `@opengeni/sdk`: `createSessionProxyHandler` forwards `PUT …/sessions/{sid}/attention` with only `{ unread: false, acknowledgedThroughSequence? }`.
