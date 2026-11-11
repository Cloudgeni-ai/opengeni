---
"@opengeni/react-native": patch
---

Android: starting or stopping a recording or a call can no longer crash the app with `RemoteServiceException: Context.startForegroundService() did not then call Service.startForeground()`. The recording and call services now start with `startService()` while the app is in the foreground, which leaves Android no `startForeground()` deadline to enforce, and use `startForegroundService()` only when Android refuses that from the background. A stop while such a start still owes `startForeground()` is deferred until the service has gone to the foreground, and the service stops itself then. A recording that fails to start at any step now releases the microphone, encoder, chunk file and service and rejects `start` with a recording error, `stop` always lets them go even when finishing the last chunk fails, and an unexpected error on the capture thread arrives as a `capture_failed` error instead of ending the app.
