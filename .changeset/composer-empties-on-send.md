---
"@opengeni/react": patch
---

A message sent while the agent is working (Send under `busySend: "steer"`, or Steer) now leaves the composer in the same frame it appears in the timeline. Before, the text stayed in the box until the server answered, about one to two request times later. The send also makes one request instead of two: with durable drafts it no longer saves the draft before submitting, because the submit carries the full message and the draft revision it went ahead from, and the server keeps a newer draft from another device on its own. A save still goes first only when this page has a draft write that got no answer, when the message carries a model, effort or speed pick the saved draft does not hold yet (the chat adopts a pick only from the saved draft), or when an older server refuses the send with "draft changed" (then it saves and resubmits once under the same client event ID, and remembers to save first).

A send refused for good puts its text, files and notes back in the box when nothing new was typed meanwhile; otherwise the new typing stays and the message waits in the timeline with Retry and Restore. An unconfirmed send stays in the timeline and its retry repeats it with the same key. A queued Send that fails no longer lets autosave write its emptied box over another device's newer draft.
