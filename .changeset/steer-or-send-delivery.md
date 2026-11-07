---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

With `busySend: "steer"`, a message sent while a turn runs now always reaches that turn, even when the client's copy of the session is a few seconds behind. The composer used to pick Steer or Send from its own view of the session, so a Send right after a turn started could be queued and answered only after the turn finished. It now submits the new `delivery: "steer_or_send"` (accepted by `steerMessage` and draft submits), and the server resolves it under the same locks that start and settle turns: it steers a running or just-starting turn, starts a turn when the session is idle, and queues without resuming when it is paused. Only the resolved `steer` or `send` is recorded, so nothing the model sees changes. Exact retries replay the first decision. Plain `send` and explicit Queue are unchanged, and the composer falls back to its own choice against a server without `steer_or_send`.
