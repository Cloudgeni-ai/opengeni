---
"@opengeni/react": minor
---

Send pressed right after a chat opens no longer does nothing. While the composer is still loading what it needs to send (the model list, a saved draft, the chat's tools or accounts), Enter or Send with a draft now waits, shown as sending, and goes out as soon as Send is allowed. Clearing the box cancels it; if something then blocks Send, that blocker shows its own message as before. A saved draft whose first read times out keeps the send waiting through its retry, and a load that never finishes ends the wait after 30 seconds with a short message instead of spinning forever. `ComposerState` has a new optional `preparing` flag for custom deliveries that want the same behaviour.

When part of the chat UI fails to download (a dropped connection or a deploy mid-load), the place it would have appeared now says so with a Reload button, in the whole chat and in single timeline items, tool rows and previews alike, instead of a Try again or "couldn't be displayed" that can't help. Lazily loaded extras inside a message (its actions, inline previews, cards) fail on their own, so the message itself stays visible.

Behaviour change for apps that embed `SessionApp`: a rendering error inside it is now contained in the app, which shows "This chat couldn't be displayed" with Try again (or Reload when code didn't download) and starts fresh when the person opens another chat or screen. Such errors no longer reach the host app's own error boundary. Wrap `SessionApp` in your own boundary only for errors outside it.
