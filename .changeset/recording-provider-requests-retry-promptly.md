---
"@opengeni/core": patch
"@opengeni/observability": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

A dictation or recording whose speech-to-text request hangs no longer sits in "Transcribing" until the connection ends and Temporal's 30-second retry comes round. A provider can now declare the request timing it documents (`requestTiming` on a speech-to-text provider): Azure Speech's fast transcription answers faster than real time and recommends retrying transient failures after 2, 4, 8, 16 and 32 seconds. A request unanswered after its audio's length, or one that fails with a transient error, is sent again on that schedule; a late request keeps running beside its retry and whichever answers first is used, and the others are stopped. Rate limits and permanent failures still end the request at once, and after the provider's recommended retries the activity's own retry takes over as before. Providers that declare nothing are sent once, as before.

Each failed provider request is now logged ("Transcription provider request failed") with the provider, which request it was, how long it ran, our error code and what the provider said: its HTTP status, error code, scrubbed message and request id (Azure's `apim-request-id`), or the transport's code and message when the connection dropped. The observability boundary admits `providerRequestId`, `providerErrorMessage` (scrubbed and bounded like a client error message) and `recordingPurpose` under their own grammars. "recording processed" and "recording transcript failed" now give their code as `reason` instead of `errorCode`, which the boundary read as an operational error and reduced to a bare `OperationError`.
