---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Pause shows that the current work is stopping as soon as the server accepts it, and the status clears once that work has stopped. Before, it could stay up until some later queue change, because the refresh for the event that ended it could reuse an older read still in flight. `getQueue` accepts `{ fresh: true }` to start a read no earlier than the call, and `useTurnQueue` uses it for event refreshes. `useComposer` takes the queue snapshot's `stoppingPreviousAttempt` and returns `stoppingAttempt: "current"` after a Pause that interrupted running work. In the session chrome the status reads "Stopping current work" or "Stopping previous work" on one line just before Activity, and on a crowded rail its words give way before the other chips do.
