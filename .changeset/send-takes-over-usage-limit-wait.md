---
"@opengeni/db": patch
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A person's message no longer waits behind a turn parked on a subscription usage limit (or an account that needs reconnecting). Sending a message now replaces the parked turn and starts right away on the model it was sent with, the same way a message replaces a pending decision. A paused chat, a chat held by used-up Opengeni allowance or credits, a queued-prompt edit, and agent or machine input keep ordinary queueing. `@opengeni/react` adds `promptSendDestination`, which web, embedded and native composers use to show such a message in the chat instead of the queue; the console keeps Pause available while a turn is parked.
