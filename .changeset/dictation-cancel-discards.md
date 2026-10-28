---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/desktop": minor
---

Cancel throws a dictation away. Cancel, Escape and the phone's cancel now delete the dictation under way, while it records or while it is being transcribed, so no composer offers it again. Before, speech longer than a few seconds was kept and the composer offered it later. A dictation an earlier page left only stops being retried when cancelled, and dictations that fail are still kept and offered as before.

The desktop app keeps a cancelled dictation's speech in Recent dictations, marked "Cancelled, not transcribed", to play or transcribe again there; the retry shortcut transcribes it and types it. `useVoiceInput` gives `onAudio` the cancelled copy with `cancelled: true`, the `cancelled` desktop dictation report carries its `audio`, and history entries have `cancelled: true` until they are transcribed again.

`useVoiceInput` has a new `setAside()` for interruptions other than the person's Cancel, such as live voice taking over or another chat opening: capture stops and the speech stays saved to insert later, as `cancel()` did before. The composer's cancel button reads "Discard dictation".
