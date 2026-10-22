---
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Ride out API rolling deploys and short network blips quietly. The SDK client now retries safe JSON reads (`GET`/`HEAD`) that fail with a transport error or a `502`, `503` or `504`: up to 4 attempts within 5 seconds with jittered backoff, honoring `Retry-After`. Tune it with the new `readRetry` client option or turn it off with `readRetry: false`; mutations are never retried. `isTransientRequestError` is exported for callers with their own retry loop.

In the console, session, session list and workspace reads, the session event stream and the session lookup page keep showing the loading state or the last loaded view through a transient failure and retry on their own, with no error toast. Only a failure that lasts more than 20 seconds shows an error, once, with a Try again action, and the page keeps retrying in the background and recovers by itself.
