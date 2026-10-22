---
"@opengeni/react": minor
---

Embedded conversations now show the same startup row as the Opengeni web app while a new chat's first turn starts (queued, preparing the sandbox, contacting the model), instead of a separate "Thinking…" loader that the turn's work row later replaced. `PendingConversation` renders that same view for a prompt whose session the host is still creating, so a host can show it the moment the person sends and swap in `SessionConversation` once the session exists, with no second loading style in between.
