---
"@opengeni/react": minor
---

Embedded conversations now show the same startup row as the Opengeni web app while a new chat's first turn starts (queued, preparing the sandbox, contacting the model), instead of a separate "Thinking…" loader that the turn's work row later replaced.

`SessionConversation` and `useSessionConversation` take a `pendingPrompt` (`{ text, sentAt }`) and accept a `null` session ID. A host whose server creates the session can render the conversation the moment the person sends, with their message and the startup row, and pass the session ID when its create call returns. It stays the same mounted conversation, so the message and startup row stay in place through the hand-over to live history, with no empty "No activity yet." frame. `OpenGeniChat` passes the first prompt the same way when it opens a chat it just created, and `CreatedConversation` now includes `sentAt`.
