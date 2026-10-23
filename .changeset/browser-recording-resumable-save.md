---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/core": patch
---

Saving a browser recording now works when the browser runs on a machine with a slow link to storage. Previously a save waited for the whole recording to upload inside one request; anything that took longer than a minute failed, and every retry started the upload from scratch.

The browser host now uploads the recording in the background. A save waits up to 45 seconds and then answers `202` with `retryAfterMs`. Repeating the save with the same `operationId` joins the upload that is already running. The SDK's `saveBrowserRecording` repeats the request until the save completes, or until its signal aborts.

Staged recording objects are scheduled for deletion on a durable deadline, so a save that is never repeated leaves nothing behind. Controllers that predate background uploads are still waited on in a single request.
