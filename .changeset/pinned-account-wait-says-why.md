---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/subscriptions": patch
"@opengeni/worker-bundle": patch
---

A chat pinned to one subscription account now says so when it waits for that account. The chat keeps honouring the pin: its turn still waits for the chosen account and never moves to another one by itself. But the wait no longer tells people to switch the chat to another model, which did not help, because the pin holds whatever the model.

- The composer shows "This chat is pinned to the Claude account “Team”, which is out of capacity. Resets Sat 18:00." with one button, **Use automatic account choice**. It switches the chat back to automatic account choice through the existing session account choice (`connectionId: null`), which applies to the waiting turn, so it continues at once on another account. People who can't manage the chat are told who can. A turned-off or no-longer-eligible pinned account gets the same notice and button.
- The timeline keeps the wait's own explanation instead of the generic "switch to another model" line.
- The person's inbox notification is titled "Chat waiting for its pinned Claude account", names the account and when it has room again, and offers automatic account choice instead of a model switch. It is still sent once per waiting turn and updated in place when what it said changes.
- A worker's parent agent is told the same, with the `setSessionModelAccount` action (`connectionId: null`) as the way to let the worker continue, instead of `session_set_model`.

The account is named by its label only when the label is not an email address. The internal wait field that named an account needing a new sign-in is now `waitAccount` (type `SubscriptionWaitAccount`; `SubscriptionReconnectAccount` remains as a deprecated alias) and also names a pinned account.
