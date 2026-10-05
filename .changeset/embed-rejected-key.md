---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

An expired or revoked server API key no longer shows end users a raw `OpenGeni API 401: authentication required` message. `OpenGeniChat` and `SessionConversation` in `baseUrl` mode now say "Chat is unavailable right now. Ask an administrator for help." (other load failures use the same brand-neutral copy as the rest of the UI), and the session proxy logs one server-side warning telling the developer to create a new key and update `OPENGENI_API_KEY`.
