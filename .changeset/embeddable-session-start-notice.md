---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Embedded chats can now explain why a message didn't start. When a shared chat still runs on someone else's personal computer and another participant's message is held, `SessionStartNotice` from `@opengeni/react/session-ui` says why in the reader's language, lists the machines they're allowed to use, and offers one recheck once the chat has moved. The saved message is kept and is never sent twice, and access rules are unchanged. `useSessionStart` and the matching model helpers are available from `@opengeni/react/session` for custom layouts, and all text comes from the new `sessionAdmission.*` message keys. The React Native session screen shows the same explanation and machine choices. The hosted app now uses these same components.
