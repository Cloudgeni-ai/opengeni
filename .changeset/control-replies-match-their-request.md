---
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

A Connected Machine control request now accepts only the reply that names it. `NatsControlRpc` compares the reply's `requestId` with the request it sent, on every request path and on the delivery-token negotiation probe; a reply for another request, or for none, is refused as a malformed response instead of being returned as the result, and a probe answer that names another probe issues no tokens and no longer turns the subject into one-shot delivery. Before, only file transfers checked this.

The compute agent gateway now forwards a sandbox agent's publish to an `_INBOX` subject only when it answers a request the gateway delivered to that same session and that has not been answered yet, and only once. Publishes within the agent's own subject scope are unchanged.
