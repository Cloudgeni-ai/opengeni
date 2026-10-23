---
"@opengeni/react": minor
---

`SessionApp` takes `onSessionState`: it is called with the open chat's status and the events the chat holds (`SessionViewState`) each time they change, read from the stream the chat already uses. A host can show that the agent is working, or refresh what a turn changed, without opening a second stream for the same chat.
