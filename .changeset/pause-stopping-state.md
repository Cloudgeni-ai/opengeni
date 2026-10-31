---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

The stopping status clears once the work has stopped. Before, it could stay up until some later queue change, because the refresh for the event that ended it could reuse an older read still in flight. `getQueue` accepts `{ fresh: true }` to start a read no earlier than the call, and `useTurnQueue` uses it for every read that follows an observed change: events, reconnects, workspace control changes, stream opens, retries and failed mutations. In the session chrome the status stays on one line just before Activity, and on a crowded rail its words give way before the other chips do.
