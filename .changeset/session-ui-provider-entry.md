---
"@opengeni/react": patch
---

`@opengeni/react/session-ui` exports `OpenGeniProvider` and the tool-renderer
registry (`createDefaultToolRegistry`, `createToolRegistry`,
`defaultToolRegistry`), so a host can render `OpenGeniChat` or
`SessionConversation` from that entry alone without the root's optional
workbench peers.
