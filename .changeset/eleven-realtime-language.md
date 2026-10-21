---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Eleven Realtime now listens and replies in the person's language instead of guessing. The voice conversation follows the app language (or the browser's) by default, and the voice model menu has a Language page to pick another one. Realtime controllers accept `getLanguage`, the WebSocket connect request takes an optional BCP 47 `language`, catalog entries for models that need a fixed conversation language list their `languages`, and `@opengeni/react` exports `useRealtimeLanguagePreference`, `realtimeConversationLanguage` and `realtimeAppLanguage`.
