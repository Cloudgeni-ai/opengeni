---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

A dictation is heard while it is still being spoken, so its text is ready moments after it stops whatever its length. From a dictation's second uploaded chunk the API starts a listener (`dictationListeningWorkflow`, through the optional `startDictationListening` workflow client method) with the model and options finalizing would choose. As audio arrives, the worker cuts it at the first pause of at least 300 ms after 6 seconds (or at the quietest moment by 30 seconds), never in the newest 600 ms, and has each finished piece heard at once, keeping what was heard beside the audio (`prepared/track-N.heard`). The final transcript keeps those pieces when their audio and question are exactly the same, waits briefly for one still being heard, and hears only the rest, so after stop only the last few seconds are left. Each piece cut while spoken is billed once as itself, whoever hears it. A dictation is now decoded once straight to 16 kHz PCM instead of being re-encoded and decoded again, and its heard pieces are deleted with its audio.
