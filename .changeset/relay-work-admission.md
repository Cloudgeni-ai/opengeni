---
"@opengeni/sdk": minor
---

`createSessionProxyHandler` gives products the hooks they need to keep their own rules beside the relay instead of a forwarder of their own:

- `beforeForwardMessage` now runs for every browser action that starts model work: besides messages and voice, `resume` (`POST sessions/{id}/control` with `action: "resume"`), `retry` (`POST sessions/{id}/retry`) and `queue-steer` (`POST sessions/{id}/queue/{turnId}/steer`). Their MCP credential rotations are applied to the chat before forwarding. Its input carries the browser's action key as `clientEventId` (`idempotencyKey` on create), so a product's billing or context can be keyed the way Opengeni deduplicates.
- Changed: approval decisions and human-input answers reach `beforeForwardMessage` as `delivery: "approval"` and `"answer"` instead of `"send"`. A hook that returns MCP credentials only for `"send"` must now also return them for these.
- New `afterForward(route, response, context)` sees Opengeni's answer to every forwarded request in the workspace before the browser does, to record what the product keeps beside Opengeni (an upload's owner, a new chat's id, activity), and may return a different `Response`.
- Every hook finds the route it acts on in `context.route` (`{ method, segments, sessionId }`), so `authorizeSession` can tell reads from changes.
- When the hop to Opengeni fails or answers 408 or 5xx for an action the relay read that carries a key, the relay sends it once more; Opengeni answers a repeated key with the first outcome. Streamed bodies and unkeyed actions are never resent.
- With `modelSelection: false`, a retried turn's `model`, `reasoningEffort` and `latencyMode` are removed, as on messages.
