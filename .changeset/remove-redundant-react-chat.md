---
"@opengeni/react": major
"@opengeni/core": patch
---

Remove the separate `@opengeni/react/chat` component. Use the existing
`SessionConversation` or compose the timeline and composer for the full agent
experience. The server-side `@opengeni/sdk/chat` wrapper and adapters remain
unchanged; their protocol requires a custom or compatible frontend.