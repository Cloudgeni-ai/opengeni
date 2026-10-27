---
"@opengeni/react": patch
---

Send pressed right after a chat opens no longer does nothing. While the composer is still loading what it needs to send (the model list or a saved draft), Enter or Send with a draft now waits, shown as sending, and sends once it is ready. `ComposerState` has a new optional `preparing` flag for custom deliveries that want the same behaviour.

When part of a chat fails to download (a dropped connection or a deploy mid-load), the chat now says so with a Reload button instead of a Try again that can't help, and `SessionApp` contains such failures inside the app rather than blanking the host page.
