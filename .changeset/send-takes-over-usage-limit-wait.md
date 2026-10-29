---
"@opengeni/db": patch
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A person's message no longer waits behind a turn parked on a subscription usage limit (or an account that needs reconnecting). Sending a message now replaces the parked turn and starts right away on the model it was sent with, the same way a message replaces a pending decision. Picking another model in the composer while a turn is parked continues the chat on that model for any provider, not only Codex. A paused chat, a queued-prompt edit, and agent or machine input keep ordinary queueing. `@opengeni/react` adds `promptSendDestination`, which web, embedded and native composers use to show such a message in the chat instead of the queue.
