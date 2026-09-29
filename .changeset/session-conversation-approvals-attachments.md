---
"@opengeni/react": minor
---

`SessionConversation` now renders pending tool approvals with Approve/Reject
actions, wires composer file attachments into sent messages when the
deployment enables file uploads (opt out with `attachments={false}`), and
accepts a `toolRegistry` for product-specific tool-call rendering.
