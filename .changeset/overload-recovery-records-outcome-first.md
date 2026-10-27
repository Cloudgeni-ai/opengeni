---
"@opengeni/worker-bundle": patch
---

A turn hit by a provider overload or server error in the middle of a streamed response now recovers on its own again, instead of sometimes stopping with "couldn't be retried automatically" or "an earlier request has an unresolved outcome". The stream reader cancels the response without waiting when it sees the error event, so failure handling could read the request's record a few milliseconds before its outcome was saved and treat it as unsettled. Failure handling now waits (briefly, at most ten seconds) for the outcomes this attempt has already started recording before it decides whether the turn can be retried.
