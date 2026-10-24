---
"@opengeni/sdk": patch
---

The live transcript no longer reconnects over and over when the audio clock and the wall clock drift apart. The browser recorder now places live audio in the recording by its sample count, the same clock the recording uses, so continuous audio is no longer mistaken for a pause, which closed the provider session and opened a new one several times a second until the provider refused more. The live transcriber's backoff now resets only once a session has returned text or stayed up for 30 seconds, because a provider can start a session and refuse it straight away.
