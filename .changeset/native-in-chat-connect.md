---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

When an agent asks for a connection in chat, the phone app now shows the same connect card as the web chat instead of a dead-end "needs to be reconnected" note. OAuth opens the system sign-in browser and returns to the conversation; key-based setup uses the native secure field; the card follows the setup's saved state, and the agent continues once the connection is ready. A first connection no longer says "reconnect". The card choice, setup state and sign-in window handling now live in renderer-neutral modules that the web and native cards share (`@opengeni/react/in-chat-connect-model`). Native approvals show app actions as the readable confirmation card the web shows, a settled approval shows a check instead of a warning, and question cards render their Markdown, help text and option descriptions as on the web. React Native's `AbortController` gains the standard abort reason and `signal.throwIfAborted()` when the runtime lacks them, which the connect flow relies on.
